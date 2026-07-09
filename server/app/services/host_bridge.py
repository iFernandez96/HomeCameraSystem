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


def peek(now: float, *, max_pending_age_s: float) -> dict | None:
    """Return a non-stale pending record, expiring stale pending records."""
    global _current
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
