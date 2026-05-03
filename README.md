# Home Camera System

Self-hosted, Ring-style camera viewer + controller for an Nvidia Jetson Nano 2GB with an attached Raspberry Pi camera. The Jetson is the server. Phones and laptops are clients running the same installable PWA — open it in a browser, "Add to Home Screen" on Android, and you have an app icon that launches into a fullscreen, app-feeling camera dashboard.

## Features

- Live WebRTC video from the Jetson (~200ms glass-to-glass on LAN)
- Event timeline of person/motion detections with thumbnails
- Push notifications to phone when something is detected
- Remote control of the Jetson: capture photo, reboot, toggle detection, view stats
- One codebase, two surfaces: Android home screen + any browser
- No app stores, no cloud. You own the box, you own the data.

## Architecture

```
RPi Camera ─► GStreamer ─► MediaMTX ──WebRTC──► Client <video>
                  │
                  └─► Detection ─► event ─► FastAPI ─WS/Push─► Client / Phone
Client ──REST──► FastAPI ─► control commands
```

Three processes on the Jetson:

1. **MediaMTX** — video gateway. Owns the camera (`nvarguscamerasrc` + NVENC), serves RTSP for the detection worker and WebRTC for browsers.
2. **FastAPI server** (`server/`) — control + events + Web Push, in a Docker container.
3. **Detection worker** (`detection/`) — SSD-MobileNet-v2 via jetson-inference (TensorRT FP16) on the Jetson host, decodes the RTSP feed via NVDEC, POSTs detection events to the FastAPI server.

One static bundle on the client side (`client/dist/`), bind-mounted into the FastAPI container and served as the SPA root with a path-traversal-guarded fallback.

## Quick start

### Client

```bash
cd client
npm install
npm run dev
```

Opens at http://localhost:5173. By default the dev server proxies `/api` to `http://localhost:8000`. Adjust in `client/vite.config.ts` if the server runs elsewhere (e.g. directly on the Jetson at `http://jetson.local:8000`).

### Server

```bash
cd server
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
python -m app.scripts.gen_vapid     # writes vapid_private.pem + vapid_public.pem, prints public key
uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
```

Open http://localhost:8000/api/status to verify it's up.

### MediaMTX

Download the matching arm64 release for the Jetson: https://github.com/bluenviron/mediamtx/releases

```bash
./mediamtx deploy/mediamtx.yml
```

## Repo layout

```
client/             Vite + React + TS PWA
  src/
    pages/          Live, Events, Settings
    components/     VideoTile, EventList, LiveStats, BottomNav,
                    SnapshotPreview, ConnectionBanner, ErrorBoundary,
                    Skeleton, Slider
    lib/            api, ws, webrtc, push, useStatus, format,
                    types, toast, confirm
server/             FastAPI in a Docker container
  app/
    main.py         lifespan + middlewares (body-cap, security-
                    headers, gzip), /api/status, SPA fallback
    routes/         control, events, push, _internal
    services/       camera, detection, detection_config, event_bus,
                    health, push_service
    scripts/        gen_vapid
detection/          Host-side worker (Python 3.6, JetPack 4.x)
  detect.py         main inference loop
  box_norm.py       pixel-clamp-then-divide bbox normalizer
  metrics.py        live perf snapshot for heartbeats
  memory_guard.py   hysteretic low-MemAvailable gate
  thermal_guard.py  hysteretic GPU-temp gate
  schedule.py       overnight-window logic
  mediamtx_watchdog.py  restart MediaMTX on capture-failure burst
  face_recog/       per-person identification (dlib-backed)
deploy/
  Dockerfile.server
  docker-compose.yml
  mediamtx.yml      RPi camera → NVENC → RTSP + WebRTC
  install-jetson.sh idempotent installer
  systemd/          mediamtx, homecam-server, homecam-detect,
                    homecam-jetson-perf
CLAUDE.md           Architectural notes — read first when editing
```

## Status

Working end-to-end on the Jetson Nano 2GB. Live video (WebRTC, ~200 ms LAN), detection events (SSD-MobileNet-v2 at FP16 with idle-gear thermal management), per-person face recognition (when `encodings.pkl` is present and dlib is unblocked), Web Push with VAPID, persisted detection config, and a Settings page surfacing per-component health (CPU/GPU temp, dropped frames, p95 inference latency, mediamtx-watchdog restart count, etc).

The notable stub is `/api/system/reboot`; wiring it requires a host-side helper because the FastAPI server runs in a container and can't `systemctl reboot` itself.

## Security

This deployment assumes LAN-only. There is **no auth on `/api/*`**: a single-user trust model is documented in CLAUDE.md and on the [server/README.md](server/README.md#auth) page. Defenses already in place:

- 1 MB request-body cap (FastAPI middleware)
- `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy: same-origin` on every response
- SPA path-traversal guard
- Pydantic `extra='forbid'` + length / range bounds on every accepted payload (event, push subscribe / unsubscribe, detection config). The worker heartbeat path is bounded by an explicit whitelist + per-field type coercion (numeric NaN/Inf rejection, string length caps, `face_recog_names` list-and-element bounds) — same defense, different mechanism because the body is optional and shape-tolerant.
- gzip middleware (≥1 KB responses) — browsers benefit, the worker's stdlib `urllib.request` does not send `Accept-Encoding` so the worker → server hot path stays uncompressed

Before exposing this beyond the LAN you still need:

- TLS (Caddy or Nginx in front of FastAPI + MediaMTX)
- Token / OIDC auth on `/api/*`
- Network isolation (a separate VLAN for IoT is wise)

Recommended remote-access path: install [Tailscale](https://tailscale.com) on the Jetson and your phone. Free, encrypted, and the Jetson stays off the public internet.
