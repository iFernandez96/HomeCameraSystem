#!/usr/bin/env bash
set -euo pipefail

MARKER="${HOMECAM_FOCUS_MARKER:-/home/israel/HomeCameraSystem/.focus-mode-expires}"
expected="${1:-}"
current=""
if [ -r "$MARKER" ]; then
    read -r current < "$MARKER" || current=""
fi

# A timer from an older session must never terminate a newer session.
if [ -n "$expected" ] && [ "$current" = "$expected" ]; then
    rm -f "$MARKER"
    # Precision is intentionally temporary. Use the same bounded deep recovery
    # path as camera repair so Argus is released before the stable graph starts.
    exec /home/israel/HomeCameraSystem/deploy/recover-camera.sh
fi
