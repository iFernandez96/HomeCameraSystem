#!/usr/bin/env bash
# codex-guard.sh — run a codex exec (or any command) under a stall watchdog.
#
# The failure mode this kills: codex exec occasionally hangs at startup —
# process alive, zero CPU, no session log, no output, forever (seen 2026-07-08,
# step P1: 24 min, 0:00 CPU). A hung step silently stalls the whole proof
# program until a human notices.
#
# Liveness = (output file grew) OR (process-group CPU time advanced). If
# neither changes for CODEX_STALL_SECS, the whole process group is killed and
# the command is retried, up to CODEX_ATTEMPTS times total.
#
# Usage: codex-guard.sh <logfile> <command...>
#   CODEX_STALL_SECS  seconds of no-progress before kill (default 300)
#   CODEX_ATTEMPTS    total attempts including the first (default 3)
#   CODEX_POLL_SECS   watchdog poll interval (default 15)
#
# Exit: the command's exit code, or 97 if every attempt stalled.
set -u

LOG=${1:?usage: codex-guard.sh <logfile> <command...>}; shift
[ $# -ge 1 ] || { echo "codex-guard: no command given" >&2; exit 2; }
STALL_LIMIT=${CODEX_STALL_SECS:-300}
MAX_ATTEMPTS=${CODEX_ATTEMPTS:-3}
POLL=${CODEX_POLL_SECS:-15}

# Sum utime+stime (clock ticks) across the process group so work done by
# codex's vendor binary / sandboxed children counts as liveness.
group_cpu() {
  local pgid=$1 total=0 p rest
  for p in $(pgrep -g "$pgid" 2>/dev/null); do
    rest=$(cut -d')' -f2- "/proc/$p/stat" 2>/dev/null) || continue
    # shellcheck disable=SC2086
    set -- $rest
    total=$((total + ${12:-0} + ${13:-0}))
  done
  echo "$total"
}

attempt=0
while [ "$attempt" -lt "$MAX_ATTEMPTS" ]; do
  attempt=$((attempt + 1))
  echo "[codex-guard] attempt $attempt/$MAX_ATTEMPTS: $*" >>"$LOG"

  setsid "$@" >>"$LOG" 2>&1 &
  pid=$!
  stalled=0
  last_sig=""
  progress_ts=$(date +%s)

  while kill -0 "$pid" 2>/dev/null; do
    sleep "$POLL"
    sig="$(stat -c %s "$LOG" 2>/dev/null || echo 0):$(group_cpu "$pid")"
    now=$(date +%s)
    if [ "$sig" != "$last_sig" ]; then
      last_sig=$sig
      progress_ts=$now
    elif [ $((now - progress_ts)) -ge "$STALL_LIMIT" ]; then
      echo "[codex-guard] STALL: no output and no CPU for ${STALL_LIMIT}s — killing pgid $pid (attempt $attempt)" >>"$LOG"
      kill -9 -- "-$pid" 2>/dev/null
      stalled=1
      break
    fi
  done

  wait "$pid" 2>/dev/null
  rc=$?
  if [ "$stalled" -eq 0 ]; then
    echo "[codex-guard] attempt $attempt finished rc=$rc" >>"$LOG"
    exit "$rc"
  fi
done

echo "[codex-guard] FAILED: all $MAX_ATTEMPTS attempts stalled" >>"$LOG"
echo "[codex-guard] FAILED: all $MAX_ATTEMPTS attempts stalled (see $LOG)" >&2
exit 97
