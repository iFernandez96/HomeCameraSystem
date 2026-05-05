#!/usr/bin/env bash
# Tail dmesg --follow filtered to keywords that indicate detector +
# pipeline distress. Each match becomes one line in the output log so
# the parser can count alerts.
#
# Usage: dmesg_watch.sh <logfile> <pidfile>
set -eu

LOGFILE="${1:?logfile required}"
PIDFILE="${2:?pidfile required}"

# Snapshot prior dmesg before --follow so the parser captures pre-soak
# context (e.g. previous OOM that already happened).
{
  echo "=== dmesg snapshot at $(date -u --iso-8601=seconds) ==="
  dmesg | tail -n 200
  echo "=== tail -F begin ==="
} > "$LOGFILE"

# grep alternation covers:
#   - SoC thermal trip (tegra_soctherm)
#   - kernel-level throttle messages
#   - OOM kill / SIGKILL signatures
#   - libargus / nvargus camera-stack errors
#   - NVDEC / NVENC driver complaints (nvv4l2, nvbufsurface)
#   - CUDA runtime errors
#   - TensorRT engine deserialize failures
( dmesg --follow 2>/dev/null \
  | grep --line-buffered -E -i \
      'soctherm|throttle|out of memory|oom-killer|killed process|sigkill|nvargus|nvbufsurface|nvv4l2|nvdec|nvenc|cuda|tensorrt|libargus|tegra_pmc|hung_task' \
  >> "$LOGFILE" ) &
echo $! > "$PIDFILE"
