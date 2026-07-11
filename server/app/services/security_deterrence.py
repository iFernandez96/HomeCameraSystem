"""Policy and dedicated adapter for deterrence actions.

This service intentionally does not use host_bridge. The server container has
no GPIO/ALSA devices by default; therefore capability is `unavailable` unless
an operator explicitly mounts a narrow executable adapter into the container.
"""
from __future__ import annotations

import os
import subprocess
import threading
import time
import uuid
from typing import Any

from ..config import settings
from .detection_config import detection_config
from .security_store import security_store

_ACTIONS = {"light", "warning", "siren"}
_AUTO_COOLDOWN_S = 300.0
_ACTION_LOCK = threading.Lock()


def capabilities() -> dict[str, Any]:
    path = settings.deterrence_driver_path
    available = bool(
        path is not None and path.is_absolute() and path.is_file() and os.access(path, os.X_OK)
    )
    return {
        "available": available,
        "adapter": "mounted_executable" if available else None,
        "limitation": (
            "The server container has no host GPIO or audio access by default; "
            "a mounted, device-mapped adapter is required for hardware activation."
        ),
    }


def _audit(
    *, mode: str, action: str, duration_s: float, status: str,
    reason: str, username: str | None, event_id: str | None,
) -> dict[str, Any]:
    record = {
        "id": uuid.uuid4().hex,
        "ts": time.time(),
        "mode": mode,
        "action": action,
        "duration_s": duration_s,
        "status": status,
        "reason": reason,
        "username": username,
        "event_id": event_id,
    }

    def _append(state: dict[str, Any]) -> dict[str, Any]:
        rows = state["deterrence"].setdefault("audit", [])
        rows.append(record)
        del rows[:-500]
        return record

    security_store.transact(_append)
    return record


def _execute_adapter(action: str, duration_s: float) -> tuple[str, str]:
    caps = capabilities()
    if not caps["available"]:
        return "unavailable", "hardware adapter is not available"
    assert settings.deterrence_driver_path is not None
    try:
        result = subprocess.run(
            [str(settings.deterrence_driver_path), action, "{:.1f}".format(duration_s)],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=min(70.0, duration_s + 10.0),
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return "unavailable", "hardware adapter did not complete"
    return (
        ("executed", "adapter accepted action")
        if result.returncode == 0
        else ("unavailable", "hardware adapter rejected action")
    )


def manual(
    action: str,
    duration_s: float,
    *,
    confirm: bool,
    username: str,
    event_id: str | None,
) -> dict[str, Any]:
    if not _ACTION_LOCK.acquire(blocking=False):
        status, reason = "blocked", "another deterrence action is in progress"
        _audit(
            mode="manual", action=action, duration_s=duration_s, status=status,
            reason=reason, username=username, event_id=event_id,
        )
        return {
            "ok": False, "status": status, "reason": reason,
            "action": action, "duration_s": duration_s,
            "capabilities": capabilities(),
        }
    try:
        return _manual_locked(
            action, duration_s, confirm=confirm, username=username, event_id=event_id
        )
    finally:
        _ACTION_LOCK.release()


def _manual_locked(
    action: str, duration_s: float, *, confirm: bool,
    username: str, event_id: str | None,
) -> dict[str, Any]:
    cfg = detection_config.get()
    if action not in _ACTIONS:
        status, reason = "blocked", "unsupported action"
    elif not confirm:
        status, reason = "blocked", "explicit confirmation is required"
    elif not cfg.deterrence_enabled:
        status, reason = "blocked", "deterrence is not armed"
    elif cfg.operating_mode == "privacy":
        status, reason = "blocked", "privacy mode blocks deterrence"
    else:
        status, reason = _execute_adapter(action, duration_s)
    _audit(
        mode="manual", action=action, duration_s=duration_s, status=status,
        reason=reason, username=username, event_id=event_id,
    )
    return {
        "ok": status == "executed",
        "status": status,
        "reason": reason,
        "action": action,
        "duration_s": duration_s,
        "capabilities": capabilities(),
    }


def automatic(event: dict[str, Any], action: str, duration_s: float) -> dict[str, Any]:
    if not _ACTION_LOCK.acquire(blocking=False):
        reason = "another deterrence action is in progress"
        _audit(
            mode="automatic", action=action, duration_s=duration_s,
            status="blocked", reason=reason, username=None, event_id=event.get("id"),
        )
        return {"kind": action, "status": "blocked", "detail": reason}
    try:
        return _automatic_locked(event, action, duration_s)
    finally:
        _ACTION_LOCK.release()


def _automatic_locked(
    event: dict[str, Any], action: str, duration_s: float
) -> dict[str, Any]:
    cfg = detection_config.get()
    now = time.time()
    state = security_store.read()["deterrence"]
    reason: str | None = None
    if not cfg.deterrence_enabled:
        reason = "deterrence is not armed"
    elif cfg.operating_mode == "privacy":
        reason = "privacy mode blocks deterrence"
    elif action not in _ACTIONS:
        reason = "unsupported action"
    elif float(event.get("score") or 0.0) < 0.85:
        reason = "signal confidence is below automatic threshold"
    elif event.get("source") == "vision" and not event.get("rule_id"):
        reason = "ordinary vision detections are not eligible"
    elif event.get("source") == "vision" and event.get("person_name"):
        reason = "known household identity suppresses automatic deterrence"
    elif event.get("source") == "vision":
        # The current event contract has no calibrated identity-confidence
        # proof for an unknown person. Uncertainty therefore fails closed;
        # the owner can still use the confirmed foreground endpoint.
        reason = "uncertain identity fails closed for automatic deterrence"
    elif now - float(state.get("last_auto_ts", 0.0)) < _AUTO_COOLDOWN_S:
        reason = "automatic deterrence cooldown is active"
    if reason is not None:
        status = "blocked"
    else:
        status, reason = _execute_adapter(action, duration_s)
        if status == "executed":
            def _mark(current: dict[str, Any]) -> None:
                current["deterrence"]["last_auto_ts"] = now
            security_store.transact(_mark)
    _audit(
        mode="automatic", action=action, duration_s=duration_s, status=status,
        reason=reason, username=None, event_id=event.get("id"),
    )
    return {"kind": action, "status": status, "detail": reason}
