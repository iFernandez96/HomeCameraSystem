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
    # Focus and Exposure Assistant now share the always-on 1440p UHQ path.
    # Expiry only closes the logical session; restarting the camera here would
    # create an avoidable recording and detection gap.
fi
