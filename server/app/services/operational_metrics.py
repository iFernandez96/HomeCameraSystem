"""Secret-free operational state for Prometheus alert rules.

The source ledgers contain filenames, digests, and failure details that must
never become metric labels.  This module deliberately reduces them to numeric
status only.  It also bounds JSONL reads to the tail of each ledger so a
long-lived appliance does not re-read an ever-growing file every scrape.
"""
from __future__ import annotations

import json
import math
import time
from pathlib import Path
from typing import Callable


_LEDGER_TAIL_BYTES = 256 * 1024
_SUPERVISOR_WINDOW_S = 600.0


def backup_metrics(path: Path, *, now: float | None = None) -> dict[str, float]:
    from .backup_status import read_backup_status

    status = read_backup_status(path, now=now)
    result = {
        "status_present": 1.0 if status.get("status_file_present") else 0.0,
    }
    if not status.get("status_file_present"):
        return result
    result["last_attempt_success"] = 1.0
    timestamp = _number(status.get("last_backup_at"))
    if timestamp is not None:
        result["last_success_timestamp"] = timestamp
    if status.get("last_attempt_ok") is False or status.get("last_backup_ok") is False:
        result["last_attempt_success"] = 0.0
    return result


def latest_restore_success(path: Path) -> float | None:
    record = _latest_jsonl(path, lambda row: row.get("operation") == "restore")
    if record is None:
        return None
    if record.get("_invalid") is True:
        return 0.0
    return 1.0 if record.get("ok") is True else 0.0


def latest_update_success(path: Path) -> float | None:
    terminal = {"rejected", "applied", "rolled_back"}
    record = _latest_jsonl(path, lambda row: row.get("status") in terminal)
    if record is None:
        return None
    if record.get("_invalid") is True:
        return 0.0
    return 1.0 if record.get("status") == "applied" else 0.0


def supervisor_metrics(
    path: Path,
    *,
    now: float | None = None,
) -> dict[str, float]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {"state_present": 0.0}
    except (OSError, json.JSONDecodeError):
        return {"state_present": 1.0, "state_valid": 0.0}

    if not isinstance(payload, dict) or payload.get("v") != 1:
        return {"state_present": 1.0, "state_valid": 0.0}
    restart_times = payload.get("restart_times")
    if not isinstance(restart_times, list):
        return {"state_present": 1.0, "state_valid": 0.0}
    normalized = [_number(value) for value in restart_times]
    if any(value is None for value in normalized):
        return {"state_present": 1.0, "state_valid": 0.0}
    current = time.time() if now is None else float(now)
    cutoff = current - _SUPERVISOR_WINDOW_S
    recent = sum(1 for value in normalized if value is not None and value >= cutoff)
    result = {
        "state_present": 1.0,
        "state_valid": 1.0,
        "latched": 1.0 if payload.get("latched") is True else 0.0,
        "restarts_in_window": float(recent),
    }
    last_action_at = _number(payload.get("last_action_at"))
    if last_action_at is not None:
        result["last_action_timestamp"] = last_action_at
    return result


def _latest_jsonl(
    path: Path,
    predicate: Callable[[dict[str, object]], bool],
) -> dict[str, object] | None:
    try:
        with path.open("rb") as handle:
            handle.seek(0, 2)
            size = handle.tell()
            start = max(0, size - _LEDGER_TAIL_BYTES)
            handle.seek(start)
            data = handle.read(_LEDGER_TAIL_BYTES)
    except FileNotFoundError:
        return None
    except OSError:
        return {"_invalid": True}

    lines = data.splitlines()
    if start > 0 and lines:
        # The first row may be a partial record because the read is bounded.
        lines = lines[1:]
    for raw in reversed(lines):
        if not raw.strip():
            continue
        try:
            row = json.loads(raw)
        except (UnicodeDecodeError, json.JSONDecodeError):
            return {"_invalid": True}
        if not isinstance(row, dict):
            return {"_invalid": True}
        if predicate(row):
            return row
    return None


def _number(value: object) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    number = float(value)
    return number if math.isfinite(number) else None
