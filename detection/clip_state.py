"""Small on-disk clip-state ledger shared with the FastAPI container.

The detection worker runs on the Jetson host while the API server runs in a
container. Both see ``recordings_dir``. This JSON file is the narrow bridge that
lets the server distinguish "still recording" from "finalizing" from "failed"
when a clip endpoint currently has no MP4 to serve.

Python 3.6 compatible.
"""
import json
import os
import tempfile
import time


LEDGER_NAME = ".clip_state.json"
_MAX_EVENTS = 5000
STALE_ACTIVE_AFTER_S = 15 * 60


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
        if os.path.isfile(final_path):
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
