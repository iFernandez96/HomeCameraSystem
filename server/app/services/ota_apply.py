"""OTA active-version pointer transaction."""
from __future__ import annotations

import logging
import os
import re
from dataclasses import dataclass
from pathlib import Path

log = logging.getLogger(__name__)

_VERSION_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._+-]*$")


@dataclass(frozen=True)
class ApplyTransactionResult:
    status: str
    active_pointer: Path
    active_version: str | None = None
    previous_version: str | None = None
    reason: str | None = None

    @property
    def can_restart(self) -> bool:
        return self.status == "applied"


def _read_pointer(path: Path) -> str | None:
    try:
        value = path.read_text(encoding="utf-8").strip()
    except OSError:
        return None
    return value or None


def switch_active_version_pointer(
    *,
    active_pointer: Path,
    version: str,
    staged_version_dir: Path,
) -> ApplyTransactionResult:
    """Atomically publish the single active-version marker file."""
    clean_version = version.strip()
    previous = _read_pointer(active_pointer)
    if _VERSION_RE.fullmatch(clean_version) is None:
        log.warning("rejecting OTA apply transaction reason=%s version=%s", "malformed_version", version)
        return ApplyTransactionResult(
            status="rejected",
            active_pointer=active_pointer,
            previous_version=previous,
            reason="malformed_version",
        )
    if not staged_version_dir.is_dir():
        log.warning(
            "rejecting OTA apply transaction reason=%s staged_version_dir=%s",
            "missing_staged_version_dir",
            staged_version_dir,
        )
        return ApplyTransactionResult(
            status="rejected",
            active_pointer=active_pointer,
            previous_version=previous,
            reason="missing_staged_version_dir",
        )

    active_pointer.parent.mkdir(parents=True, exist_ok=True)
    tmp = active_pointer.with_name(f"{active_pointer.name}.tmp")
    try:
        tmp.write_text(clean_version + "\n", encoding="utf-8")
        os.replace(tmp, active_pointer)
    except OSError:
        try:
            tmp.unlink()
        except OSError:
            pass
        log.warning("rejecting OTA apply transaction reason=%s", "active_pointer_write_failed")
        return ApplyTransactionResult(
            status="rejected",
            active_pointer=active_pointer,
            previous_version=previous,
            reason="active_pointer_write_failed",
        )

    log.info(
        "ota active pointer switched previous_version=%s active_version=%s path=%s",
        previous,
        clean_version,
        active_pointer,
    )
    return ApplyTransactionResult(
        status="applied",
        active_pointer=active_pointer,
        active_version=clean_version,
        previous_version=previous,
    )
