#!/usr/bin/env bash
# install-jetson.sh — bootstrap a Jetson Nano 2GB to run Home Camera System.
#
# Run on the Jetson itself, after rsync'ing the repo to ~/HomeCameraSystem:
#
#   ssh jetson 'bash ~/HomeCameraSystem/deploy/install-jetson.sh'
#
# Idempotent — safe to re-run after pulling updates.

set -euo pipefail

REPO="${REPO:-$HOME/HomeCameraSystem}"
MEDIAMTX_VERSION="${MEDIAMTX_VERSION:-v1.18.0}"

# Honour the standard NO_COLOR convention and skip ANSI codes when
# stdout isn't a TTY (e.g. `bash install-jetson.sh > install.log`).
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
    C_BLUE=$'\033[36m' C_GREEN=$'\033[32m' C_YELLOW=$'\033[33m' C_RESET=$'\033[0m'
else
    C_BLUE='' C_GREEN='' C_YELLOW='' C_RESET=''
fi

log()  { printf "%s==>%s %s\n" "$C_BLUE" "$C_RESET" "$*"; }
ok()   { printf "%s  ✓%s %s\n" "$C_GREEN" "$C_RESET" "$*"; }
warn() { printf "%s  !%s %s\n" "$C_YELLOW" "$C_RESET" "$*"; }

[ -d "$REPO" ] || { echo "Repo not at $REPO. rsync it over first."; exit 1; }
cd "$REPO"

# 1. System packages -----------------------------------------------------------

log "Installing system packages (gstreamer-rtsp, curl)"
sudo apt-get update -qq
sudo apt-get install -y --no-install-recommends gstreamer1.0-rtsp curl > /dev/null
ok "apt deps ready"

# 1.5. Swapfile ----------------------------------------------------------------
#
# JetPack 4.x defaults to ~1 GB of zram across 4 partitions, which fills under
# normal load on the 2 GB Nano. A 4 GB disk-backed swapfile catches overflow
# and defers OOM-kills. The detection worker's MemoryGuard (iter-33) starts
# pausing inference at 80 MB MemAvailable, so this is the safety net that
# prevents that path from triggering in the first place.

if [ ! -f /swapfile ]; then
    log "Creating /swapfile (4 GB)"
    sudo fallocate -l 4G /swapfile
    sudo chmod 600 /swapfile
    sudo mkswap /swapfile >/dev/null
    sudo swapon /swapfile
    if ! grep -qE '^[^#]*\s/swapfile\s' /etc/fstab; then
        echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
    fi
    ok "/swapfile created and swapon'd"
elif ! swapon --show 2>/dev/null | grep -q '^/swapfile'; then
    log "/swapfile exists but is not active — running swapon"
    sudo swapon /swapfile || warn "swapon failed; check 'swapon --show' / 'free -h'"
    ok "/swapfile active"
else
    ok "/swapfile already active ($(swapon --show=NAME,SIZE 2>/dev/null | awk '$1=="/swapfile"{print $2}'))"
fi

# 2. Docker access -------------------------------------------------------------

if ! groups | grep -qw docker; then
    log "Adding $USER to docker group (re-login required to take effect)"
    sudo usermod -aG docker "$USER"
    warn "Log out and back in (or run \`newgrp docker\`) before continuing."
fi

if ! systemctl is-active --quiet docker; then
    log "Starting docker daemon"
    sudo systemctl enable --now docker
fi
ok "docker up"

# 3. Docker Compose v2 plugin --------------------------------------------------

if ! docker compose version >/dev/null 2>&1; then
    log "Installing docker compose v2 plugin"
    mkdir -p ~/.docker/cli-plugins
    curl -fsSL "https://github.com/docker/compose/releases/latest/download/docker-compose-linux-aarch64" \
        -o ~/.docker/cli-plugins/docker-compose
    chmod +x ~/.docker/cli-plugins/docker-compose
fi
ok "docker compose $(docker compose version --short 2>/dev/null || echo 'installed')"

# 4. MediaMTX binary -----------------------------------------------------------

if [ ! -x "$REPO/mediamtx" ]; then
    log "Downloading MediaMTX $MEDIAMTX_VERSION"
    url="https://github.com/bluenviron/mediamtx/releases/download/${MEDIAMTX_VERSION}/mediamtx_${MEDIAMTX_VERSION}_linux_arm64.tar.gz"
    tmp=$(mktemp)
    curl -fsSL "$url" -o "$tmp"
    tar -xzf "$tmp" -C "$REPO" mediamtx
    rm -f "$tmp"
    chmod +x "$REPO/mediamtx"
fi
current_mediamtx_version=$("$REPO/mediamtx" --version 2>&1 | head -1)
if [ "$current_mediamtx_version" != "$MEDIAMTX_VERSION" ]; then
    # Don't auto-replace a working binary — restarting mediamtx during a
    # version bump can disrupt live video, and a new release sometimes
    # changes config keys (we already paid for one such bump in the
    # webrtcAllowOrigin → webrtcAllowOrigins rename). Tell the operator
    # what to do instead.
    warn "MediaMTX is $current_mediamtx_version; install-jetson.sh pins $MEDIAMTX_VERSION."
    warn "    To upgrade: rm $REPO/mediamtx && bash $0   (then check mediamtx.yml against release notes)"
