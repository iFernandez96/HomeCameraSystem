# Deploy on the Jetson Nano 2GB

Four processes run on the Jetson:

| Process            | Where                | Port                                 | Role |
| ------------------ | -------------------- | ------------------------------------ | ---- |
| MediaMTX           | host                 | 127.0.0.1:8554 (RTSP), 127.0.0.1:8889 (WHEP); 8189 (ICE media) | Camera ingest + WebRTC egress |
| GStreamer pipeline | spawned by MediaMTX  | n/a                                  | RPi camera → `nvarguscamerasrc` → `nvv4l2h264enc` (NVENC) → `rtspclientsink` |
| FastAPI server     | Docker container     | 127.0.0.1:8000                       | Control + events + push, serves the PWA through HTTPS |
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
5. Installs systemd units for `mediamtx`, `homecam-server`, the bounded `homecam-server-supervisor`, `homecam-detect`, `homecam-backup.timer`, and `homecam-jetson-perf` (selects the MAXN power envelope at boot while retaining dynamic CPU/GPU clocks; the camera encoder has its own low-latency max-performance setting).
6. Idempotently provisions the shared worker credential at `/etc/homecam/worker-auth.secret` without displaying it.
7. Requires the off-Jetson-generated backup recipient public key at `/etc/homecam/backup-recipient.pem`; only the public half is allowed on the Jetson.
8. Requires the prebuilt ARM64 server image.
9. Enables + starts the services and smoke-tests `/api/status` and `:8889`.

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
sudo cp deploy/systemd/{mediamtx,homecam-server,homecam-server-supervisor,homecam-detect,homecam-jetson-perf}.service /etc/systemd/system/
sudo cp deploy/systemd/homecam-backup.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload

# 5.5. Provision the shared worker credential before starting either side.
bash deploy/provision-worker-secret.sh

# 5.6. Provision only the off-Jetson-generated backup public key.
# See deploy/RECOVERY_DRILLS.md; never copy the recovery private key here.
sudo test -f /etc/homecam/backup-recipient.pem

# 6. Cross-build + ship the server image from the development machine
# (run this outside the Jetson shell)
deploy/cross-deploy-server.sh jetson

