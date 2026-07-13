# Home Camera System

Self-hosted, Ring-style camera viewer + controller for an Nvidia Jetson Nano 2GB with an attached Raspberry Pi camera. The Jetson is the server. Phones and laptops are clients running the same installable PWA — open it in a browser, "Add to Home Screen" on Android, and you have an app icon that launches into a fullscreen, app-feeling camera dashboard.

## Features

- Live WebRTC video from the Jetson (~200ms glass-to-glass on LAN)
- Event timeline plus a short-retention continuous-playback archive and bounded range export
- Home, Away, Night, and Privacy operating modes with mode-aware alerts
- One notification per visit, followed by a quiet clip-ready update
- Daily activity digests, unknown-person review, and tamper alerts
- Recording-time privacy masks that also protect live video and snapshots
- Line-crossing and loitering rules, plus experimental porch-object delivery/collection tracking
- Local metadata search, multi-camera visit stories, and incident evidence bundles
- Face-quality filtering, identity correction/merge tools, and per-person alert preferences
- Owner-configured push, webhook, and MQTT automations with masked credentials
- Protected clips, storage-runway forecasting, and expiring revocable share links
- Fail-closed software paths for optional audio, doorbell, and sound-event hardware; unavailable until separately provisioned and proven
- Guarded deterrence adapter infrastructure; physical actions are unavailable until a compatible device is separately provisioned and proven
- Recovery-derived outage history with an explicit external-monitor limitation
- Push notifications to phone when something is detected
- Remote control of the Jetson: capture photo, reboot, toggle detection, view stats
- One codebase, two surfaces: Android home screen + any browser
- No app stores, no cloud. You own the box, you own the data.

## Architecture

```
RPi Camera ─► GStreamer ─► MediaMTX ──WebRTC────────► Client <video>
                  │             ├─fMP4 archive──────► FastAPI timeline
                  │             └─RTSP audio (opt.)─► acoustic watcher
                  └─► Detection ─► event ─► FastAPI ─WS/Push─► Client / Phone
Client ──REST──► FastAPI ─► control commands
```

Three processes on the Jetson:

1. **MediaMTX** — video gateway. Owns the camera (`nvarguscamerasrc` + NVENC), serves RTSP for the detection worker and WebRTC for browsers.
2. **FastAPI server** (`server/`) — control + events + Web Push, in a Docker container.
3. **Detection worker** (`detection/`) — SSD-MobileNet-v2 via jetson-inference (TensorRT FP16) on the Jetson host, decodes the RTSP feed via NVDEC, evaluates optional spatial rules, and POSTs detection events to the FastAPI server. A separate disabled-by-default watcher handles optional audio metadata so microphone failures cannot destabilize vision.

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

### Optional audio and doorbell hardware

The audio/doorbell paths stay disabled until hardware is configured. On the
Jetson, set `HOMECAM_MIC_DEVICE` (for example `hw:2,0`) before running
`deploy/run-camera-microphone.sh`; `HOMECAM_MIC_BITRATE` defaults to `32000`.
Speaker output is deliberately fail-closed: copy `deploy/mediamtx.env.example`
to `/etc/homecam/mediamtx.env`, set an explicit `HOMECAM_SPEAKER_DEVICE`, and
create the configured root-owned enable-marker file. Without both, the
`deploy/run-talk-speaker.sh` hook exits without opening audio hardware.
`HOMECAM_SPEAKER_VOLUME` defaults to `1.0`. For a physical button, point the
detection worker at its GPIO value file with
`DETECT_DOORBELL_GPIO_VALUE_PATH`; `DETECT_DOORBELL_ACTIVE_LOW=1` is the
default. These are host-process variables, not FastAPI container settings.

Browser video, talk, and listen sessions use exact-path, one-time FastAPI media
grants that expire after 60 seconds and travel only in `Authorization` headers.
MediaMTX's HTTP callback requires a grant for every remote WebRTC video read,
remote `talk` publication, or remote `listen` read while preserving host-only
RTSP publishers/readers. Audio grant issuance and consumption both fail while
audio is disabled or Privacy is active; masked live video remains available.

Secure clip-share links are time-limited bearer URLs. The server stores only a
hash, marks both link creation and clip delivery `private, no-store`, suppresses
token-bearing Uvicorn access lines, and supports owner revocation by share ID.

`deploy/systemd/homecam-audio-detect.service` is installed as an available unit
but is intentionally not enabled or started. Its local signal heuristics are a
conservative convenience feature, not a certified smoke alarm, glass-break
detector, or life-safety device. It stores and transmits event metadata only;
raw microphone audio is discarded rather than recorded by the watcher.

