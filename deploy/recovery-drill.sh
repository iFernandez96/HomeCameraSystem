#!/usr/bin/env bash
# Operator-driven recovery exercises. Dry-run is the safe default.
set -euo pipefail

BASE_URL="${HOMECAM_BASE_URL:-http://127.0.0.1:8000}"
MODE="${1:---dry-run}"
CASE="${2:-all}"

usage() {
  echo "usage: $0 [--dry-run|--execute] [server|disk|session|media|all]"
  echo "Execution is local-only and requires HOMECAM_DRILL_CONFIRM=YES."
}

[[ "$MODE" == "--dry-run" || "$MODE" == "--execute" ]] || { usage >&2; exit 2; }
[[ "$CASE" =~ ^(server|disk|session|media|all)$ ]] || { usage >&2; exit 2; }
if [[ "$MODE" == "--execute" && "${HOMECAM_DRILL_CONFIRM:-}" != "YES" ]]; then
  echo "refusing disruptive drill: export HOMECAM_DRILL_CONFIRM=YES" >&2
  exit 2
fi

show() { printf '%s\n' "$*"; }
run() {
  if [[ "$MODE" == "--dry-run" ]]; then show "DRY RUN: $*"; else "$@"; fi
}

server() {
  show "[server supervision] kill only the API container; require bounded recovery while camera services stay up"
  run env BASE_URL="$BASE_URL" bash -lc 'set -euo pipefail
    fail() { echo "server supervision drill failed: $*" >&2; exit 1; }
    mediamtx_pid=$(systemctl show -p MainPID --value mediamtx.service)
    detect_pid=$(systemctl show -p MainPID --value homecam-detect.service)
    server_id=$(docker inspect -f "{{.Id}}" homecam-server)
    timeout 8 ffprobe -v error -rtsp_transport tcp -select_streams v:0 \
      -show_entries stream=codec_name -of csv=p=0 \
      rtsp://127.0.0.1:8554/cam >/dev/null || fail "camera publisher absent before kill"
    docker kill homecam-server >/dev/null
    deadline=$((SECONDS + 120))
    while true; do
      new_id=$(docker inspect -f "{{.Id}}" homecam-server 2>/dev/null || true)
      running=$(docker inspect -f "{{.State.Running}}" homecam-server 2>/dev/null || true)
      if [[ -n "$new_id" && "$new_id" != "$server_id" && "$running" == "true" ]] \
          && curl --fail --silent --max-time 2 "$BASE_URL/healthz" >/dev/null; then
        break
      fi
      (( SECONDS < deadline )) || fail "server did not recover within 120 seconds"
      sleep 2
    done
    [[ "$(systemctl show -p MainPID --value mediamtx.service)" == "$mediamtx_pid" ]] \
      || fail "MediaMTX PID changed"
    [[ "$(systemctl show -p MainPID --value homecam-detect.service)" == "$detect_pid" ]] \
      || fail "detection PID changed"
    systemctl is-active --quiet mediamtx.service homecam-detect.service \
      || fail "camera service became inactive"
    timeout 8 ffprobe -v error -rtsp_transport tcp -select_streams v:0 \
      -show_entries stream=codec_name -of csv=p=0 \
      rtsp://127.0.0.1:8554/cam >/dev/null || fail "camera publisher absent after recovery"
    echo "server recovered; camera publisher and worker PIDs remained unchanged"'
}

disk() {
  show "[disk floor] run deterministic retention/disk-floor tests (never fills production storage)"
  run python3 -m pytest -q detection/tests/test_disk_floor.py server/tests/harness_retention
}

session() {
  show "[session revoke] exercise revoke/current-session behavior against an isolated test database"
  run bash -lc "cd server && python3 -m pytest -q tests/test_sessions_revocation.py tests/test_sessions_routes.py"
}

media() {
  show "[MediaMTX restart] restart gateway and verify server health plus watchdog recovery tests"
  run sudo systemctl restart mediamtx.service
  run curl --fail --retry 12 --retry-delay 1 "$BASE_URL/healthz"
  run python3 -m pytest -q detection/tests/test_mediamtx_watchdog.py detection/tests/test_capture_recovery.py
}

if [[ "$CASE" == "all" ]]; then server; disk; session; media; else "$CASE"; fi
