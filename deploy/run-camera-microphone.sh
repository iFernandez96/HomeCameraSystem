#!/usr/bin/env bash
set -euo pipefail

device="${HOMECAM_MIC_DEVICE:?set HOMECAM_MIC_DEVICE to an ALSA capture device}"
exec gst-launch-1.0 -q \
  alsasrc device="$device" do-timestamp=true \
  ! audioconvert ! audioresample \
  ! opusenc bitrate="${HOMECAM_MIC_BITRATE:-32000}" frame-size=20 \
  ! rtspclientsink protocols=tcp location=rtsp://127.0.0.1:8554/listen