fi
ok "MediaMTX $current_mediamtx_version"

# 5. systemd units -------------------------------------------------------------

log "Installing systemd units"
# Defensive: ensure the worker entrypoint is executable. systemd's
# ExecStart requires the +x bit; if the file lost it in transit
# (Windows checkout, manual copy without -p, exFAT without xattrs)
# the homecam-detect unit would fail at start with "Permission denied"
# and systemd's StartLimitBurst would mark it `failed` after 5 tries.
chmod +x "$REPO/detection/run-detect.sh"
sudo cp "$REPO/deploy/systemd/mediamtx.service" /etc/systemd/system/
sudo cp "$REPO/deploy/systemd/homecam-server.service" /etc/systemd/system/
sudo cp "$REPO/deploy/systemd/homecam-detect.service" /etc/systemd/system/
sudo cp "$REPO/deploy/systemd/homecam-backup.service" /etc/systemd/system/
sudo cp "$REPO/deploy/systemd/homecam-backup.timer" /etc/systemd/system/
# Install the optional acoustic-event watcher definition, but deliberately do
# not enable or start it below.  It must remain dormant until microphone
# hardware is intentionally configured and the operator enables audio events.
if [ -f "$REPO/deploy/systemd/homecam-audio-detect.service" ]; then
    sudo cp "$REPO/deploy/systemd/homecam-audio-detect.service" /etc/systemd/system/
fi
sudo cp "$REPO/deploy/systemd/homecam-jetson-perf.service" /etc/systemd/system/
sudo systemctl daemon-reload
ok "units installed"

# 5.5. Shared worker credential -----------------------------------------------
# Provision before either the server container or host worker starts. Re-runs
# preserve the existing valid value; rotation is an explicit maintenance task
# so the two processes can never be switched independently by accident.
log "Provisioning host-worker authentication secret"
bash "$REPO/deploy/provision-worker-secret.sh"
ok "worker authentication secret ready"

# 5.6. Backup recipient key ---------------------------------------------------
# The private recovery key must never be generated or copied onto this host.
# Refuse startup until the public half has been provisioned from the recovery
# machine according to RECOVERY_DRILLS.md.
if [ ! -f /etc/homecam/backup-recipient.pem ]; then
    warn "Missing /etc/homecam/backup-recipient.pem; encrypted backup startup is fail-closed."
    warn "    Generate the recovery pair off-Jetson and provision only its public key."
    exit 1
fi
sudo chown root:root /etc/homecam/backup-recipient.pem
sudo chmod 0644 /etc/homecam/backup-recipient.pem
ok "backup recipient public key ready (private recovery key not present)"

# 6. Verify the cross-built server image ---------------------------------------

# Never compile the server image on the 2 GB Nano. Native dependency builds
# exhaust memory/swap and can wedge the live camera host. The development
# machine must run deploy/cross-deploy-server.sh first (or otherwise load the
# exact ARM64 image) before this bootstrap script starts services.
if ! sudo docker image inspect homecam-server:latest >/dev/null 2>&1; then
    warn "homecam-server:latest is not loaded; refusing a native Jetson build."
    warn "    From the development machine run: deploy/cross-deploy-server.sh jetson"
    exit 1
fi
ok "prebuilt ARM64 homecam-server:latest is loaded"

log "Enabling and starting services"
# Jetson perf unit first — selects the MAXN power envelope while leaving
# dynamic CPU/GPU clocks enabled. The encoder has its own max-performance
# setting, so global clock pinning is unnecessary for stream startup.
# Skipped silently on non-Jetson hosts via the unit's
# ConditionPathExists guard.
sudo systemctl enable --now homecam-jetson-perf.service || true
sudo systemctl enable --now mediamtx.service
sudo systemctl enable --now homecam-server.service
sudo systemctl enable --now homecam-detect.service
sudo systemctl enable --now homecam-backup.timer

# Brief settle.
sleep 5

# 7. Smoke test ----------------------------------------------------------------

log "Smoke test"
if curl -fsS http://localhost:8000/api/status >/dev/null; then
    ok "FastAPI: $(curl -fsS http://localhost:8000/api/status)"
else
    warn "FastAPI not responding on :8000 yet — \`docker compose -f deploy/docker-compose.yml logs\` may help"
fi

if ss -ltn 2>/dev/null | grep -q ':8889 '; then
    ok "MediaMTX: WebRTC listener on :8889"
else
    warn "MediaMTX :8889 not listening — \`journalctl -u mediamtx -n 50\` may help"
fi

echo
log "Done. Open the operator Tailscale HTTPS URL. Direct LAN HTTP is unsupported."
