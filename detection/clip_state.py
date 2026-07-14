"""Small on-disk clip-state ledger shared with the FastAPI container.

The detection worker runs on the Jetson host while the API server runs in a
container. Both see ``recordings_dir``. This JSON file is the narrow bridge that
lets the server distinguish "still recording" from "finalizing" from "failed"
when a clip endpoint currently has no MP4 to serve.

Python 3.6 compatible.
"""
import json
import math
import os
import tempfile
import time


LEDGER_NAME = ".clip_state.json"
_MAX_EVENTS = 5000
STALE_ACTIVE_AFTER_S = 15 * 60
_ETA_MIN_SAMPLES = 8
_ETA_NEIGHBORS = 20


def ledger_path(recordings_dir):
    return os.path.join(str(recordings_dir), LEDGER_NAME)


def _read(path):
    try:
        with open(path, "r") as f:
            data = json.load(f)
    except (IOError, OSError, ValueError):
        return {"v": 1, "events": {}}
    if not isinstance(data, dict):
        return {"v": 1, "events": {}}
    events = data.get("events")
    if not isinstance(events, dict):
        events = {}
    return {"v": 1, "events": events}


def _atomic_write(path, data):
    directory = os.path.dirname(path)
    try:
        os.makedirs(directory, exist_ok=True)
    except OSError:
        return False
    fd = None
    tmp = None
    try:
        fd, tmp = tempfile.mkstemp(prefix=".clip_state.", suffix=".tmp", dir=directory)
        with os.fdopen(fd, "w") as f:
            fd = None
            json.dump(data, f, sort_keys=True, separators=(",", ":"))
            f.flush()
            os.fsync(f.fileno())
        # Same-directory POSIX rename is atomic and avoids interfering with
        # recording.finalize_visit tests that mock os.replace specifically to
        # pin MP4 publish ordering.
        os.rename(tmp, path)
        tmp = None
        try:
            dir_fd = os.open(directory, os.O_DIRECTORY)
            try:
                os.fsync(dir_fd)
            finally:
                os.close(dir_fd)
        except OSError:
            pass
        return True
    except (IOError, OSError):
        return False
    finally:
        if fd is not None:
            try:
                os.close(fd)
            except OSError:
                pass
        if tmp:
            try:
                os.remove(tmp)
            except OSError:
                pass


def set_state(recordings_dir, event_id, state, **fields):
    """Upsert one event's clip state.

    Returns True when the ledger write succeeds. Fail-quiet by design: clip
    recording must never fail because observability storage is temporarily
    unavailable.
    """
    if not event_id:
        return False
    path = ledger_path(recordings_dir)
    data = _read(path)
    events = data["events"]
    rec = dict(events.get(str(event_id)) or {})
    rec["event_id"] = str(event_id)
    rec["state"] = str(state)
    rec["updated_ts"] = time.time()
    for key, value in fields.items():
        if value is not None:
            rec[key] = value
    events[str(event_id)] = rec
    if len(events) > _MAX_EVENTS:
        ordered = sorted(
            events.items(),
            key=lambda item: float((item[1] or {}).get("updated_ts") or 0),
        )
        for key, _value in ordered[:len(events) - _MAX_EVENTS]:
            events.pop(key, None)
    return _atomic_write(path, data)


def get_state(recordings_dir, event_id):
    return _read(ledger_path(recordings_dir))["events"].get(str(event_id))


def _percentile(values, fraction):
    ordered = sorted(float(value) for value in values)
    if not ordered:
        return None
    position = (len(ordered) - 1) * float(fraction)
    lower = int(position)
    upper = min(lower + 1, len(ordered) - 1)
    return ordered[lower] + (ordered[upper] - ordered[lower]) * (
        position - lower
    )


def _eta_history(recordings_dir):
    """Successful device-local timing samples; no media or identity data."""
    samples = []
    events = _read(ledger_path(recordings_dir))["events"]
    for rec in events.values():
        if not isinstance(rec, dict) or rec.get("state") != "available":
            continue
        try:
            start_ts = float(rec["start_ts"])
            end_ts = float(rec["end_ts"])
            ready_ts = float(rec["updated_ts"])
            size_bytes = float(rec.get("bytes") or 0)
        except (KeyError, TypeError, ValueError):
            continue
        capture_s = end_ts - start_ts
        processing_s = ready_ts - end_ts
        if capture_s <= 0 or processing_s < 0:
            continue
        samples.append({
            "capture_s": capture_s,
            "processing_s": processing_s,
            "access_s": ready_ts - start_ts,
            "bytes": max(0.0, size_bytes),
            "ready_ts": ready_ts,
        })
    return samples


def _eta_result(origin_ts, totals, now_ts):
    if len(totals) < _ETA_MIN_SAMPLES:
        return None
    point_s = _percentile(totals, 0.5)
    low_s = _percentile(totals, 0.1)
    high_s = _percentile(totals, 0.9)
    deviations = [abs(value - point_s) for value in totals]
    historical_spread_s = _percentile(deviations, 0.5)
    point_ts = max(float(now_ts) + 1.0, float(origin_ts) + point_s)
    min_ts = max(float(now_ts), float(origin_ts) + low_s)
    max_ts = max(point_ts, float(origin_ts) + high_s)
    return {
        "eta_point_ts": point_ts,
        "eta_min_ts": min(min_ts, point_ts),
        "eta_max_ts": max_ts,
        "eta_model_samples": len(totals),
        "eta_historical_spread_s": historical_spread_s,
        "eta_model": "device_history_v1",
    }


