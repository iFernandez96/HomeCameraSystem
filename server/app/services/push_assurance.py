"""Cryptographically correlated Web Push receipt tracking.

Gateway acceptance is not proof that Android displayed a notification. Each
delivery gets a short-lived random receipt capability. The service worker posts
that capability only after ``showNotification`` resolves. Raw push endpoints
and receipt capabilities are never persisted or logged.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import secrets
import threading
import time
from pathlib import Path
from typing import Any

from ..config import settings
from ..log import RateLimitedLog


_TOKEN_TTL_S = 3600.0
_RECENT_S = 24 * 3600.0
_MAX_PENDING = 2048
_lock = threading.Lock()
_pending: dict[str, dict[str, Any]] = {}
log = logging.getLogger(__name__)
_inbox_failure_gate = RateLimitedLog(300.0)


def _device_id(sub: dict[str, Any]) -> str:
    endpoint = sub.get("endpoint")
    if not isinstance(endpoint, str):
        endpoint = ""
    return hashlib.sha256(endpoint.encode("utf-8", "replace")).hexdigest()[:24]


def _read(path: Path | None = None) -> dict[str, Any]:
    source = path or settings.push_assurance_path
    try:
        value = json.loads(source.read_text())
    except (OSError, ValueError, TypeError):
        return {"v": 1, "devices": {}}
    if not isinstance(value, dict):
        return {"v": 1, "devices": {}}
    devices = value.get("devices")
    if value.get("v") != 1 or not isinstance(devices, dict):
        return {"v": 1, "devices": {}}
    return {"v": 1, "devices": devices}


def _write(value: dict[str, Any], path: Path | None = None) -> None:
    target = path or settings.push_assurance_path
    target.parent.mkdir(parents=True, exist_ok=True)
    temp = target.with_suffix(target.suffix + ".tmp")
    try:
        with temp.open("w") as handle:
            json.dump(value, handle, separators=(",", ":"), sort_keys=True)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temp, 0o600)
        os.replace(temp, target)
    except Exception:
        try:
            temp.unlink()
        except OSError:
            pass
        raise


def _prune_pending(now: float) -> None:
    expired = [token for token, row in _pending.items() if now - row["sent_at"] > _TOKEN_TTL_S]
    for token in expired:
        _pending.pop(token, None)
    if len(_pending) > _MAX_PENDING:
        oldest = sorted(_pending, key=lambda token: _pending[token]["sent_at"])
        for token in oldest[: len(_pending) - _MAX_PENDING]:
            _pending.pop(token, None)


def issue(
    sub: dict[str, Any],
    now: float | None = None,
    notification_id: str | None = None,
) -> str:
    now = time.time() if now is None else now
    token = secrets.token_urlsafe(24)
    with _lock:
        _prune_pending(now)
        _pending[token] = {
            "device_id": _device_id(sub),
            "user_id": sub.get("user_id") if isinstance(sub.get("user_id"), str) else None,
            "sent_at": now,
            "notification_id": notification_id,
        }
    return token


def cancel(token: str) -> None:
    with _lock:
        _pending.pop(token, None)


def accept(token: str, shown: bool, now: float | None = None, path: Path | None = None) -> bool:
    now = time.time() if now is None else now
    with _lock:
        _prune_pending(now)
        row = _pending.pop(token, None)
    if row is None:
        return False
    value = _read(path)
    devices = value["devices"]
    devices[row["device_id"]] = {
        "user_id": row["user_id"],
        "sent_at": row["sent_at"],
        "received_at": now,
        "shown": bool(shown),
    }
    _write(value, path)
    try:
        from . import operations
        operations.mark_displayed(
            row.get("notification_id"), row.get("user_id"), bool(shown), now
        )
    except Exception:
        # Receipt durability is primary; inbox enrichment must not turn a
        # valid one-use receipt into an apparent failure/replay opportunity.
        if _inbox_failure_gate.should_log():
            log.exception("push receipt saved but notification inbox update failed")
    return True


def status(subs: list[dict[str, Any]], now: float | None = None, path: Path | None = None) -> dict[str, Any]:
    now = time.time() if now is None else now
    active = {_device_id(sub) for sub in subs}
    if not active:
        return {
            "state": "no_subscriptions",
            "devices": 0,
            "received_recent": 0,
            "latest_received_at": None,
            "latest_age_s": None,
        }
    devices = _read(path)["devices"]
    receipts = [row for key, row in devices.items() if key in active and isinstance(row, dict)]
    shown = [
        row for row in receipts
        if row.get("shown") is True
        and isinstance(row.get("received_at"), (int, float))
        and now - float(row["received_at"]) <= _RECENT_S
    ]
    latest = max(
        (float(row["received_at"]) for row in receipts if isinstance(row.get("received_at"), (int, float))),
        default=None,
    )
    return {
        "state": "delivered" if shown else "waiting",
        "devices": len(active),
        "received_recent": len(shown),
        "latest_received_at": latest,
        "latest_age_s": None if latest is None else round(max(0.0, now - latest), 1),
    }
