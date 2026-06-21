---
name: jetson-cross-deploy
description: >-
  Deploy workflow for the Jetson Nano 2GB camera server. Invoke this skill
  WHENEVER you are about to deploy, ship, push, or live-verify ANY tier (server
  image, client PWA, or detection worker) to the Jetson — or when the user says
  "deploy", "ship it", "push to the Nano/Jetson", or asks to test something on
  real hardware. It encodes the single most dangerous repeated operation on this
  project: NEVER `docker compose up --build` natively on the Nano (it recompiles
  cryptography/Pillow/argon2 from source under 2 GB/2-core OOM pressure → 30-45
  min swap-death that WEDGES the live server). Always cross-build ARM64 on the
  dev laptop. Also use this skill when the Jetson is unreachable (it is
  frequently powered OFF) so deploy/verify gets queued instead of blocking dev.
---

# Jetson cross-deploy workflow

The Jetson Nano 2GB is the server **and** the camera host. It is fanless, 2 GB
RAM, 2 cores, ARM64, and **frequently powered OFF**. Two hard rules govern every
deploy: **cross-build on the laptop, never on the Nano**, and **never block dev
on the Jetson being up**. This skill is the safe path.

## Rule 0 — is the Jetson even on?

Dev runs **Jetson-OFF** by default. All vitest / pytest / typecheck / lint /
build run locally. If a deploy or live-verify needs the device and it's off:
**say so explicitly, queue it, and keep coding** — do not wait. Preflight:

```bash
ssh -o ConnectTimeout=8 jetson true && echo UP || echo "OFF/unreachable — queue the deploy"
```

`ssh jetson` = LAN (key auth, NOPASSWD sudo). `ssh homecam` = Tailscale alias
(off-LAN). Tailscale URL: `https://homecam.tail4a6525.ts.net`.

## Rule 1 — NEVER native-build on the Nano

`docker compose up --build` on the Jetson recompiles cryptography / Pillow /
argon2 **from source** on a 2 GB/2-core box → 30-45 min + swap-death that wedges
the live server. The cross-build uses prebuilt aarch64 wheels → a few minutes on
the laptop, ~0 load on the Nano. This is non-negotiable.

## Deploy each tier

### Server (FastAPI in Docker) — cross-build ARM64 on the dev machine, ship the image
```bash
deploy/cross-deploy-server.sh
```
One-time host setup for QEMU (re-run if you see `exec format error`):
```bash
docker run --privileged --rm tonistiigi/binfmt --install arm64
```

### Client (Vite/React PWA) — build locally, rsync the dist
```bash
cd client && npm run build && \
  rsync -a --delete dist/ jetson:/home/israel/HomeCameraSystem/client/dist/
```
Fresh `dist` activates the service worker immediately (clientsClaim). After
deploy, the new PWA is live on next load.

### Detection worker (Python 3.6, on the host — not in the container)
```bash
rsync -a detection/ jetson:/home/israel/HomeCameraSystem/detection/ && \
  ssh jetson 'sudo systemctl restart homecam-detect'
```
Before shipping worker code, confirm 3.6 compatibility — see the
**py36-compat-guard** skill (`detection/tests/test_py36_compat.py` must be green).

## After deploy — live-verify the things tests can't

Unit tests can't see layout, real camera, real ffmpeg on the Nano, or WebRTC.
Verify on-device after a deploy that touches them:
- Camera/stream: `https://homecam.tail4a6525.ts.net` shows a live tile (WebRTC).
- Worker health: `ssh jetson 'sudo journalctl -u homecam-detect -n 50 --no-pager'` — look for `READY=1`, no restart loop, frames flowing.
- Services: `mediamtx`, `homecam-server`, `homecam-detect` all active.
- UI layout / bbox alignment / control-bar placement — eyeball it; jsdom can't.

## Need REAL data to confirm a change, but the Jetson is off?

Don't block. Pull a read-only snapshot **when it's next on**, analyze offline:
```bash
deploy/fetch-jetson-data.sh [host] [clip_count] [log_days]   # host: jetson | homecam
```
→ `./.jetson-snapshot/` (gitignored): events.db SQL dump, recent clips, journald,
config. Never pulls secrets. Gated real-data tests
(`server/tests/test_real_snapshot.py`) skip until the snapshot exists, then run.

## Anti-patterns (do not)

- `docker compose up --build` on the Nano (Rule 1).
- `PrivateTmp=yes` on the systemd units — breaks `nvarguscamerasrc` (libargus uses `/tmp/argus_socket`).
- Blocking dev waiting for the Jetson to power on — queue it, keep coding.
- Deploying worker code without the py36 scanner green.
