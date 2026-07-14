"""Time-limited, revocable clip share grants. Raw bearer tokens are never stored."""
from __future__ import annotations

import hashlib
import json
import os
import secrets
import threading
import time
from pathlib import Path

_LOCK = threading.Lock()


def _digest(token: str) -> str:
    return hashlib.sha256(token.encode("ascii")).hexdigest()


def _load(path: Path) -> dict:
    try:
        value = json.loads(path.read_text())
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}


def _save(path: Path, rows: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    fd = os.open(str(tmp), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as handle:
        json.dump(rows, handle, separators=(",", ":"))
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(tmp, path)
    path.chmod(0o600)


def create(path: Path, event_id: str, ttl_s: int, now: float | None = None) -> dict:
    now = time.time() if now is None else now
    token = secrets.token_urlsafe(32)
    share_id = secrets.token_hex(8)
    with _LOCK:
        rows = _load(path)
        rows = {
            key: value for key, value in rows.items()
            if isinstance(value, dict) and float(value.get("expires_at", 0)) > now
        }
        rows[share_id] = {
            "token_hash": _digest(token),
            "event_id": event_id,
            "created_at": now,
            "expires_at": now + ttl_s,
        }
        _save(path, rows)
    return {"share_id": share_id, "token": token, "expires_at": now + ttl_s}


def resolve(path: Path, token: str, now: float | None = None) -> str | None:
    now = time.time() if now is None else now
    wanted = _digest(token)
    with _LOCK:
        rows = _load(path)
    for row in rows.values():
        if not isinstance(row, dict) or float(row.get("expires_at", 0)) <= now:
            continue
        stored = row.get("token_hash")
        if isinstance(stored, str) and secrets.compare_digest(stored, wanted):
            event_id = row.get("event_id")
            return event_id if isinstance(event_id, str) else None
    return None


def revoke(path: Path, share_id: str) -> bool:
    with _LOCK:
        rows = _load(path)
        removed = rows.pop(share_id, None) is not None
        if removed:
            _save(path, rows)
    return removed
