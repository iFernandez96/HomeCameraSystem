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
TAR="/tmp/homecam-server-arm64.tar"
IMAGE="homecam-server:latest"
COMPOSE="/home/israel/HomeCameraSystem/deploy/docker-compose.yml"

cd "$ROOT"

echo "==> cross-building $IMAGE for linux/arm64 (prebuilt aarch64 wheels)…"
docker buildx build --platform linux/arm64 \
  -f deploy/Dockerfile.server -t "$IMAGE" \
  -o "type=docker,dest=$TAR" .

echo "==> shipping image to $HOST ($(du -h "$TAR" | cut -f1))…"
ssh "$HOST" 'sudo docker load' < "$TAR"

echo "==> recreating server container from the loaded image (no --build)…"
ssh "$HOST" "cd /home/israel/HomeCameraSystem && sudo docker compose -f '$COMPOSE' up -d --no-build server"

echo "==> waiting for /healthz (until-loop, no fixed sleep)…"
ssh "$HOST" 'n=0; until curl -sf -m5 http://localhost:8000/healthz >/dev/null 2>&1; do
  n=$((n+1)); [ "$n" -gt 40 ] && { echo "TIMEOUT waiting for healthz"; exit 1; }
  sleep 3
done; echo "healthy after ${n} checks"'

echo "==> done — server is up on $HOST with the freshly cross-built image."