# Back on the Jetson, start services without any native image build
cd ~/HomeCameraSystem
sudo systemctl enable --now mediamtx homecam-server homecam-server-supervisor homecam-detect homecam-backup.timer homecam-jetson-perf
```

## Server supervision

`homecam-server-supervisor.service` is the single ongoing recovery owner for
the FastAPI container. It checks the host-local `/healthz` every 10 seconds,
requires three consecutive failures, and recreates only the Compose `server`
service. The camera publisher, MediaMTX, detection worker, and Argus recovery
ladder are outside its command surface.

The restart budget is persisted privately at
`/srv/homecam-media/recordings/.server-supervisor-state.json`. Three recovery actions in
ten minutes exhaust the budget; another debounced failure latches the unit with
exit 78 and emits `alert=structural_loop action=stop` to journald. Docker's own
restart policy is disabled so it cannot bypass this circuit breaker. PR-206 is
implemented by the separate Prometheus/Alertmanager extension below: server
recovery state is exported as numeric metrics, and the receiver delivers the
alert through registered Web Push subscriptions without depending on the
FastAPI process.

Inspect the separate server-recovery reason and action without camera logs:

```bash
systemctl status homecam-server-supervisor
journalctl -u homecam-server-supervisor --since today
sudo cat /srv/homecam-media/recordings/.server-supervisor-state.json
```

After correcting a structural failure, explicitly clear the latch and restart
the supervisor. This resets only server-supervision state:

```bash
sudo -u israel python3 deploy/server_supervisor.py --reset-latch
sudo systemctl reset-failed homecam-server-supervisor
sudo systemctl start homecam-server-supervisor
```

The guarded acceptance drill kills the server container, waits at most two
minutes for recovery, and proves that the MediaMTX and detection PIDs plus the
RTSP publisher remained available:

```bash
HOMECAM_DRILL_CONFIRM=YES bash deploy/recovery-drill.sh --execute server
```

## Encrypted backups

The server publishes mode-0600 `.hcbk` artifacts to
`/srv/homecam-media/backups`; no plaintext manifest sidecar is retained. The
daily persistent timer creates local encrypted recovery points and records age
plus `replication_status=deferred_off_device`. The default retention is the 14
newest local backups and can be changed with `BACKUP_RETENTION_COUNT`. It does not provide genuine
off-device replication or satisfy the deferred 24-hour off-device RPO.

Generate and retain the recovery private key off the Jetson, provision only its
public half before Compose startup, and run a clean-scratch restore drill using
[`RECOVERY_DRILLS.md`](RECOVERY_DRILLS.md). Normal production Compose never
mounts the private key, so an in-place restore correctly fails closed until an
operator deliberately supplies recovery material for a bounded recovery
session.

## Worker credential cutover and rotation

The host detection worker and FastAPI container read the same 32-byte random
credential from `/etc/homecam/worker-auth.secret`. Only the file path appears in
systemd and Compose configuration. The directory is `root:israel` `0750`, the
file is `root:israel` `0640`, and the container receives a read-only bind mount
at `/run/secrets/homecam-worker-auth`.

Provisioning is idempotent and never prints the credential:

```bash
bash deploy/provision-worker-secret.sh
```

Rotation is a deliberate maintenance cutover because there is no dual-secret
window. Stop both host workers, rotate, recreate the server so it loads the new
file, then start the workers:

```bash
sudo systemctl stop homecam-detect homecam-audio-detect 2>/dev/null || true
bash deploy/provision-worker-secret.sh --rotate
sudo systemctl restart homecam-server
sudo systemctl start homecam-detect
# Start homecam-audio-detect only if it was intentionally enabled before.
```

Verify without printing file contents:

```bash
sudo stat -c 'owner=%U group=%G mode=%a bytes=%s' /etc/homecam/worker-auth.secret
sudo systemctl is-active homecam-server homecam-detect
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8000/api/_internal/detection/config
```

The unauthenticated curl must return `401`; a missing/malformed server secret
returns `503` only on worker routes. If cutover fails, stop the workers, restore
the previously backed-up secret with the same owner/mode, restart the server,
and then restart the workers. Do not copy credential bytes into tickets, logs,
shell history, or verification artifacts.

MediaMTX delegates every path action to the FastAPI callback on localhost. The
container must therefore receive the observed host bridge source in
`MEDIAMTX_AUTH_TRUSTED_CALLERS` (the committed Compose default is the Jetson's
fixed HomeCam network gateway `172.30.0.1`, not a subnet). If Docker networking changes, inspect the
actual callback peer and update the single address; do not broaden it to a CIDR.

Optional speaker output stays inert after installation. Provision it only when
hardware exists:

```bash
sudo install -d -m 0755 /etc/homecam
sudo install -m 0600 deploy/mediamtx.env.example /etc/homecam/mediamtx.env
# Edit HOMECAM_SPEAKER_DEVICE, then deliberately arm output:
sudo install -m 0600 /dev/null /etc/homecam/speaker-enabled
sudo systemctl restart mediamtx
```

Verify:

```bash
curl http://localhost:8000/api/status
ss -ltn | grep -E '8000|8554|8889'
journalctl -u mediamtx -u homecam-detect -f
```

Open the operator Tailscale HTTPS URL from a phone or laptop. Direct LAN and
tailnet access to ports 8000, 8554, and 8889 is intentionally unavailable; the
HTTPS proxy is the supported application and WHEP signaling boundary.

### PR-001 tailnet containment

The loopback bindings above are mandatory host-side enforcement. In the
centrally managed Tailscale policy, grant trusted operators access to the
Jetson's HTTPS service on TCP 443 only. Do not add broad grants to TCP 8000,
8554, 8889, 3000, or 9090. The tailnet policy lives in the Tailscale admin
plane, not this repository, so record its review separately without copying
identity details or policy contents into version control.

From a separate LAN/tailnet client, verify the direct ports are denied while
HTTPS health remains reachable:

```bash
HOMECAM_LAN_HOST=<jetson-lan-host> \
HOMECAM_TAILSCALE_HOST=<jetson-tailnet-host> \
HOMECAM_HTTPS_URL=https://<operator-app-host> \
  bash deploy/verify-pr001-containment.sh
