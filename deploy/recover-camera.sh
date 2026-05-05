#!/usr/bin/env bash
# Camera-pipeline recovery one-liner. Operator runs this when the
# Watchpost shows STREAM STALE / WHEP times out / detection worker
# logs `gstDecoder::Capture() -- a timeout occurred` repeatedly.
#
# What it does (mirrors the iter-302 escalate_argus_recovery sequence
# that detect.py runs autonomously when sudo works — see
# detect.py:518-575):
#
#   1. Kill any stuck `gst-launch-1.0` publishers (mediamtx's
#      `runOnInit` spawns one per cam path; if it's blocked inside
#      libargus, mediamtx-restart alone won't unstick it).
#   2. Restart nvargus-daemon — the system-wide libargus broker that
#      owns the IMX477 sensor. This is the heavy hammer; it blanks
#      every camera consumer for 5-10 s.
#   3. Wait 5 s for the daemon to come fully up. Pre-iter-356.63
#      reproductions of this fix showed mediamtx restarting too fast
#      after nvargus failed with `Failed socket read: Connection
#      reset by peer` — the daemon's listener wasn't ready.
#   4. Restart mediamtx. Its `runOnInitRestart: yes` re-spawns a
#      fresh `gst-launch-1.0 nvarguscamerasrc → nvv4l2h264enc →
#      rtspclientsink` pipeline. NVENC re-initializes; first NAL
#      hits the RTSP path within ~3-5 s.
#   5. Verify path `cam` is publishing via the mediamtx HTTP API
#      (defaults off in mediamtx.yml — falls back to journal grep
#      when port 9997 is closed).
#
# Exit codes:
#   0 — success: path `cam` has a publisher within the verify window.
#   1 — recovery commands ran but path is still empty (possible
#       hardware fault: camera ribbon disconnected, sensor failed,
#       lens fully obstructed, /dev/video0 missing).
#   2 — script invoked from a non-root context AND sudo unavailable.
#
# Usage:
#   sudo /home/israel/HomeCameraSystem/deploy/recover-camera.sh
# OR (over SSH from dev box):
#   ssh jetson 'sudo /home/israel/HomeCameraSystem/deploy/recover-camera.sh'
#
# Deliberately verbose by default. --quiet suppresses the running
# commentary; the verdict line still prints.

set -u

QUIET=0
VERIFY_TIMEOUT_S=20
MEDIAMTX_API_URL="http://127.0.0.1:9997/v3/paths/get/cam"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --quiet) QUIET=1 ;;
    --help|-h)
      sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "[recover] unknown flag: $1" >&2; exit 2 ;;
  esac
  shift
done

log() { [[ "$QUIET" -eq 1 ]] || echo "[recover] $*"; }

if [[ "$EUID" -ne 0 ]]; then
  if ! command -v sudo >/dev/null; then
    echo "[recover] not root and sudo missing; cannot proceed" >&2
    exit 2
  fi
  log "re-executing under sudo..."
  exec sudo -n "$0" "$@"
fi

log "step 1/5: killing stuck gst-launch publishers"
if pgrep -f 'gst-launch-1.0.*nvarguscamerasrc' >/dev/null; then
  pkill -9 -f 'gst-launch-1.0.*nvarguscamerasrc' || true
  sleep 1
  if pgrep -f 'gst-launch-1.0.*nvarguscamerasrc' >/dev/null; then
    log "  WARNING: gst-launch still running after SIGKILL"
  else
    log "  killed"
  fi
else
  log "  none running"
fi

log "step 2/5: restarting nvargus-daemon"
systemctl restart nvargus-daemon

log "step 3/5: waiting 5 s for nvargus-daemon to settle"
sleep 5

log "step 4/5: restarting mediamtx"
systemctl restart mediamtx

log "step 5/5: verifying path 'cam' publisher within ${VERIFY_TIMEOUT_S}s"
deadline=$(( SECONDS + VERIFY_TIMEOUT_S ))
publisher_up=0
while (( SECONDS < deadline )); do
  # Path A: mediamtx HTTP API (only available when api.enable=yes in
  # mediamtx.yml; project default is off).
  body=$(curl -fsS --max-time 2 "$MEDIAMTX_API_URL" 2>/dev/null || true)
  if [[ -n "$body" ]]; then
    # Look for "ready":true in the JSON response.
    if echo "$body" | grep -qE '"ready"\s*:\s*true'; then
      publisher_up=1
      log "  mediamtx API reports path ready"
      break
    fi
  fi
  # Path B (fallback): journal grep for the encoder-init lines.
  if journalctl -u mediamtx --since '20 seconds ago' --no-pager 2>/dev/null \
       | grep -q 'NVMEDIA: NVENC\|NvMMLiteOpen.*BlockType = 4'; then
    publisher_up=1
    log "  mediamtx journal shows NVENC initialized"
    break
  fi
  sleep 1
done

if [[ "$publisher_up" -ne 1 ]]; then
  log "  publisher NOT confirmed within ${VERIFY_TIMEOUT_S}s"
  log
  log "next steps to investigate:"
  log "  - check the camera ribbon cable to the IMX477"
  log "  - 'ls /dev/video*' should show /dev/video0"
  log "  - 'systemctl status mediamtx' for the runOnInit failure mode"
  log "  - 'journalctl -u nvargus-daemon -n 50' for libargus errors"
  log "  - bounce the Jetson if all else fails: sudo reboot"
  echo "[recover] FAIL — path 'cam' still empty after recovery sequence"
  exit 1
fi

log "step 6/6: kicking detection worker so it picks up the new stream"
systemctl restart homecam-detect

log
echo "[recover] OK — camera pipeline restored"
exit 0
