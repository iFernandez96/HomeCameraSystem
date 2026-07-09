"""Persisted in-process host-action request state machine."""
from __future__ import annotations

import copy
import json
import logging
import os
import uuid
from pathlib import Path

from ..config import settings


log = logging.getLogger(__name__)


TERMINAL_STATUSES = {"done", "failed", "expired"}
ACTIVE_STATUSES = {"pending", "running"}
HISTORY_LIMIT = 20
# A record that the worker CLAIMED (pending -> running) but never posted a
# result for within this window is orphaned — the worker almost certainly died
# mid-action (a recovery rung that restarts mediamtx/nvargus can get the worker
# itself restarted; observed live 2026-07-09). Real actions finish in <30s
# (nvargus restart ~30s is the slowest). Without expiry the stuck `running`
# record jammed EVERY future enqueue (recovery + logs) until a manual reset.
DEFAULT_MAX_RUNNING_AGE_S = 120.0

_current = None
_history = []
_state_path: Path | None = None


def _path() -> Path:
    return _state_path or settings.host_action_state_path


def reset_for_tests(path: Path | None = None) -> None:
    global _current, _history, _state_path
    _current = None
    _history = []
    _state_path = path


def load(path: Path | None = None) -> None:
    """Best-effort sidecar restore. Corrupt/missing state starts empty."""
    global _current, _history, _state_path
    if path is not None:
        _state_path = path
    try:
        with _path().open("r", encoding="utf-8") as f:
            data = json.load(f)
        current = data.get("current")
        history = data.get("history")
        _current = current if isinstance(current, dict) else None
        _history = history[:HISTORY_LIMIT] if isinstance(history, list) else []
    except (OSError, ValueError, TypeError) as exc:
        if not isinstance(exc, FileNotFoundError):
            log.warning("host_bridge: state load failed from %s: %s", _path(), exc)
        _current = None
        _history = []


def enqueue(
    kind: str,
    args: dict,
    requested_by: str,
    *,
    now: float,
    max_pending_age_s: float = 120.0,
    max_running_age_s: float = DEFAULT_MAX_RUNNING_AGE_S,
) -> dict:
    """Create a pending record unless a live pending/running record exists."""
    global _current
    if _current is not None and _current.get("status") == "pending":
        if _is_stale(_current, now, max_pending_age_s):
            _current["status"] = "expired"
            _current["detail"] = "expired before replacement"
            _current["result_at"] = float(now)
            _push_history(_current)
            _persist()
        else:
            return copy.deepcopy(_current)
    if _current is not None and _current.get("status") == "running":
        # A stuck `running` record = worker died between claim and result.
        # Expire it so a new request isn't blocked forever; otherwise honor
        # the in-flight action (don't double-fire a recovery).
        if not _expire_running_if_stale(now, max_running_age_s):
            return copy.deepcopy(_current)

    _current = {
        "id": uuid.uuid4().hex,
        "kind": kind,
        "args": copy.deepcopy(args or {}),
        "requested_by": requested_by,
        "requested_at": float(now),
        "status": "pending",
        "detail": None,
        "result": None,
        "claimed_at": None,
        "result_at": None,
    }
    _persist()
    return copy.deepcopy(_current)


def peek(
    now: float,
    *,
    max_pending_age_s: float,
    max_running_age_s: float = DEFAULT_MAX_RUNNING_AGE_S,
) -> dict | None:
    """Return a non-stale pending record, expiring stale pending records.

    Also self-heals an orphaned `running` record (worker claimed but died
    before posting a result): the worker polls this every few seconds, so an
    orphan is expired within `max_running_age_s` even without a new enqueue,
    and the status route stops reporting a phantom `running`."""
    global _current
    _expire_running_if_stale(now, max_running_age_s)
    if _current is None or _current.get("status") != "pending":
        return None
    if _is_stale(_current, now, max_pending_age_s):
        _current["status"] = "expired"
        _current["detail"] = "expired before worker claim"
        _current["result_at"] = float(now)
        _push_history(_current)
        _persist()
        return None
    return copy.deepcopy(_current)


def claim(record_id: str, now: float) -> str:
    """Compare-and-set pending -> running for the matching id."""
    global _current
    if _current is None or _current.get("id") != record_id:
        return "unknown"
    if _current.get("status") != "pending":
        return "conflict"
    _current["status"] = "running"
    _current["claimed_at"] = float(now)
    _persist()
    return "claimed"


def record_result(
    record_id: str,
    status: str,
    detail: str | None,
    result: dict | None,
    now: float,
) -> bool:
    """Set a terminal result on the matching running/pending record."""
    global _current
    if status not in ("done", "failed"):
        raise ValueError("status must be 'done' or 'failed'")
    if _current is None or _current.get("id") != record_id:
        return False
    if _current.get("status") not in ("running", "pending"):
        return False
    _current["status"] = status
    _current["detail"] = detail
    _current["result"] = copy.deepcopy(result)
    _current["result_at"] = float(now)
    _push_history(_current)
    _persist()
    return True


def get(record_id: str) -> dict | None:
    if _current is not None and _current.get("id") == record_id:
        return copy.deepcopy(_current)
    for rec in _history:
        if rec.get("id") == record_id:
            return copy.deepcopy(rec)
    return None


def latest() -> dict | None:
    if _current is not None:
        return copy.deepcopy(_current)
    if _history:
        return copy.deepcopy(_history[0])
    return None


def history() -> list[dict]:
    return copy.deepcopy(_history)


def _is_stale(record: dict, now: float, max_pending_age_s: float) -> bool:
    try:
        age = float(now) - float(record.get("requested_at"))
    except (TypeError, ValueError):
        return True
    return age > float(max_pending_age_s)


def _running_stale(record: dict, now: float, max_running_age_s: float) -> bool:
    """A `running` record is orphaned if it was claimed longer than
    `max_running_age_s` ago without a terminal result. Age is measured from
    `claimed_at` (when it went running); falls back to `requested_at` if the
    claim timestamp is missing/corrupt."""
    ref = record.get("claimed_at")
    if ref is None:
        ref = record.get("requested_at")
    try:
        age = float(now) - float(ref)
    except (TypeError, ValueError):
        return True
    return age > float(max_running_age_s)


def _expire_running_if_stale(now: float, max_running_age_s: float) -> bool:
    """Expire + archive the current record if it's a stale `running` (worker
    claimed but never reported — almost certainly died mid-action). Returns
    True if it expired, so callers can proceed as if the slot were free."""
    global _current
    if _current is None or _current.get("status") != "running":
        return False
    if not _running_stale(_current, now, max_running_age_s):
        return False
    _current["status"] = "expired"
    _current["detail"] = (
        "expired: worker claimed but never reported a result "
        "(likely died mid-action)"
    )
    _current["result_at"] = float(now)
    _push_history(_current)
    _persist()
    return True


def _push_history(record: dict) -> None:
    global _history
    copied = copy.deepcopy(record)
    _history = [r for r in _history if r.get("id") != copied.get("id")]
    _history.insert(0, copied)
    del _history[HISTORY_LIMIT:]


def _persist() -> None:
    path = _path()
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(path.name + ".tmp")
        with tmp.open("w", encoding="utf-8") as f:
            json.dump({"current": _current, "history": _history}, f)
        try:
            os.chmod(tmp, 0o600)
        except OSError:
            pass
        os.replace(tmp, path)
        try:
            os.chmod(path, 0o600)
        except OSError:
            pass
    except OSError:
        log.exception("host_bridge: state persist failed at %s", path)
