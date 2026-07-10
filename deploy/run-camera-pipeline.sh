#!/usr/bin/env bash
set -euo pipefail

RTSP_PORT="${RTSP_PORT:-8554}"

# One libargus camera owner, two hardware-encoded publications. Detection reads
# only /cam (720p); viewers explicitly selecting UHQ and Focus Assistant read
# /cam_uhq (1080p). Queues isolate encoder back-pressure across the tee.
echo "[camera] 720p detection/HQ + 1080p UHQ"
exec gst-launch-1.0 -e \
    nvarguscamerasrc sensor-mode=1 ! \
    'video/x-raw(memory:NVMM),width=1920,height=1080,framerate=60/1' ! \
    tee name=camera \
    camera. ! queue max-size-buffers=8 leaky=downstream ! nvvidconv ! \
    'video/x-raw(memory:NVMM),width=1280,height=720' ! \
    nvv4l2h264enc insert-sps-pps=true iframeinterval=8 control-rate=1 bitrate=2500000 vbv-size=2500000 peak-bitrate=3000000 EnableTwopassCBR=false maxperf-enable=true ! \
    h264parse ! watchdog timeout=5000 ! \
    rtspclientsink protocols=tcp location="rtsp://localhost:${RTSP_PORT}/cam" \
    camera. ! queue max-size-buffers=8 leaky=downstream ! \
    nvv4l2h264enc insert-sps-pps=true iframeinterval=8 control-rate=1 bitrate=5000000 vbv-size=5000000 peak-bitrate=6000000 EnableTwopassCBR=false maxperf-enable=true ! \
    h264parse ! watchdog timeout=5000 ! \
    rtspclientsink protocols=tcp location="rtsp://localhost:${RTSP_PORT}/cam_uhq"