### Continuous playback storage

MediaMTX stream-copies the already encoded `cam` path into five-minute fMP4
segments under `recordings/continuous/` and deletes them after two hours. At
the default 2.5 Mbps bitrate the nominal two-hour window is roughly 2.3 GB.
MediaMTX v1.18's asynchronous cleaner can temporarily retain close to three
hours (about 3.4 GB), without another decoder, encoder, or CUDA context. The
authenticated FastAPI timeline indexes and serves those files; MediaMTX's
unauthenticated playback server remains disabled.
Configured masks are applied before encoding, and Privacy mode forces a
full-frame mask, so the continuous archive receives the same redacted pixels
as Live, snapshots, and event clips. Full-frame Privacy generates black NV12
streams without opening the physical camera; partial zones use the GPU
compositor before both hardware encoders.

Timeline MP4s and incident ZIPs share a private export workspace. Defaults allow
two outstanding timeline jobs, cap retained files plus conservative pending
reservations at 5 GiB, and preserve at least 4 GiB of free disk. Capacity is
rechecked before a completed temporary is published; rejected requests return a
safe actionable error rather than filling storage.

The built-in outage view can persist failures it observes and send a recovery
summary when service returns. It cannot notify while the Jetson itself has no
power or network; true immediate offline alerts require an independently
powered monitor or UPS integration.

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
docs/production-readiness-roadmap.md
                    Canonical launch blockers, gates, owners, and evidence
CLAUDE.md           Architectural notes — read first when editing
```

Production-readiness work is tracked in
[`docs/production-readiness-roadmap.md`](docs/production-readiness-roadmap.md).
The roadmap records scope and evidence; it does not authorize implementation or
deployment of its items.

## Initial production launch scope

HomeCameraSystem remains an operator-grade beta until every launch gate in the
production-readiness roadmap passes. The intended initial release is deliberately
narrow:

| Classification | Initial-launch treatment |
|---|---|
| Launch candidate | One household and one Jetson/camera; authenticated browser/Android access through an operator-controlled Tailscale tailnet and HTTPS; live view; upstream Privacy masking; visual detection, events, clips, bounded playback/export, and established operator controls. Each capability still depends on its remaining roadmap verification gate. |
| Beta | Named-face recognition remains unproven against fresh live named-person parity. The package-area rule is an experimental calibrated scene-change heuristic, not semantic parcel recognition. |
| Unavailable | In-app OTA installation; bundled or unproven microphone, speaker, doorbell, sound-classifier, light, siren, and GPIO hardware; cloud relay; direct Internet exposure; high availability; and immediate offline reporting without an independently powered observer. |
| Deployment model | The operator installs versioned, laptop-built artifacts. OTA remains disabled. Release signing is a later roadmap gate and is not claimed yet. |

Training-photo capture, sorting, consent, and export can prepare future named-face
recognition, but they do not prove that a name will match on a later live visit.

## Status

Operator-grade beta running end-to-end on the Jetson Nano 2GB. Proven runtime
paths include live video, Privacy masking, visual detection events, persisted
configuration, and component health reporting. This is not yet a
production-ready release. Named-face recognition remains beta pending fresh
named-person parity evidence, and optional hardware plus OTA remain unavailable
under the launch classifications above.

Privileged camera recovery and reboot commands are handed to the host-side worker instead of granting the FastAPI container host control.

## Security

The application uses cookie-based accounts and role checks for its protected API. Internal worker endpoints remain LAN-scoped, and an expiring share URL is an intentionally public bearer capability. Defenses include:

- 1 MB request-body cap (FastAPI middleware)
- `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy: same-origin` on every response
- SPA path-traversal guard
- Pydantic `extra='forbid'` + length / range bounds on every accepted payload (event, push subscribe / unsubscribe, detection config). The worker heartbeat path is bounded by an explicit whitelist + per-field type coercion (numeric NaN/Inf rejection, string length caps, `face_recog_names` list-and-element bounds) — same defense, different mechanism because the body is optional and shape-tolerant.
- gzip middleware (≥1 KB responses) — browsers benefit, the worker's stdlib `urllib.request` does not send `Accept-Encoding` so the worker → server hot path stays uncompressed

Before exposing this beyond the LAN you still need:

- TLS (Caddy or Nginx in front of FastAPI + MediaMTX)
- Network isolation (a separate VLAN for IoT is wise)

Recommended remote-access path: install [Tailscale](https://tailscale.com) on the Jetson and your phone. Free, encrypted, and the Jetson stays off the public internet.
