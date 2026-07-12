"""Durable recording-canary state and honest freshness classification."""
from __future__ import annotations

import json
import logging
import os
import time
from pathlib import Path
from typing import Any, Literal, TypedDict

from ..config import settings


log = logging.getLogger(__name__)
STALE_AFTER_S = 45 * 60


class AssuranceStatus(TypedDict, total=False):
    state: Literal["unknown", "ok", "failed", "stale"]
    checked_at: float | None
    age_s: float | None
    stage: str | None
    reason: str | None
    sample_bytes: int | None
    elapsed_ms: float | None
    storage: dict[str, Any] | None
    event_clip: dict[str, Any] | None


def _read_raw(path: Path | None = None) -> dict[str, Any] | None:
    source = path or settings.recording_assurance_path
    try:
        value = json.loads(source.read_text())
    except (OSError, ValueError, TypeError):
        return None
    if not isinstance(value, dict) or value.get("v") != 1:
        return None
    if value.get("status") not in ("ok", "failed"):
        return None
    checked_at = value.get("checked_at")
    if not isinstance(checked_at, (int, float)) or isinstance(checked_at, bool):
        return None
    return value


def status(now: float | None = None, path: Path | None = None) -> AssuranceStatus:
    now = time.time() if now is None else now
    value = _read_raw(path)
    if value is None:
        return {
            "state": "unknown",
            "checked_at": None,
            "age_s": None,
            "stage": None,
            "reason": None,
            "sample_bytes": None,
            "elapsed_ms": None,
            "storage": None,
            "event_clip": None,
        }
    checked_at = float(value["checked_at"])
    age_s = max(0.0, now - checked_at)
    state: Literal["ok", "failed", "stale"] = value["status"]
    if age_s > STALE_AFTER_S:
        state = "stale"
    return {
        "state": state,
        "checked_at": checked_at,
        "age_s": round(age_s, 1),
        "stage": value.get("stage"),
        "reason": value.get("reason"),
        "sample_bytes": value.get("sample_bytes"),
        "elapsed_ms": value.get("elapsed_ms"),
        "storage": value.get("storage"),
        "event_clip": value.get("event_clip"),
    }


def record(payload: dict[str, Any], path: Path | None = None) -> str | None:
    """Persist a validated payload and return ``failed``/``recovered`` transition."""
    target = path or settings.recording_assurance_path
    previous = _read_raw(target)
    target.parent.mkdir(parents=True, exist_ok=True)
    temp = target.with_suffix(target.suffix + ".tmp")
    try:
        with temp.open("w") as handle:
            json.dump(payload, handle, separators=(",", ":"), sort_keys=True)
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

    current_status = payload["status"]
    previous_status = previous.get("status") if previous else None
    if current_status == "failed" and previous_status != "failed":
        return "failed"
    if current_status == "ok" and previous_status == "failed":
        return "recovered"
    return None
