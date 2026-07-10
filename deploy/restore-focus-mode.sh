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
    for attempt in 1 2; do
        systemctl stop mediamtx.service
        pkill -9 -f 'gst-launch-1.0.*nvarguscamerasrc' 2>/dev/null || true
        systemctl restart nvargus-daemon.service
        sleep 2
        systemctl start mediamtx.service
        for _ in $(seq 1 20); do
            resolution=$(timeout 5 ffprobe -v error -rtsp_transport tcp \
                -select_streams v:0 -show_entries stream=width,height \
                -of csv=p=0 rtsp://127.0.0.1:8554/cam 2>/dev/null || true)
            [ "$resolution" = "1280,720" ] && break 2
            sleep 1
        done
        echo "[focus-restore] 720p publication missing after attempt $attempt" >&2
    done
    # A decoder that saw 404 during the gap remains permanently dead on this
    # JetPack release. Recreate it only after the publisher is reachable.
    systemctl restart homecam-detect.service
fi
