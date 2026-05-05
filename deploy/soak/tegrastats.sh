#!/usr/bin/env bash
# Wrapper around tegrastats. Writes one line per second to <logfile> and
# the PID to <pidfile>. Backgrounded; the parent run_scenario.sh kills it.
#
# Usage: tegrastats.sh <logfile> <pidfile>
set -eu

LOGFILE="${1:?logfile required}"
PIDFILE="${2:?pidfile required}"

# tegrastats supports --interval (ms). 1000 ms is fine for soak; more
# frequent samples blow up file size without adding signal.
tegrastats --interval 1000 --logfile "$LOGFILE" &
echo $! > "$PIDFILE"
