#!/usr/bin/env bash
# Soak scenario orchestrator. Runs ONE scenario for N seconds.
#
# Usage:
#   sudo ./run_scenario.sh <scenario-name> <duration-s> [--smoke]
#   sudo ./run_scenario.sh --abort
#
# Examples:
#   sudo ./run_scenario.sh 01-ssd-baseline 14400        # 4 h
#   sudo ./run_scenario.sh 02-yolo-416    14400 --smoke # 5 min for harness test
#   sudo ./run_scenario.sh --abort                       # cleanup
#
# What it does:
#   1. Acquires /var/lock/homecam-soak.lock (refuses concurrent runs).
#   2. Snapshots nvpmodel + jetson_clocks + free + uptime → run/preflight.txt
#   3. Drops a systemd override at /etc/systemd/system/homecam-detect.service.d/soak.conf
#      with the scenario's env vars (DETECT_MODEL, DETECT_ACTIVE_FPS, ...).
#   4. systemctl daemon-reload + restart homecam-detect.
#   5. Starts: tegrastats logger, heartbeat poller, status poller, dmesg watch.
#   6. For scenario 04-stress: also kicks off synthetic_load.sh.
#   7. Waits N seconds.
#   8. Stops loggers, removes override, restarts homecam-detect to baseline.
#   9. Calls parse_soak.py → summary.json + summary.txt.
#   10. Prints the verdict line.
#
# Designed to be ctrl-C safe: the trap restores baseline + cleans up.

set -euo pipefail

SOAK_DIR="$(cd "$(dirname "$0")" && pwd)"
LOCK_FILE="/var/lock/homecam-soak.lock"
OVERRIDE_DIR="/etc/systemd/system/homecam-detect.service.d"
OVERRIDE_FILE="${OVERRIDE_DIR}/soak.conf"
LOGS_ROOT="${SOAK_DIR}/logs"
HEARTBEAT_URL="http://127.0.0.1:8000/api/_internal/heartbeat"
STATUS_URL_DEFAULT="http://127.0.0.1:8000/api/status"
MIN_DURATION_S=1800
SMOKE_DURATION_S=300
COOLDOWN_TARGET_C=50

usage() {
  sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'
  exit 1
}

abort_handler() {
  echo "[soak] aborting; cleaning up..." >&2
  stop_loggers || true
  if [[ -f "$OVERRIDE_FILE" ]]; then
    rm -f "$OVERRIDE_FILE"
    systemctl daemon-reload || true
    systemctl restart homecam-detect || true
  fi
  exit 130
}

stop_loggers() {
  for pidf in "$RUN_DIR"/*.pid; do
    [[ -f "$pidf" ]] || continue
    pid=$(cat "$pidf" 2>/dev/null || echo "")
    [[ -n "$pid" ]] && kill -TERM "$pid" 2>/dev/null || true
    rm -f "$pidf"
  done
  # Synthetic-load ffmpeg (named so we can pkill it)
  pkill -TERM -f 'ffmpeg.*homecam-soak-stress' 2>/dev/null || true
}

# --- arg parsing -----------------------------------------------------------

if [[ "${1:-}" == "--abort" ]]; then
  echo "[soak] removing override + restarting worker..."
  rm -f "$OVERRIDE_FILE"
  systemctl daemon-reload
  systemctl restart homecam-detect
  pkill -TERM -f tegrastats || true
  pkill -TERM -f heartbeat_log.py || true
  pkill -TERM -f status_log.py || true
  pkill -TERM -f dmesg_watch.sh || true
  pkill -TERM -f 'ffmpeg.*homecam-soak-stress' || true
  echo "[soak] aborted"
  exit 0
fi

[[ $# -ge 2 ]] || usage
SCENARIO="$1"
DURATION_S="$2"
SMOKE=0
ALLOW_UNPINNED=0
shift 2
while [[ $# -gt 0 ]]; do
  case "$1" in
    --smoke) SMOKE=1; DURATION_S=$SMOKE_DURATION_S ;;
    --allow-unpinned-clocks) ALLOW_UNPINNED=1 ;;
    *) echo "[soak] unknown flag: $1" >&2; exit 2 ;;
  esac
  shift
done

if [[ "$EUID" -ne 0 ]]; then
  echo "[soak] must run as root (systemctl + nvpmodel access)" >&2
  exit 2
fi

if [[ "$SMOKE" -eq 0 && "$DURATION_S" -lt "$MIN_DURATION_S" ]]; then
  echo "[soak] duration $DURATION_S < ${MIN_DURATION_S}s; pass --smoke to run a 5 min harness test." >&2
  exit 2
fi

SCENARIO_FILE="${SOAK_DIR}/scenarios/${SCENARIO}.env"
if [[ ! -f "$SCENARIO_FILE" ]]; then
  echo "[soak] no such scenario: $SCENARIO_FILE" >&2
  exit 2
fi

# --- lock -----------------------------------------------------------------

exec 200>"$LOCK_FILE"
if ! flock -n 200; then
  echo "[soak] another soak run is in progress; aborting." >&2
  exit 3
fi

# --- preflight ------------------------------------------------------------

UTC_TS=$(date -u +%Y%m%dT%H%M%SZ)
RUN_DIR="${LOGS_ROOT}/${SCENARIO}-${UTC_TS}"
mkdir -p "$RUN_DIR"
PREFLIGHT="${RUN_DIR}/preflight.txt"

trap abort_handler INT TERM

{
  echo "=== soak preflight $(date -u --iso-8601=seconds) ==="
  echo "scenario: $SCENARIO"
  echo "duration_s: $DURATION_S (smoke=$SMOKE)"
  echo "host: $(hostname) kernel: $(uname -r)"
  echo
  echo "--- nvpmodel ---"
  nvpmodel -q 2>/dev/null || echo "(nvpmodel unavailable)"
  echo
  echo "--- jetson_clocks --show ---"
  jetson_clocks --show 2>/dev/null || echo "(jetson_clocks unavailable)"
  echo
  echo "--- free -m ---"
  free -m
  echo
  echo "--- uptime + loadavg ---"
  uptime
  echo
  echo "--- thermal zones ---"
  for z in /sys/class/thermal/thermal_zone*/type; do
    name=$(cat "$z" 2>/dev/null || echo "?")
    temp=$(cat "${z%type}temp" 2>/dev/null || echo 0)
    echo "$(dirname "$z" | xargs basename): $name = $(awk "BEGIN{printf \"%.1f\", $temp/1000}") C"
  done
  echo
  echo "--- scenario env (${SCENARIO_FILE}) ---"
  cat "$SCENARIO_FILE"
  echo
  echo "--- detection_config (current) ---"
  curl -sS "$STATUS_URL_DEFAULT" 2>/dev/null || echo "(status not reachable yet)"
} > "$PREFLIGHT"

