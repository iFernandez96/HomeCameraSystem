from __future__ import annotations

import json
import os
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any


REPLICATION_DEFERRED = "deferred_off_device"


def record_backup_success(
    path: Path,
    *,
    filename: str,
    archive_digest: str,
    recipient_fingerprint: str,
    now: float | None = None,
) -> dict[str, Any]:
    timestamp = time.time() if now is None else float(now)
    payload = {
        "v": 1,
        "last_backup_at": timestamp,
        "last_backup_at_iso": datetime.fromtimestamp(
            timestamp,
            tz=UTC,
        ).isoformat().replace("+00:00", "Z"),
        "last_backup_ok": True,
        "filename": filename,
        "archive_digest": archive_digest,
        "encrypted": True,
        "recipient_fingerprint": recipient_fingerprint,
        "replication_status": REPLICATION_DEFERRED,
        "replication_detail": "off-device replication explicitly deferred",
    }
    _atomic_write(path, payload)
    return payload


def record_backup_failure(
    path: Path,
    *,
    reason: str,
    now: float | None = None,
) -> dict[str, Any]:
    timestamp = time.time() if now is None else float(now)
    previous = read_backup_status(path, now=timestamp)
    payload = {
        key: value
        for key, value in previous.items()
        if key not in {"backup_age_s", "status_file_present"}
    }
    payload.update({
        "v": 1,
        "last_attempt_at": timestamp,
        "last_attempt_ok": False,
        "last_attempt_reason": reason,
        "replication_status": REPLICATION_DEFERRED,
        "replication_detail": "off-device replication explicitly deferred",
    })
    _atomic_write(path, payload)
    return payload


def read_backup_status(path: Path, *, now: float | None = None) -> dict[str, Any]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {
            "status_file_present": False,
            "last_backup_ok": False,
            "backup_age_s": None,
            "replication_status": REPLICATION_DEFERRED,
            "replication_detail": "off-device replication explicitly deferred",
        }
    if not isinstance(payload, dict):
        return {
            "status_file_present": False,
            "last_backup_ok": False,
            "backup_age_s": None,
            "replication_status": REPLICATION_DEFERRED,
            "replication_detail": "off-device replication explicitly deferred",
        }
    timestamp = payload.get("last_backup_at")
    current = time.time() if now is None else float(now)
    age = None
    if isinstance(timestamp, (int, float)) and not isinstance(timestamp, bool):
        age = max(0.0, current - float(timestamp))
    return {
        **payload,
        "status_file_present": True,
        "backup_age_s": age,
    }


def _atomic_write(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(
        "{}.{}.{}.tmp".format(path.name, os.getpid(), time.time_ns())
    )
    encoded = json.dumps(
        payload,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    try:
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            written = 0
            while written < len(encoded):
                count = os.write(fd, encoded[written:])
                if count <= 0:
                    raise OSError("short write while saving backup status")
                written += count
            os.fsync(fd)
        finally:
            os.close(fd)
        os.replace(tmp, path)
        os.chmod(path, 0o600)
    except Exception:
        try:
            tmp.unlink()
        except OSError:
            pass
        raise
