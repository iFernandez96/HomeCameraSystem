"""OTA active-version rollback transaction."""
from __future__ import annotations

import logging
import os
import re
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

from app.services.ota_ledger import LedgerEvent, append_event

log = logging.getLogger(__name__)

_VERSION_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._+-]*$")


@dataclass(frozen=True)
class RollbackResult:
    status: str
    active_pointer: Path
    restored_version: str | None = None
    reason: str | None = None
    ledger_event: LedgerEvent | None = None

    @property
    def rolled_back(self) -> bool:
        return self.status == "rolled_back"


def _write_pointer(active_pointer: Path, version: str) -> bool:
    active_pointer.parent.mkdir(parents=True, exist_ok=True)
    tmp = active_pointer.with_name(f"{active_pointer.name}.rollback.tmp")
    try:
        tmp.write_text(version + "\n", encoding="utf-8")
        os.replace(tmp, active_pointer)
    except OSError:
        try:
            tmp.unlink()
        except OSError:
            pass
        return False
    return True


def rollback_active_version_pointer(
    *,
    active_pointer: Path,
    previous_version: str | None,
    ledger_path: Path,
    attempt_id: str,
    reason: str,
    metadata: Mapping[str, Any] | None = None,
    clock: Callable[[], datetime | str] | None = None,
) -> RollbackResult:
    """Restore the previous active-version pointer and record a rollback reason."""
    clean_previous = (previous_version or "").strip()
    if _VERSION_RE.fullmatch(clean_previous) is None:
        log.warning("rejecting OTA rollback reason=%s", "missing_previous_version")
        return RollbackResult(
            status="failed",
            active_pointer=active_pointer,
            reason="missing_previous_version",
        )
    if not _write_pointer(active_pointer, clean_previous):
        log.warning("rejecting OTA rollback reason=%s", "active_pointer_write_failed")
        return RollbackResult(
            status="failed",
            active_pointer=active_pointer,
            reason="active_pointer_write_failed",
        )

    append_kwargs: dict[str, Any] = {}
    if clock is not None:
        append_kwargs["clock"] = clock
    event = append_event(
        ledger_path,
        attempt_id=attempt_id,
        status="rolled_back",
        reason=reason,
        metadata=metadata,
        **append_kwargs,
    )
    log.info(
        "ota rollback restored previous_version=%s path=%s reason=%s",
        clean_previous,
        active_pointer,
        reason,
    )
    return RollbackResult(
        status="rolled_back",
        active_pointer=active_pointer,
        restored_version=clean_previous,
        reason=reason,
        ledger_event=event,
    )