if [[ "$ALLOW_UNPINNED" -eq 0 ]]; then
  if ! grep -q 'CPU.*Cluster' "$PREFLIGHT" || ! nvpmodel -q | grep -qE 'Power Mode'; then
    echo "[soak] WARNING: nvpmodel/jetson_clocks check inconclusive" >&2
  fi
fi

# Cooldown gate: refuse to start if GPU is hot from a previous run.
GPU_C=$(awk '/GPU-therm/{print $0}' "$PREFLIGHT" | awk -F= '{print $2}' | awk '{print $1}' | head -1)
if [[ -n "${GPU_C:-}" ]]; then
  if awk -v t="$GPU_C" -v c="$COOLDOWN_TARGET_C" 'BEGIN{exit !(t>c)}'; then
    echo "[soak] GPU $GPU_C C > $COOLDOWN_TARGET_C C cooldown target; sleeping 600 s before starting..." >&2
    [[ "$SMOKE" -eq 1 ]] || sleep 600
  fi
fi

# --- override + restart worker --------------------------------------------

mkdir -p "$OVERRIDE_DIR"
{
  echo "[Service]"
  # shellcheck disable=SC1090
  while IFS= read -r line; do
    [[ -z "$line" || "${line:0:1}" == "#" ]] && continue
    echo "Environment=\"$line\""
  done < "$SCENARIO_FILE"
} > "$OVERRIDE_FILE"

# Special case: scenario 00-idle disables detection via PATCH instead of env.
IS_IDLE=0
if [[ "$SCENARIO" == "00-idle" ]]; then
  IS_IDLE=1
  curl -sS -X PATCH -H 'Content-Type: application/json' \
    -d '{"enabled": false}' \
    -b "${SOAK_COOKIE_JAR:-/dev/null}" \
    "http://127.0.0.1:8000/api/detection/config" \
    > "${RUN_DIR}/idle_patch.json" 2>&1 || true
fi

systemctl daemon-reload
systemctl restart homecam-detect
sleep 8   # allow TRT engine deserialize before logger starts polling

# --- start loggers --------------------------------------------------------

"$SOAK_DIR/tegrastats.sh" "$RUN_DIR/tegrastats.log" "$RUN_DIR/tegrastats.pid"
python3 "$SOAK_DIR/heartbeat_log.py" \
  --url "$HEARTBEAT_URL" --interval 10 \
  --out "$RUN_DIR/heartbeat.jsonl" \
  --pidfile "$RUN_DIR/heartbeat.pid" &
HB_PID=$!
echo "$HB_PID" > "$RUN_DIR/heartbeat.pid"

python3 "$SOAK_DIR/status_log.py" \
  --url "$STATUS_URL_DEFAULT" --interval 10 \
  --out "$RUN_DIR/status.jsonl" \
  --pidfile "$RUN_DIR/status.pid" \
  --cookie-jar "${SOAK_COOKIE_JAR:-}" &
ST_PID=$!
echo "$ST_PID" > "$RUN_DIR/status.pid"

"$SOAK_DIR/dmesg_watch.sh" "$RUN_DIR/dmesg.log" "$RUN_DIR/dmesg.pid"

if [[ "$SCENARIO" == "04-stress" ]]; then
  "$SOAK_DIR/synthetic_load.sh" "${SOAK_DIR}/test_footage.mp4" \
    > "$RUN_DIR/synthetic_load.log" 2>&1 &
  echo $! > "$RUN_DIR/synthetic_load.pid"
fi

# --- wait + parse ---------------------------------------------------------

echo "[soak] running scenario=$SCENARIO duration=${DURATION_S}s logs=$RUN_DIR"
sleep "$DURATION_S"

stop_loggers
rm -f "$OVERRIDE_FILE"
systemctl daemon-reload
systemctl restart homecam-detect

# Re-enable detection if we disabled it for idle.
if [[ "$IS_IDLE" -eq 1 ]]; then
  curl -sS -X PATCH -H 'Content-Type: application/json' \
    -d '{"enabled": true}' \
    "http://127.0.0.1:8000/api/detection/config" >/dev/null 2>&1 || true
fi

python3 "$SOAK_DIR/parse_soak.py" "$RUN_DIR" \
  > "$RUN_DIR/summary.txt" 2> "$RUN_DIR/parse.err" || true

if [[ -s "$RUN_DIR/summary.txt" ]]; then
  cat "$RUN_DIR/summary.txt"
else
  echo "[soak] parser produced no summary; see $RUN_DIR/parse.err" >&2
fi

echo "[soak] done. logs in: $RUN_DIR"
