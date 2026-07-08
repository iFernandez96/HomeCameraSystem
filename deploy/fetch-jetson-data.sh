#!/usr/bin/env bash
# Pull a READ-ONLY snapshot of real production data off the Jetson for OFFLINE
# analysis — so "confirm with real data" never blocks on the Jetson being up.
#
# Principle (memory: feedback-dev-offline-when-jetson-off): the Jetson is often
# powered off. When a change needs validating against REAL data (events,
# clips, logs), DON'T block — run this whenever the Jetson is on, then analyze
# the snapshot locally afterward. The snapshot lives in ./.jetson-snapshot/
# (gitignored) and is the input for offline analysis + gated real-data tests.
#
# READ-ONLY on the Jetson: only SELECT/cat/journalctl/ls/scp-from. NEVER pulls
# secrets (jwt_secret, VAPID PEMs, push_subs.json device endpoints). The
# events.db is captured as a portable SQL dump via python's iterdump (no
# sqlite3 CLI needed in the container, and consistent against a live DB).
#
# Usage: deploy/fetch-jetson-data.sh [host] [clip_count] [log_days]
#   host        ssh host (default: jetson; use 'homecam' for Tailscale off-LAN)
#   clip_count  most-recent .mp4 clips to pull (default: 8; 0 = none)
#   log_days    journald lookback in days (default: 3)
set -euo pipefail

HOST="${1:-jetson}"
CLIP_COUNT="${2:-8}"
LOG_DAYS="${3:-3}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/.jetson-snapshot"
REC_DIR="/home/israel/HomeCameraSystem/recordings"
DB_IN_CONTAINER="/app/secrets/events.db"

# --- preflight: don't hang if the box is off ------------------------------
if ! ssh -o ConnectTimeout=8 -o BatchMode=yes "$HOST" true 2>/dev/null; then
  echo "ERROR: '$HOST' unreachable (Jetson off, or off-LAN)." >&2
  echo "  Power on the Jetson, then re-run. Off the home LAN, pass the" >&2
  echo "  Tailscale alias:  deploy/fetch-jetson-data.sh homecam" >&2
  exit 1
fi

mkdir -p "$OUT/db" "$OUT/clips" "$OUT/logs" "$OUT/config"

echo "==> events.db → SQL dump (consistent, secret-free)"
# python iterdump: no sqlite3 CLI needed in the container; safe on a live DB.
ssh "$HOST" "sudo docker exec homecam-server python3 -c \"import sqlite3,sys; con=sqlite3.connect('file:${DB_IN_CONTAINER}?mode=ro', uri=True); sys.stdout.write('\n'.join(con.iterdump()))\"" \
  > "$OUT/db/events.dump.sql"
echo "    $(wc -l < "$OUT/db/events.dump.sql") SQL lines"
# Rebuild a queryable local sqlite if the dev box has the CLI (optional).
if command -v sqlite3 >/dev/null 2>&1; then
  rm -f "$OUT/db/events.sqlite"
  sqlite3 "$OUT/db/events.sqlite" < "$OUT/db/events.dump.sql" \
    && echo "    rebuilt $OUT/db/events.sqlite"
else
  echo "    (no local sqlite3 CLI — load the .sql dump in python instead)"
fi

echo "==> recent clips (most-recent ${CLIP_COUNT} .mp4)"
if [ "${CLIP_COUNT}" -gt 0 ]; then
  # `ls -1t` newest-first; head bounds the size. -- guards odd names.
  mapfile -t FILES < <(ssh "$HOST" "ls -1t ${REC_DIR}/*.mp4 2>/dev/null | head -n ${CLIP_COUNT}") || true
  for f in "${FILES[@]:-}"; do
    [ -z "$f" ] && continue
    base="$(basename "$f")"
    if scp -q "$HOST:$f" "$OUT/clips/$base"; then echo "    $base"; fi
  done
fi

echo "==> journald (last ${LOG_DAYS}d)"
for unit in homecam-detect mediamtx homecam-server nvargus-daemon; do
  ssh "$HOST" "sudo journalctl -u ${unit} --since '-${LOG_DAYS} days' --no-pager 2>/dev/null" \
    > "$OUT/logs/${unit}.log" 2>/dev/null || true
done
ssh "$HOST" "sudo docker logs homecam-server --since ${LOG_DAYS}d 2>&1" \
  > "$OUT/logs/homecam-server-app.log" 2>/dev/null || true

echo "==> config (no secrets)"
ssh "$HOST" "sudo docker exec homecam-server cat ${DB_IN_CONTAINER%/*}/detection_config.json 2>/dev/null" \
  > "$OUT/config/detection_config.json" 2>/dev/null || true
ssh "$HOST" "cat ${REC_DIR}/.watchdog_state.json 2>/dev/null" \
  > "$OUT/config/watchdog_state.json" 2>/dev/null || true

{
  echo "host=$HOST"
  echo "fetched_unix=$(date -u +%s 2>/dev/null || echo 0)"
  echo "clips=${CLIP_COUNT} log_days=${LOG_DAYS}"
} > "$OUT/SNAPSHOT_INFO"

# Drop empty files so absence is unambiguous to downstream tooling/tests.
find "$OUT" -type f -empty -delete 2>/dev/null || true

echo "==> done → $OUT (gitignored). Analyze offline; real-data tests skip until present."
