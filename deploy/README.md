# Deploy on the Jetson Nano 2GB

Four processes run on the Jetson:

| Process            | Where                | Port                                 | Role |
| ------------------ | -------------------- | ------------------------------------ | ---- |
| MediaMTX           | host                 | 8554 (RTSP, internal), 8889 (WebRTC) | Camera ingest + WebRTC egress |
| GStreamer pipeline | spawned by MediaMTX  | n/a                                  | RPi camera → `nvarguscamerasrc` → `nvv4l2h264enc` (NVENC) → `rtspclientsink` |
| FastAPI server     | Docker container     | 8000                                 | Control + events + push, serves the PWA |
| Detection worker   | host                 | n/a                                  | jetson-utils `videoSource` reads MediaMTX RTSP via NVDEC, jetson-inference detects, POSTs events to FastAPI |

The server lives in a container because JetPack 4.x ships only Python 3.6 — FastAPI / Pydantic v2 need 3.8+. Detection lives on the host because jetson-inference depends on the host's CUDA/TensorRT/libargus stack.

## Quick install

The repository ships an idempotent installer:

```bash
# From your dev machine, sync the repo (skip junk):
rsync -az --delete --exclude=node_modules --exclude=.venv --exclude=__pycache__ \
    /path/to/HomeCameraSystem/ jetson:/home/israel/HomeCameraSystem/

# On the Jetson:
ssh jetson 'bash ~/HomeCameraSystem/deploy/install-jetson.sh'
```

The installer:

1. Installs `gstreamer1.0-rtsp` (needed for `rtspclientsink`).
2. Adds the current user to the `docker` group, ensures the daemon is running.
3. Installs the Docker Compose v2 plugin to `~/.docker/cli-plugins/`.
4. Downloads MediaMTX (current pin: `v1.18.0` arm64).
5. Installs systemd units for `mediamtx`, `homecam-server`, `homecam-detect`, and `homecam-jetson-perf` (selects the MAXN power envelope at boot while retaining dynamic CPU/GPU clocks; the camera encoder has its own low-latency max-performance setting).
6. Builds the server container image.
7. Enables + starts all three services.
8. Smoke tests `/api/status` and `:8889`.

## Prerequisites

