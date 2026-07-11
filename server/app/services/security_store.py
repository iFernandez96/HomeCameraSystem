"""Private atomic state for the local security-platform features.

The event stream stays in SQLite. Small mutable domain records (incidents,
automations, export jobs, package state, outage history and face preferences)
live in one mode-0600 JSON document so credentials never enter client-visible
configuration or logs.
"""
from __future__ import annotations

import copy
import json
import logging
import os
import threading
from pathlib import Path
from typing import Any, Callable, TypeVar

from ..config import settings

log = logging.getLogger(__name__)
T = TypeVar("T")


def _default_state() -> dict[str, Any]:
    return {
        "v": 1,
        "incidents": {},
        "automations": {},
        "timeline_exports": {},
        "deterrence": {"last_auto_ts": 0.0, "audit": []},
        "face_preferences": {},
        "outages": {"current": {}, "history": []},
        "packages": {},
    }


class SecurityStore:
    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._path: Path | None = None
        self._state = _default_state()

    def _select_path(self) -> None:
        path = settings.security_state_path
        if path == self._path:
            return
        self._path = path
        self._state = self._load(path)

    @staticmethod
    def _load(path: Path) -> dict[str, Any]:
        if not path.exists():
            return _default_state()
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            log.warning("security state unreadable at %s: %s", path, exc)
            return _default_state()
        if not isinstance(raw, dict):
            log.warning("security state at %s is not an object; ignoring", path)
            return _default_state()
        state = _default_state()
        for key in state:
            if key in raw and isinstance(raw[key], type(state[key])):
                state[key] = raw[key]
        # A container restart cannot resume an in-process ffmpeg task. Make
        # that state honest rather than leaving the UI spinning forever.
        for job in state["timeline_exports"].values():
            if isinstance(job, dict) and job.get("status") in {
                "queued", "building", "pending", "running"
            }:
                job["status"] = "failed"
                job["error"] = "server restarted before export completed"
                job["reservation_bytes"] = 0
        return state

    def _save_locked(self) -> None:
        assert self._path is not None
        path = self._path
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(path.suffix + ".tmp")
        payload = json.dumps(
            self._state, ensure_ascii=True, separators=(",", ":"), sort_keys=True
        ).encode("utf-8")
        try:
            fd = os.open(str(tmp), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            try:
                view = memoryview(payload)
                written = 0
                while written < len(view):
                    count = os.write(fd, view[written:])
                    if count <= 0:
                        raise OSError("short write while saving security state")
                    written += count
                os.fsync(fd)
            finally:
                os.close(fd)
            os.replace(tmp, path)
        except Exception:
            try:
                tmp.unlink(missing_ok=True)
            except OSError:
                pass
            raise
        try:
            path.chmod(0o600)
        except OSError as exc:
            log.warning("could not chmod security state %s to 0600: %s", path, exc)

    def read(self) -> dict[str, Any]:
        with self._lock:
            self._select_path()
            return copy.deepcopy(self._state)

    def transact(self, operation: Callable[[dict[str, Any]], T]) -> T:
        with self._lock:
            self._select_path()
            result = operation(self._state)
            self._save_locked()
            return copy.deepcopy(result)

    def reset_for_tests(self) -> None:
        with self._lock:
            self._path = None
            self._state = _default_state()


security_store = SecurityStore()
