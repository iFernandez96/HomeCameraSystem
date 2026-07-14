#!/usr/bin/env bash
set -euo pipefail

MARKER="${HOMECAM_FOCUS_MARKER:-/home/israel/HomeCameraSystem/.focus-mode-expires}"
RESTORE="/home/israel/HomeCameraSystem/deploy/restore-focus-mode.sh"
expected="${1:-}"

for _ in $(seq 1 60); do
  current=""
  if [ -r "$MARKER" ]; then
    read -r current < "$MARKER" || current=""
  fi
  [ -n "$expected" ] && [ "$current" = "$expected" ] || exit 0

  mem_mb=$(awk '/^MemAvailable:/ {print int($2 / 1024)}' /proc/meminfo)
  gpu_temp=""
  for zone in /sys/class/thermal/thermal_zone*; do
    [ -r "$zone/type" ] && [ "$(cat "$zone/type")" = "GPU-therm" ] || continue
    gpu_temp=$(awk '{printf "%.1f", $1 / 1000}' "$zone/temp")
    break
  done
  if [ -z "$mem_mb" ] || [ -z "$gpu_temp" ] \
      || [ "$mem_mb" -lt 350 ] \
      || awk -v temp="$gpu_temp" 'BEGIN { exit !(temp >= 80.0) }'; then
    echo "[focus-guard] unsafe precision headroom; restoring stable mode (memory=${mem_mb:-unknown}MB gpu=${gpu_temp:-unknown}C)" >&2
    exec "$RESTORE" "$expected"
  fi
  sleep 5
done

exec "$RESTORE" "$expected"
