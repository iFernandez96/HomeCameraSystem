"""OTA apply kill-switch checks."""
from __future__ import annotations

import logging
import os
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

from app.services.ota_manifest import ManifestReadResult, read_local_manifest

log = logging.getLogger(__name__)

_DISABLED_VALUES = frozenset({"1", "true", "yes", "on", "disabled", "disable"})


@dataclass(frozen=True)
class OtaApplyGateResult:
    status: str
    manifest_result: ManifestReadResult
    reason: str | None = None

    @property
    def can_apply(self) -> bool:
        return self.status == "allowed" and self.manifest_result.can_apply


def kill_switch_disabled(env: Mapping[str, str] | None = None) -> bool:
    source = env if env is not None else os.environ
    return source.get("HOMECAM_OTA_DISABLED", "").strip().lower() in _DISABLED_VALUES


def read_manifest_then_check_apply_gate(
    manifest_path: Path, *, env: Mapping[str, str] | None = None
) -> OtaApplyGateResult:
    """Read the local manifest before applying the OTA kill switch."""
    manifest_result = read_local_manifest(manifest_path)
    if not manifest_result.can_apply:
        log.warning(
            "rejecting OTA apply before kill switch: manifest unavailable path=%s reason=%s",
            manifest_path,
            manifest_result.reason,
        )
        return OtaApplyGateResult(
            status="rejected",
            manifest_result=manifest_result,
            reason=manifest_result.reason,
        )

    if kill_switch_disabled(env):
        log.warning(
            "rejecting OTA apply: kill switch disabled updates path=%s",
            manifest_path,
        )
        return OtaApplyGateResult(
            status="rejected",
            manifest_result=manifest_result,
            reason="kill_switch_disabled",
        )

    return OtaApplyGateResult(status="allowed", manifest_result=manifest_result)