```

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

## Tailscale HTTPS — required production transport

The Android wrapper and production PWA intentionally have no LAN HTTP
fallback. Tailscale Serve is the only supported remote application and media
signaling boundary; it terminates HTTPS on 443 and forwards to the loopback-only
FastAPI and MediaMTX listeners:

```bash
# On the Jetson after `tailscale up`:
sudo tailscale serve --bg --https=443 http://127.0.0.1:8000
sudo tailscale serve --bg --https=443 --set-path=/whep http://127.0.0.1:8889
sudo tailscale serve status
```

Install and connect Tailscale on the phone before opening HomeCam. Keep the
tailnet policy restricted to HTTPS TCP 443 as described above. Ports 8000,
8554, and 8889 remain loopback-only; TCP/UDP 8189 is the intentional WebRTC ICE
media listener and is not an alternate HTTP signaling path. Local browser
development continues through Vite's localhost `/api` and `/whep` proxies.

### Canonical client address behind Serve

Tailscale Serve adds the original client address in `X-Forwarded-For` before
proxying to the loopback FastAPI listener. Docker then presents that host-local
connection to the server container through the fixed `172.30.0.1` HomeCam
gateway. Compose pins Uvicorn's `FORWARDED_ALLOW_IPS` to
`127.0.0.1,::1,172.30.0.1`, so only those immediate proxy hops may replace the
ASGI client/scheme. Do not broaden the value to `*`, `172.30.0.0/24`, or a
tailnet range.

FastAPI routes use only `request.client.host`; they never parse forwarding
headers. A non-allowlisted peer that sends its own `X-Forwarded-For` therefore
retains its real socket address. MediaMTX runs directly on the host, so its
`webrtcTrustedProxies` remains loopback-only. The full contract and backoff
semantics are recorded in
[`docs/decisions/pr-104-trusted-client-address.md`](../docs/decisions/pr-104-trusted-client-address.md).

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
- **WebRTC video** (`client/src/lib/webrtc.ts`): receive-only video with STUN/TURN fallback.
- **WebRTC audio** (`client/src/lib/twoWayAudio.ts`): separate WHIP talk and WHEP listen sessions using one-time FastAPI media grants.

## Observability and off-box alerting stack

A pre-provisioned Prometheus + Alertmanager + Grafana setup ships in `deploy/`.
The independent `homecam-alert-receiver` process reloads the existing VAPID
keys and registered Web Push destinations from the shared secrets volume on
every delivery attempt. It mounts that volume read-only and is not exposed on
a host port. A failed/no-recipient delivery returns 503 so Alertmanager retries;
resolved alerts are sent through the same path.

The
`homecam-server` container exposes `/metrics` at root, but PR-105 source-gates
it to loopback and the fixed `172.30.0.0/24` HomeCam Compose network. Remote
LAN/tailnet requests receive the same 404 as an unknown route; `/healthz`
remains the intentionally public liveness probe. The opt-in Compose extension
scrapes metrics internally every 15 s, evaluates operational alert rules, and
renders two dashboards. It covers backup age/outcomes, recording-storage and
root-disk probes, local/external WHEP health, update/restore outcomes, and
server supervision. Physical mount identity and fallback-write prevention
remain PR-207 appliance work; this PR alerts when the existing recording probe
goes unavailable.

```bash
# Bring up the observability stack alongside the camera stack:
docker compose -f deploy/docker-compose.yml \
               -f deploy/docker-compose.grafana.yml up -d

# Grafana and Alertmanager are loopback-only. Grafana requires its own login.
# Alertmanager's loopback port exists only for the confirmed delivery drill;
# do not forward or expose it remotely.
# If Grafana is enabled, reach
# it with an authenticated operator tunnel such as an SSH local forward:
#   ssh -L 3000:127.0.0.1:3000 jetson
# Then open http://127.0.0.1:3000.
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

The extension adds four bounded processes (Prometheus, Alertmanager, the
receiver, and Grafana) on a 2 GB Nano. Measure the deployed steady-state memory
before treating Grafana as always-on; Alertmanager and the receiver are the
required PR-206 delivery path, while Grafana is only the dashboard surface.

**Auth:** Anonymous viewing and sign-up are disabled. Grafana is published on
Jetson loopback only. Provision its admin credential through the operator's
secret-management process before enabling the optional stack; do not commit it
to Compose or the repository.

Verify the access boundary after deployment:

```bash
# On the Jetson/inside homecam-net: 200 + Prometheus text exposition.
curl -f http://127.0.0.1:8000/metrics

# From a tailnet client through the production HTTPS origin: 404.
curl -o /dev/null -w '%{http_code}\n' \
  https://homecam.tail4a6525.ts.net/metrics

# If the optional stack is running, target health must be 1.
docker exec homecam-prometheus wget -qO- \
  'http://127.0.0.1:9090/api/v1/query?query=up%7Bjob%3D%22homecam%22%7D'

# Confirm the Alertmanager and independent receiver are ready.
curl -f http://127.0.0.1:9093/-/ready
docker exec homecam-alert-receiver curl -fsS http://127.0.0.1:9095/healthz
```

Run `bash deploy/alert-drill.sh --dry-run` first. The executing form sends one
real firing notification and one recovery notification for every critical rule
plus the bounded server-restart warning, and therefore requires
`HOMECAM_DRILL_CONFIRM=YES`. See `RECOVERY_DRILLS.md`.

## Troubleshooting

- **No video** — `journalctl -u mediamtx -f`. If you see `Connecting to nvargus-daemon failed` the systemd unit has `PrivateTmp=yes`; remove it. If you see `no element "rtspclientsink"`, install `gstreamer1.0-rtsp`.
- **Detection never fires** — `journalctl -u homecam-detect -f`. If the import fails with `libgomp.so.1: cannot allocate memory in static TLS block`, `cv2` is being imported after `jetson_inference` somewhere; verify `detection/detect.py` hasn't been reordered.
- **WebRTC "checking" forever** — the browser may not be reaching ICE candidates on the LAN. Add `webrtcAdditionalHosts: ['<jetson-lan-ip>']` to `mediamtx.yml`.
- **Push not working on Android** — confirm you're on HTTPS, the service worker registered (DevTools → Application → Service Workers), and Chrome notification permission was granted. A test push from `Settings → Send` should arrive within seconds.
- **Server container won't start** — `docker compose -f deploy/docker-compose.yml logs server`. Most often a missing or 0-byte VAPID key file in the named volume; remove the volume and let the entrypoint regenerate.
