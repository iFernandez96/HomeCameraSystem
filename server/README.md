# server

FastAPI on the Jetson. Handles control plane (REST), event stream (WebSocket), and Web Push delivery. The video plane is intentionally separate — see `deploy/mediamtx.yml`.

## Quick start

```bash
cd server
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env

# generate VAPID keys (one-time, before pushes work)
python -m app.scripts.gen_vapid

uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
```

Smoke test: `curl http://localhost:8000/api/status`.

## Endpoints

| Method | Path                          | Notes |
| ------ | ----------------------------- | ----- |
| GET    | `/api/status`                 | uptime, camera health, CPU temp, FPS |
| GET    | `/api/events?limit=100`       | recent detection history |
| WS     | `/api/events/ws`              | live event stream (JSON per message) |
| POST   | `/api/capture`                | take snapshot, returns `{ url }` |
| POST   | `/api/detection/toggle`       | flip detection on/off |
| POST   | `/api/system/reboot`          | **stubbed** — wire to systemctl before relying on it |
| GET    | `/api/push/vapid-public-key`  | URL-safe b64 public key |
| POST   | `/api/push/subscribe`         | body = browser PushSubscription JSON |
| POST   | `/api/push/unsubscribe`       | body = `{ "endpoint": "..." }` |
| POST   | `/api/push/test`              | sends a test notification to all subscriptions |

## Layout

```
app/
  main.py              FastAPI app, lifespan, /api/status, static mounts,
                       body-size + security-headers + gzip middlewares
  config.py            env-driven settings
  routes/
    control.py         capture, detection toggle, /api/detection/config,
                       reboot (stubbed)
    events.py          /api/events history + WebSocket
    push.py            VAPID key, subscribe, unsubscribe, test
    _internal.py       worker-only event + heartbeat ingest with type
                       coercion + Box semantic validation
  services/
    event_bus.py       in-memory pub/sub for detection events
                       (deque maxlen=200, per-sub asyncio.Queue maxsize=64)
    push_service.py    pywebpush wrapper, JSON-persisted subscription
                       registry under the `homecam-secrets` Docker volume
    camera.py          /api/capture: copy worker's `latest.jpg` to a
                       timestamped `snap_*.jpg` (capped at SNAP_MAX_KEEP)
    detection.py       on/off gate proxying `DetectionConfig.enabled`;
                       optional dev simulator gated by HOMECAM_SIMULATOR=1
    detection_config.py persisted detection knobs (threshold, cooldown,
                       enabled, schedule_off_*, classes); load-time
                       wrong-type defense via _safe_float
    health.py          worker liveness + metrics window (30 s expiry)
  scripts/
    gen_vapid.py       generate VAPID keypair, print public key
```

## Wiring (current state, end-to-end)

The video and detection paths are fully wired — none of these are stubs anymore:

- **Camera capture** — MediaMTX owns `nvarguscamerasrc` (the only libargus consumer; see CLAUDE.md sharp edges) and pushes H.264 to its own RTSP server on `:8554`. The detection worker reads back from RTSP via jetson-utils' `videoSource` (NVDEC). The server's `/api/capture` route relies on the worker also writing one frame per second to `latest.jpg`, which `camera_service` copies to a timestamped snapshot.
- **Detection** — host-side worker in `detection/detect.py` runs SSD-MobileNet-v2 via jetson-inference (TensorRT FP16). Posts events to `/api/_internal/event` (validated by Pydantic with semantic Box checks: `x+w ≤ 1`) and heartbeats every 10 s to `/api/_internal/heartbeat` (whitelisted metric fields, type-coerced, NaN/Inf rejected).
- **Push persistence** — `push_service` persists subscriptions to `secrets/push_subs.json` (atomic write, loaded with shape + length validation that mirrors the route's iter-98 caps). VAPID keys live alongside.
- **Detection config** — `detection_config_store` persists user-tunable knobs (threshold, cooldown, enabled, schedule, classes) to `secrets/detection_config.json`. Out-of-range numeric values clamp on load; wrong-type values fall back to defaults so a manually-edited file can't ground the boot.
- **Reboot** — still stubbed in `routes/control.py`. Wiring it requires a host-side helper because the server runs in a container; deferred behind that complexity.

## Serving the compiled client

If `CLIENT_DIST` (default `../client/dist`) exists, the server mounts it as the SPA root with a fallback to `index.html`. After `npm run build` in `../client`, hitting `http://jetson.local:8000/` serves the PWA. For production, put Caddy or Nginx in front of both FastAPI and MediaMTX so they share a hostname (required for service worker scope and for cookies if you add auth).

## Auth

There is **none** in this scaffold. Before exposing the server beyond LAN:

- Add a token check (FastAPI dependency on every router).
- Front with TLS via Caddy / Nginx — service workers refuse to register over plain HTTP except on `localhost`.
- Or wrap everything with [Tailscale](https://tailscale.com) and skip public exposure entirely.
