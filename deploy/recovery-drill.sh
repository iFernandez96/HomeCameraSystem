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
  show "[server restart] interrupt API, restart it, then require health recovery"
  run sudo systemctl restart homecam-server.service
  run curl --fail --retry 12 --retry-delay 1 "$BASE_URL/healthz"
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
