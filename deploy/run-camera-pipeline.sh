#!/usr/bin/env bash
set -euo pipefail

MARKER="${HOMECAM_FOCUS_MARKER:-/home/israel/HomeCameraSystem/.focus-mode-expires}"
RTSP_PORT="${RTSP_PORT:-8554}"
now=$(date +%s)
expires=0
if [ -r "$MARKER" ]; then
    read -r expires < "$MARKER" || expires=0
fi

if [[ "$expires" =~ ^[0-9]+$ ]] && (( expires > now )); then
    echo "[camera] temporary 1080p focus mode active until $expires"
    exec gst-launch-1.0 -e \
        nvarguscamerasrc sensor-mode=1 ! \
        'video/x-raw(memory:NVMM),width=1920,height=1080,framerate=60/1' ! \
        nvv4l2h264enc insert-sps-pps=true iframeinterval=8 control-rate=1 bitrate=5000000 vbv-size=5000000 peak-bitrate=6000000 EnableTwopassCBR=false maxperf-enable=true ! \
        h264parse ! watchdog timeout=5000 ! \
        rtspclientsink protocols=tcp location="rtsp://localhost:${RTSP_PORT}/cam"
fi

# An expired marker is harmless but removing it keeps status inspection clear.
rm -f "$MARKER"
echo "[camera] normal 720p mode"
exec gst-launch-1.0 -e \
    nvarguscamerasrc sensor-mode=1 ! \
    'video/x-raw(memory:NVMM),width=1920,height=1080,framerate=60/1' ! \
    nvvidconv ! \
    'video/x-raw(memory:NVMM),width=1280,height=720' ! \
    nvv4l2h264enc insert-sps-pps=true iframeinterval=8 control-rate=1 bitrate=2500000 vbv-size=2500000 peak-bitrate=3000000 EnableTwopassCBR=false maxperf-enable=true ! \
    h264parse ! watchdog timeout=5000 ! \
    rtspclientsink protocols=tcp location="rtsp://localhost:${RTSP_PORT}/cam"
