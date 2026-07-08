"""Offline OTA staged-deploy preflight checks."""
from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass
from pathlib import Path

from app.services.ota_layout import detect_scratch_deploy_layout

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class PreflightResult:
    status: str
    staging_dir: Path
    active_version: str | None = None
    reason: str | None = None

    @property
    def can_apply(self) -> bool:
        return self.status == "passed"


def _read_active_version(active_pointer: Path) -> str | None:
    try:
        value = active_pointer.read_text(encoding="utf-8").strip()
    except OSError:
        return None
    return value or None


def _atomic_write_json(path: Path, payload: dict[str, object]) -> None:
    tmp = path.with_name(f"{path.name}.tmp")
    tmp.write_text(
        json.dumps(payload, sort_keys=True, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )
    os.replace(tmp, path)


def _inert_mark(
    staging_dir: Path, *, active_version: str | None, reason: str
) -> PreflightResult:
    _atomic_write_json(
        staging_dir / ".ota-inert.json",
        {"active_version": active_version, "reason": reason, "status": "inert"},
    )
    log.warning(
        "rejecting OTA preflight staging_dir=%s reason=%s active_version=%s",
        staging_dir,
        reason,
        active_version,
    )
    return PreflightResult(
        status="rejected",
        staging_dir=staging_dir,
        active_version=active_version,
        reason=reason,
    )


def preflight_staged_deploy(
    staging_dir: Path, *, client_dist_target: Path, active_pointer: Path
) -> PreflightResult:
    """Validate a staged deployment before any active-version pointer switch."""
    active_version = _read_active_version(active_pointer)
    layout_result = detect_scratch_deploy_layout(
        staging_dir, client_dist_target=client_dist_target
    )
    if not layout_result.can_apply or layout_result.layout is None:
        return _inert_mark(
            staging_dir,
            active_version=active_version,
            reason="incomplete_layout",
        )

    log.info(
        "ota preflight passed staging_dir=%s active_version=%s",
        staging_dir,
        active_version,
    )
    return PreflightResult(
        status="passed", staging_dir=staging_dir, active_version=active_version
    )
