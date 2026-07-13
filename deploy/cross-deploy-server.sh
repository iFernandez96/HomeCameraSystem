#!/usr/bin/env bash
# Cross-build the FastAPI server image for the Jetson's ARM64 CPU on this
# (x86) dev machine, ship the finished image, and recreate the container.
#
# WHY this is the norm: building natively on the Jetson Nano 2GB
# (`docker compose up --build` on the host) recompiles cryptography (Rust),
# Pillow, and argon2 FROM SOURCE under heavy memory pressure → 30-45 min,
# pegs both cores, swap-thrashes, and can wedge the live server (healthz
# starts failing). Cross-building here builds for linux/arm64 under QEMU and
# pulls prebuilt aarch64 manylinux wheels (`--prefer-binary` in the
# Dockerfile) → a few minutes on the laptop, ZERO load on the Nano, which
# only has to `docker load` a finished image. Same artifact you can test
# locally before shipping.
#
# One-time setup on the dev machine:
#   docker buildx version                     # buildx must be present
#   docker run --privileged --rm tonistiigi/binfmt --install arm64
#
# Usage: deploy/cross-deploy-server.sh [ssh-host]      (default host: jetson)
set -euo pipefail

HOST="${1:-jetson}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TAR="${HOMECAM_SERVER_TAR:-/tmp/homecam-server-arm64.tar}"
IMAGE="homecam-server:latest"
COMPOSE="/home/israel/HomeCameraSystem/deploy/docker-compose.yml"
SSH_RETRY_S="${HOMECAM_SSH_RETRY_S:-5}"
SSH_WAIT_TIMEOUT_S="${HOMECAM_SSH_WAIT_TIMEOUT_S:-0}"
SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=8 -o ServerAliveInterval=5 -o ServerAliveCountMax=2)

case "$SSH_RETRY_S,$SSH_WAIT_TIMEOUT_S" in
  *[!0-9,]*)
    echo "HOMECAM_SSH_RETRY_S and HOMECAM_SSH_WAIT_TIMEOUT_S must be non-negative integers" >&2
    exit 2
    ;;
esac
if [ "$SSH_RETRY_S" -lt 1 ]; then
  echo "HOMECAM_SSH_RETRY_S must be at least 1 second" >&2
  exit 2
fi

wait_for_ssh() {
  local started=$SECONDS attempts=0 elapsed
  while ! ssh "${SSH_OPTS[@]}" "$HOST" true >/dev/null 2>&1; do
    attempts=$((attempts + 1))
    elapsed=$((SECONDS - started))
    if [ "$SSH_WAIT_TIMEOUT_S" -gt 0 ] && [ "$elapsed" -ge "$SSH_WAIT_TIMEOUT_S" ]; then
      echo "TIMEOUT waiting ${elapsed}s for SSH on $HOST" >&2
      return 1
    fi
    # First failure is immediate; subsequent updates are rate-limited to
    # roughly 30 seconds at the default interval so unattended deploy logs do
    # not grow without bound during an outage.
    if [ "$attempts" -eq 1 ] || [ $((attempts % 6)) -eq 0 ]; then
      echo "==> $HOST is offline or unreachable; retrying SSH (${elapsed}s elapsed)…" >&2
    fi
    sleep "$SSH_RETRY_S"
  done
  if [ "$attempts" -gt 0 ]; then
    echo "==> $HOST is reachable again; resuming deployment."
  fi
}

run_ssh_retry() {
  local remote_command="$1" rc
  while true; do
    wait_for_ssh
    set +e
    ssh "${SSH_OPTS[@]}" "$HOST" "$remote_command"
    rc=$?
    set -e
    [ "$rc" -eq 0 ] && return 0
    # 255 is OpenSSH's transport/session failure. Remote command failures are
    # real deployment errors and must not be hidden behind an infinite retry.
    [ "$rc" -eq 255 ] || return "$rc"
    echo "==> SSH transport dropped; waiting to resume…" >&2
  done
}

load_image_retry() {
  local rc
  while true; do
    wait_for_ssh
    set +e
    ssh "${SSH_OPTS[@]}" "$HOST" 'sudo docker load' < "$TAR"
    rc=$?
    set -e
    [ "$rc" -eq 0 ] && return 0
    [ "$rc" -eq 255 ] || return "$rc"
    echo "==> image transfer lost SSH; restarting the idempotent transfer…" >&2
  done
}

cd "$ROOT"
SOURCE_FINGERPRINT="$(bash scripts/source-fingerprint.sh)"
BUILD_EPOCH="$(date +%s)"

echo "==> cross-building $IMAGE for linux/arm64 (prebuilt aarch64 wheels)…"
docker buildx build --platform linux/arm64 \
  --build-arg "HOMECAM_SOURCE_FINGERPRINT=$SOURCE_FINGERPRINT" \
  --build-arg "HOMECAM_BUILD_EPOCH=$BUILD_EPOCH" \
  -f deploy/Dockerfile.server -t "$IMAGE" \
  -o "type=docker,dest=$TAR" .
echo "==> source fingerprint $SOURCE_FINGERPRINT (build epoch $BUILD_EPOCH)"

echo "==> shipping image to $HOST ($(du -h "$TAR" | cut -f1))…"
load_image_retry

echo "==> recreating server container from the loaded image (no --build)…"
run_ssh_retry "cd /home/israel/HomeCameraSystem && sudo docker compose -f '$COMPOSE' up -d --no-build server"

echo "==> waiting for /healthz (until-loop, no fixed sleep)…"
run_ssh_retry 'n=0; until curl -sf -m5 http://localhost:8000/healthz >/dev/null 2>&1; do
  n=$((n+1)); [ "$n" -gt 40 ] && { echo "TIMEOUT waiting for healthz"; exit 1; }
  sleep 3
done; echo "healthy after ${n} checks"'

echo "==> done — server is up on $HOST with the freshly cross-built image."