- JetPack **4.6.x** (Nano 2GB EOL'd here — JetPack 5+ does not support this board).
- The RPi camera v2 (IMX219) enabled. Verify with `nvgstcapture-1.0 --prev-res=3`.
- Python 3.6 on the host (default). The detection worker uses the system Python.
- jetson-inference. Already present on JetPack 4.6's pre-built images at `/usr/local/bin/detectnet` and Python at `/usr/local/lib/python3.6/dist-packages/jetson_inference`.
- Docker (already present on JetPack 4.6 images; the installer just enables it).

## Manual install (if `install-jetson.sh` doesn't fit)

```bash
# 1. apt deps
sudo apt-get update
sudo apt-get install -y --no-install-recommends gstreamer1.0-rtsp curl

# 2. Docker access (relogin or `newgrp docker` after this)
sudo usermod -aG docker "$USER"
sudo systemctl enable --now docker

# 3. Docker Compose v2 plugin
mkdir -p ~/.docker/cli-plugins
curl -fsSL "https://github.com/docker/compose/releases/latest/download/docker-compose-linux-aarch64" \
    -o ~/.docker/cli-plugins/docker-compose
chmod +x ~/.docker/cli-plugins/docker-compose

# 4. MediaMTX (note: `linux_arm64`, NOT `linux_arm64v8` — the v8 suffix was dropped)
cd ~/HomeCameraSystem
curl -fsSL https://github.com/bluenviron/mediamtx/releases/download/v1.18.0/mediamtx_v1.18.0_linux_arm64.tar.gz \
    | tar -xz mediamtx

# 5. systemd
sudo cp deploy/systemd/{mediamtx,homecam-server,homecam-detect,homecam-jetson-perf}.service /etc/systemd/system/
sudo systemctl daemon-reload

# 6. Build + start
cd ~/HomeCameraSystem
docker compose -f deploy/docker-compose.yml build
sudo systemctl enable --now mediamtx homecam-server homecam-detect homecam-jetson-perf
```

Verify:

```bash
curl http://localhost:8000/api/status
ss -ltn | grep -E '8000|8554|8889'
journalctl -u mediamtx -u homecam-detect -f
```

Open `http://jetson.local:8000` (or the Jetson's LAN IP) from a phone or laptop on the same LAN. Add to home screen on Android.

### Repeatable phone verification

With one Android device connected over ADB, run `scripts/verify-phone.sh` from
the repository root. If multiple devices are listed, set
`HOMECAM_ADB_SERIAL=<serial>`. The check launches the wrapper, verifies it stays
foreground without an Android crash, and saves a screenshot, UI hierarchy, and
bounded logcat evidence under `/tmp/homecam-phone-smoke`.

Debug APKs expose their embedded WebView to `chrome://inspect` over ADB for
interactive JavaScript, network, and performance debugging. Release APKs do not.

## First-run quirk: TRT engine compile

The first time `homecam-detect.service` starts, jetson-inference compiles a TensorRT engine for SSD-MobileNet-v2. This runs CPU/GPU hot for **5–15 minutes** on a Nano 2GB. The compiled engine is cached at `/usr/local/bin/networks/SSD-Mobilenet-v2/*.engine`; every subsequent restart loads in under 2 s.

While the engine is compiling, the worker's logs say `[TRT] Tactic: ...` repeatedly. Don't kill it — that wipes the partial compile and you'll start over. Watch progress with `journalctl -u homecam-detect -f`.

## TLS — required for Web Push on phones

Service workers (and therefore Web Push) only register on `https://` or `localhost`. On a phone, you'll be hitting `http://10.0.0.9:8000` — the SW won't install and push won't work. Two practical options:

### Option A — Tailscale (recommended)

```bash
# On the Jetson:
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
sudo tailscale cert jetson.<your-tailnet>.ts.net
```

Front the services with Caddy using the issued cert, or pass `--ssl-keyfile/--ssl-certfile` to uvicorn and configure MediaMTX `webrtcEncryption: yes` with the same cert. Install Tailscale on your phone; the Jetson is reachable at `https://jetson.<tailnet>.ts.net` from anywhere with proper TLS.

### Option B — Caddy + LAN domain

Run Caddy in front of FastAPI (port 8000) and MediaMTX (port 8889). Either:

- A real public domain pointed at your home (with port forwarding) — Caddy auto-issues from Let's Encrypt.
- A LAN-only `.local` cert via mkcert installed in your phone's trust store.

## Reboot wiring

`/api/system/reboot` is stubbed. To enable it:

```bash
echo 'israel ALL=(ALL) NOPASSWD: /sbin/reboot, /bin/systemctl reboot' | sudo tee /etc/sudoers.d/homecam
sudo chmod 0440 /etc/sudoers.d/homecam
```

Then in `server/app/routes/control.py`:

```python
import subprocess
@router.post("/system/reboot")
async def system_reboot():
    subprocess.Popen(['sudo', 'systemctl', 'reboot'])
    return {"ok": True}
```

## Tuning

- **MediaMTX encoder** (`deploy/mediamtx.yml`): bitrate, GOP, framerate. Inline comments explain what each knob does.
- **Detection** (`detection/README.md`): threshold, cooldown, model. All env-driven; edit `homecam-detect.service` to change.
- **WebRTC** (`client/src/lib/webrtc.ts`): no STUN, no audio transceiver — both intentional for LAN.

## Observability stack (opt-in, iter-199)

A pre-provisioned Prometheus + Grafana setup ships in `deploy/`. The `homecam-server` container exposes `/metrics` (iter-189) at root — same exposure tier as `/healthz`, ungated by design. The opt-in compose extension scrapes it every 15 s and renders two dashboards.

```bash
# Bring up the observability stack alongside the camera stack:
docker compose -f deploy/docker-compose.yml \
               -f deploy/docker-compose.grafana.yml up -d

# Open Grafana (anonymous Viewer access by default):
#   http://<jetson>:3000
#
# Two dashboards are auto-loaded:
#   • Home Camera — Overview        (worker alive / detection active /
#                                    thermal / memory / disk / FPS)
#   • Home Camera — Detection worker (FPS / inference latency / dropped
#                                    rate / mediamtx restarts / thumb_ms)
#
# Tear down (camera stack stays up):
docker compose -f deploy/docker-compose.grafana.yml down
```

**RAM cost on the Nano 2GB:** ~30 MB Prometheus + ~50 MB Grafana ≈ 4% of the 2 GB total. The mediamtx + detection worker + server already eat 1.4-1.7 GB; observability is a small additional load. Run only if you want the dashboards — the rest of the stack has zero functional dependency on these two containers.

**Auth:** Grafana ships in anonymous-Viewer mode. To require login (and lock down dashboard editing), edit `deploy/docker-compose.grafana.yml`:

```yaml
environment:
  - GF_AUTH_ANONYMOUS_ENABLED=false
  - GF_SECURITY_ADMIN_PASSWORD=<strong-password-here>
```

Then `docker compose ... up -d --force-recreate grafana`.

## Troubleshooting

- **No video** — `journalctl -u mediamtx -f`. If you see `Connecting to nvargus-daemon failed` the systemd unit has `PrivateTmp=yes`; remove it. If you see `no element "rtspclientsink"`, install `gstreamer1.0-rtsp`.
- **Detection never fires** — `journalctl -u homecam-detect -f`. If the import fails with `libgomp.so.1: cannot allocate memory in static TLS block`, `cv2` is being imported after `jetson_inference` somewhere; verify `detection/detect.py` hasn't been reordered.
- **WebRTC "checking" forever** — the browser may not be reaching ICE candidates on the LAN. Add `webrtcAdditionalHosts: ['<jetson-lan-ip>']` to `mediamtx.yml`.
- **Push not working on Android** — confirm you're on HTTPS, the service worker registered (DevTools → Application → Service Workers), and Chrome notification permission was granted. A test push from `Settings → Send` should arrive within seconds.
- **Server container won't start** — `docker compose -f deploy/docker-compose.yml logs server`. Most often a missing or 0-byte VAPID key file in the named volume; remove the volume and let the entrypoint regenerate.