def estimate_recording_eta(recordings_dir, start_ts, last_seen,
                           absence_finalize_s, max_visit_s, now=None):
    """Estimate event-to-playable time while capture is still open.

    This is a conditional time-to-event estimate: completed visits shorter
    than the already-observed visit plus its absence grace cannot describe the
    active visit, so they are excluded. The live max-visit bound excludes old
    samples produced under a longer historical configuration.
    """
    current = time.time() if now is None else float(now)
    try:
        start = float(start_ts)
        seen = float(last_seen)
        absence = max(0.0, float(absence_finalize_s))
        maximum = max(1.0, float(max_visit_s))
    except (TypeError, ValueError):
        return None
    minimum_capture = min(maximum, max(0.0, seen - start) + absence)
    history = sorted(
        (
            sample for sample in _eta_history(recordings_dir)
            if sample["capture_s"] <= maximum * 1.10
        ),
        key=lambda sample: sample["ready_ts"],
    )[-80:]
    eligible = [
        sample for sample in history
        if sample["capture_s"] >= minimum_capture * 0.90
    ]
    if len(eligible) < _ETA_MIN_SAMPLES:
        eligible = sorted(
            history,
            key=lambda sample: abs(sample["capture_s"] - minimum_capture),
        )[:_ETA_NEIGHBORS]
    totals = [sample["access_s"] for sample in eligible]
    return _eta_result(start, totals, current)


def estimate_finalizing_eta(recordings_dir, end_ts, capture_duration_s,
                            input_bytes, now=None):
    """Estimate ready time from similar completed finalization workloads."""
    current = time.time() if now is None else float(now)
    try:
        end = float(end_ts)
        duration = max(0.1, float(capture_duration_s))
        size = max(1.0, float(input_bytes))
    except (TypeError, ValueError):
        return None
    elapsed = max(0.0, current - end)
    history = sorted(
        _eta_history(recordings_dir), key=lambda sample: sample["ready_ts"],
    )[-80:]
    if len(history) < _ETA_MIN_SAMPLES:
        return None

    def distance(sample):
        # Ratio distance is scale-free across short and long clips. Duration
        # and bytes both matter because decode work and I/O vary independently.
        sample_size = max(1.0, sample["bytes"])
        return (
            abs(math.log(sample["capture_s"] / duration))
            + abs(math.log(sample_size / size))
        )

    nearest = sorted(history, key=distance)
    # Conditional remaining-time estimate: once processing has already lasted
    # N seconds, samples that completed before N are no longer possible.
    survivors = [
        sample for sample in nearest
        if sample["processing_s"] >= elapsed
    ]
    peers = (survivors if len(survivors) >= _ETA_MIN_SAMPLES else nearest)[
        :_ETA_NEIGHBORS
    ]
    totals = [sample["processing_s"] for sample in peers]
    result = _eta_result(end, totals, current)
    if result is not None:
        errors = []
        # Walk-forward validation uses only observations that existed before
        # each target, which measures live forecasting rather than easier
        # random holdout performance under configuration drift.
        for index in range(20, len(history)):
            target = history[index]
            prior = history[:index]
            target_duration = target["capture_s"]
            target_size = max(1.0, target["bytes"])
            comparable = sorted(
                prior,
                key=lambda sample: (
                    abs(math.log(sample["capture_s"] / target_duration))
                    + abs(math.log(max(1.0, sample["bytes"]) / target_size))
                ),
            )[:16]
            predicted = _percentile(
                [sample["processing_s"] for sample in comparable], 0.5,
            )
            errors.append(abs(predicted - target["processing_s"]))
        if errors:
            result["eta_backtest_median_error_s"] = _percentile(errors, 0.5)
            result["eta_backtest_p90_error_s"] = _percentile(errors, 0.9)
    return result


def reconcile_stale(recordings_dir, now=None, stale_after_s=STALE_ACTIVE_AFTER_S):
    """Turn abandoned recording/finalizing rows into honest failures.

    A worker restart can happen after the visit was removed from the open-visit
    journal but before ffmpeg publishes the MP4.  Those rows otherwise remain
    "loading" forever.  A real MP4 always wins and is marked available.

    Returns the number of rows changed.  Python 3.6 compatible.
    """
    path = ledger_path(recordings_dir)
    data = _read(path)
    events = data["events"]
    current = time.time() if now is None else float(now)
    changed = 0
    for event_id, original in list(events.items()):
        if not isinstance(original, dict):
            continue
        state = original.get("state")
        if state not in ("recording", "finalizing"):
            continue
        final_path = os.path.join(str(recordings_dir), "{}.mp4".format(event_id))
        try:
            playable_file = os.path.isfile(final_path) and os.path.getsize(final_path) > 0
        except OSError:
            playable_file = False
        if playable_file:
            rec = dict(original)
            rec.update({
                "state": "available",
                "updated_ts": current,
            })
            try:
                rec["bytes"] = os.path.getsize(final_path)
            except OSError:
                pass
        else:
            try:
                age = current - float(original.get("updated_ts") or 0)
            except (TypeError, ValueError):
                age = stale_after_s + 1
            if age < float(stale_after_s):
                continue
            rec = dict(original)
            rec.update({
                "state": "failed",
                "updated_ts": current,
                "failure_code": "worker_restarted",
                "failure_stage": state,
                "failure_summary": "Video processing was interrupted.",
                "failure_detail": (
                    "The camera worker restarted before it could finish and "
                    "publish this event's video. No playable video file was left."
                ),
                "retryable": False,
            })
        events[str(event_id)] = rec
        changed += 1
    if changed:
        _atomic_write(path, data)
    return changed
