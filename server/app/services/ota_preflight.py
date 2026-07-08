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


def _env_values(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def preflight_staged_deploy(
    staging_dir: Path, *, persisted_data_dir: Path, active_pointer: Path
) -> PreflightResult:
    """Validate a staged deployment before any active-version pointer switch."""
    active_version = _read_active_version(active_pointer)
    layout_result = detect_scratch_deploy_layout(staging_dir)
    if not layout_result.can_apply or layout_result.layout is None:
        return _inert_mark(
            staging_dir,
            active_version=active_version,
            reason="incomplete_layout",
        )

    if not persisted_data_dir.is_dir():
        return _inert_mark(
            staging_dir,
            active_version=active_version,
            reason="missing_persisted_data_dir",
        )

    try:
        env = _env_values(layout_result.layout.env_path)
        compose = layout_result.layout.compose_path.read_text(encoding="utf-8")
    except OSError:
        return _inert_mark(
            staging_dir,
            active_version=active_version,
            reason="config_read_failed",
        )

    expected_data = str(persisted_data_dir)
    if env.get("HOMECAM_DATA_DIR") != expected_data:
        return _inert_mark(
            staging_dir,
            active_version=active_version,
            reason="env_data_dir_mismatch",
        )
    if "${HOMECAM_DATA_DIR}" not in compose and expected_data not in compose:
        return _inert_mark(
            staging_dir,
            active_version=active_version,
            reason="compose_missing_persisted_data_reference",
        )
    if ":/data" not in compose:
        return _inert_mark(
            staging_dir,
            active_version=active_version,
            reason="compose_missing_data_mount",
        )

    log.info(
        "ota preflight passed staging_dir=%s active_version=%s",
        staging_dir,
        active_version,
    )
    return PreflightResult(
        status="passed", staging_dir=staging_dir, active_version=active_version
    )
