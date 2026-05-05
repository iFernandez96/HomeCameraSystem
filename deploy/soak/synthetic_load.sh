#!/usr/bin/env bash
# Push a looping test footage MP4 to a parallel RTSP path on MediaMTX.
# Used by scenario 04-stress to drive a steady person-event load without
# needing a real human to walk past the camera.
#
# Usage: synthetic_load.sh <test_footage.mp4>
#
# The MediaMTX config must already accept a publisher on this path. By
# default this script publishes to rtsp://localhost:8554/stress, which is
# NOT what the worker reads (worker reads /cam). The intent is to feed
# stress.rtsp to the worker via DETECT_SOURCE override (see
# scenarios/04-stress.env).
#
# Process tag (homecam-soak-stress) lets run_scenario.sh kill it cleanly
# with `pkill -f homecam-soak-stress`.
set -eu

CLIP="${1:?test footage MP4 required}"
RTSP_URL="${SOAK_RTSP_URL:-rtsp://localhost:8554/stress}"

if [[ ! -f "$CLIP" ]]; then
  echo "[soak] missing test footage: $CLIP" >&2
  echo "[soak] Place a 10-30 s MP4 of a person walking past the camera" >&2
  echo "[soak] at $CLIP. The simplest source: record a real walk-by once" >&2
  echo "[soak] from /api/clips/<event_id>/clip and copy it down." >&2
  exit 2
fi

# -re paces the read at the file's native framerate; -stream_loop -1 loops
# forever; -c:v copy reuses the existing H.264 NAL units (no re-encode →
# no NVENC contention, no decode contention beyond what the worker's
# normal RTSP read already incurs).
exec ffmpeg \
  -hide_banner -loglevel warning \
  -re -stream_loop -1 -i "$CLIP" \
  -c:v copy -an \
  -metadata title='homecam-soak-stress' \
  -f rtsp -rtsp_transport tcp \
  "$RTSP_URL"
