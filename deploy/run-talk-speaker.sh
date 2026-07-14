#!/usr/bin/env bash
set -euo pipefail

enable_file="${HOMECAM_SPEAKER_ENABLE_FILE:-}"
device="${HOMECAM_SPEAKER_DEVICE:-}"

# Audio output is inert until the operator deliberately supplies both a marker
# file and an ALSA device in /etc/homecam/mediamtx.env. Exiting successfully
# while disabled keeps a newly-ready talk publisher from causing hook churn.
if [[ -z "$enable_file" || ! -f "$enable_file" ]]; then
  echo "HomeCam speaker output is disabled; provision the enable marker first" >&2
  exit 0
fi
if [[ -z "$device" ]]; then
  echo "HomeCam speaker output is enabled but HOMECAM_SPEAKER_DEVICE is unset" >&2
  exit 78
fi

exec gst-launch-1.0 -q \
  rtspsrc location=rtsp://127.0.0.1:8554/talk protocols=tcp latency=80 \
  ! decodebin ! audioconvert ! audioresample \
  ! volume volume="${HOMECAM_SPEAKER_VOLUME:-1.0}" \
  ! alsasink device="$device" sync=false
