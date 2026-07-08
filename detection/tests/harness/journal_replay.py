"""Parse a captured journald log into a presence/absence replay timeline.

Dev-only test infrastructure (detection/tests/harness/ — exempt from the
py36 AST guard, which excludes tests/). Turns the REAL journal captured from
the production Jetson (.jetson-snapshot/continuous_capture_fixtures/
journal_tonight.log) plus the night's REAL event rows into the input a
``VisitRunner`` replay needs: a sorted list of detection instants (epoch
seconds) with everything between them being absent frames (ticks).

Presence evidence used (honest signals only — we never fabricate presence):
  * ``gear idle -> active: recent detection`` — a detection fired right then.
  * ``[detect] <label> score=...`` emit lines — a detection fired right then.
  * ``gear active -> idle: no recent detections`` at T — the LAST detection
    was ~``idle_after_s`` before T (detect.py's active-gear keepalive).
  * event rows' ``ts`` (the POSTed detections themselves).

Capture-error lines ("videoSource failed to capture image") are frames with
no image at all — for the visit state machine they are indistinguishable
from absent frames, so they need no special handling beyond ticks; we still
expose them for diagnostics. Worker restarts (journald pid changes) and the
continuous-capture ARMED lines are exposed so scenarios can anchor on them.
"""
import datetime
import json
import re

_MONTHS = {
    "Jan": 1, "Feb": 2, "Mar": 3, "Apr": 4, "May": 5, "Jun": 6,
    "Jul": 7, "Aug": 8, "Sep": 9, "Oct": 10, "Nov": 11, "Dec": 12,
}

_TS_RE = re.compile(r"^(\w{3}) +(\d+) (\d\d):(\d\d):(\d\d) ")
_PID_RE = re.compile(r"run-detect\.sh\[(\d+)\]")
_SCORE_RE = re.compile(r"\[detect\] \w+ score=")
_ARMED_RE = re.compile(
    r"continuous-capture ARMED \(max_visit=([\d.]+)s, "
    r"absence_finalize=([\d.]+)s\)"
)
_RETRY_RE = re.compile(
    r"recovery: finalize of visit (\w+) produced no clip"
)
_SCRATCH_MISSING_RE = re.compile(
    r"finalize: scratch_dir unreadable for event_id=(\w+)"
)

# detect.py default: DETECT_IDLE_AFTER_S = 15.0 — the active->idle gear
# transition happens this long after the last detection.
DEFAULT_IDLE_AFTER_S = 15.0


def _line_ts(line, year):
    m = _TS_RE.match(line)
    if m is None:
        return None
    dt = datetime.datetime(
        year, _MONTHS[m.group(1)], int(m.group(2)),
        int(m.group(3)), int(m.group(4)), int(m.group(5)),
    )
    return dt.timestamp()


def parse_journal(path, year=2026, idle_after_s=DEFAULT_IDLE_AFTER_S):
    """Parse the journal into a dict of timeline evidence (all epoch secs):

    {
      "t0", "t1":            journal window bounds,
      "detection_instants":  sorted detection-evidence times,
      "capture_error_ts":    times of capture-error lines,
      "pids":                ordered distinct worker pids (restart chain),
      "armed":               [(ts, max_visit_s, absence_finalize_s), ...],
      "recovery_retry_ids":  visit ids that recovery left FINALIZING,
      "scratch_missing_ids": event ids whose finalize found no scratch dir,
    }
    """
    t0 = None
    t1 = None
    instants = []
    capture_errors = []
    pids = []
    armed = []
    retry_ids = []
    scratch_missing = []
    with open(path, errors="replace") as f:
        for line in f:
            ts = _line_ts(line, year)
            if ts is None:
                continue
            if t0 is None:
                t0 = ts
            t1 = ts
            pm = _PID_RE.search(line)
            if pm is not None:
                pid = int(pm.group(1))
                if not pids or pids[-1] != pid:
                    pids.append(pid)
            if "gear idle -> active" in line:
                instants.append(ts)
            elif "gear active -> idle" in line:
                # The keepalive holds active gear idle_after_s past the last
                # detection, so the last detection was ~that long before.
                instants.append(ts - idle_after_s)
            elif _SCORE_RE.search(line):
                instants.append(ts)
            elif "videoSource failed to capture image" in line:
                capture_errors.append(ts)
            am = _ARMED_RE.search(line)
            if am is not None:
                armed.append((ts, float(am.group(1)), float(am.group(2))))
            rm = _RETRY_RE.search(line)
            if rm is not None:
                retry_ids.append(rm.group(1))
            sm = _SCRATCH_MISSING_RE.search(line)
            if sm is not None:
                scratch_missing.append(sm.group(1))
    return {
        "t0": t0,
        "t1": t1,
        "detection_instants": sorted(instants),
        "capture_error_ts": capture_errors,
        "pids": pids,
        "armed": armed,
        "recovery_retry_ids": retry_ids,
        "scratch_missing_ids": scratch_missing,
    }


def load_event_instants(events_json_path, t0, t1):
    """Detection instants from the night's REAL event rows, limited to the
    journal window (the rows file spans more of the day)."""
    with open(events_json_path) as f:
        rows = json.load(f)
    return sorted(
        r["ts"] for r in rows
        if isinstance(r.get("ts"), (int, float)) and t0 <= r["ts"] <= t1
    )


def presence_timeline(parsed, event_instants, resolution=0.1):
    """Merge journal + event evidence into one deduplicated sorted list of
    presence instants (rounded to ``resolution`` so near-simultaneous
    evidence collapses to a single observe)."""
    merged = set()
    for t in list(parsed["detection_instants"]) + list(event_instants):
        merged.add(round(t / resolution) * resolution)
    return sorted(merged)


def expected_visit_count(instants, absence_finalize_s):
    """Pure gap math: how many visits a given absence grace yields for this
    instant list (each gap > grace starts a new visit). This is the ORACLE
    the replay's fresh-visit count is checked against, and the data behind
    the knob recommendation."""
    if not instants:
        return 0
    n = 1
    for a, b in zip(instants, instants[1:]):
        if (b - a) > absence_finalize_s:
            n += 1
    return n


def gap_histogram(instants):
    """Sorted inter-detection gaps (seconds) — the raw data for choosing
    ``absence_finalize_s``."""
    return sorted(
        round(b - a, 1) for a, b in zip(instants, instants[1:])
    )
