"""Pure OTA apply orchestrator for route wiring later."""
from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

from app.services.ota_apply import switch_active_version_pointer
from app.services.ota_compare import compare_available_version
from app.services.ota_health import HealthPoller, poll_post_restart_health
from app.services.ota_integrity import verify_local_artifact
from app.services.ota_kill_switch import read_manifest_then_check_apply_gate
from app.services.ota_ledger import append_event
from app.services.ota_preflight import preflight_staged_deploy
from app.services.ota_restart import CommandRunner, record_restart_handoff
from app.services.ota_rollback import rollback_active_version_pointer
from app.services.ota_stage import stage_artifact_to_versioned_dir


@dataclass(frozen=True)
class OtaApplyRequest:
    attempt_id: str
    manifest_path: Path
    artifacts_dir: Path
    staging_root: Path
    persisted_data_dir: Path
    active_pointer: Path
    ledger_path: Path
    current_version: str
    expected_artifact_size: int
    restart_command: Sequence[str]
    env: Mapping[str, str] | None = None


@dataclass(frozen=True)
class OtaOrchestratorResult:
    status: str
    applied: bool
    version: str | None = None
    ledger_id: str | None = None
    reason: str | None = None
    phase: str | None = None


def _append_terminal_rejected(
    request: OtaApplyRequest,
    *,
    reason: str,
    phase: str,
    version: str | None = None,
    clock: Callable[[], datetime | str] | None = None,
) -> OtaOrchestratorResult:
    append_kwargs: dict[str, Any] = {}
    if clock is not None:
        append_kwargs["clock"] = clock
    append_event(
        request.ledger_path,
        attempt_id=request.attempt_id,
        status="rejected",
        reason=reason,
        metadata={"phase": phase, "version": version} if version else {"phase": phase},
        **append_kwargs,
    )
    return OtaOrchestratorResult(
        status="rejected",
        applied=False,
        reason=reason,
        phase=phase,
    )


def orchestrate_ota_apply(
    request: OtaApplyRequest,
    *,
    health_poller: HealthPoller | None,
    restart_runner: CommandRunner | None = None,
    clock: Callable[[], datetime | str] | None = None,
) -> OtaOrchestratorResult:
    """Compose OTA U2-U14 without route wiring or production side effects."""
    append_kwargs: dict[str, Any] = {}
    if clock is not None:
        append_kwargs["clock"] = clock
    append_event(
        request.ledger_path,
        attempt_id=request.attempt_id,
        status="requested",
        metadata={"current_version": request.current_version},
        **append_kwargs,
    )

    gate = read_manifest_then_check_apply_gate(request.manifest_path, env=request.env)
    if not gate.can_apply or gate.manifest_result.manifest is None:
        return _append_terminal_rejected(
            request,
            reason=gate.reason or "manifest_unavailable",
            phase="manifest_gate",
            clock=clock,
        )
    manifest = gate.manifest_result.manifest

    comparison = compare_available_version(
        current_version=request.current_version,
        available_version=manifest.version,
    )
    if not comparison.can_apply:
        return _append_terminal_rejected(
            request,
            reason=comparison.reason or "version_not_newer",
            phase="version_compare",
            version=manifest.version,
            clock=clock,
        )

    artifact_path = request.artifacts_dir / manifest.artifact.name
    integrity = verify_local_artifact(
        artifact_path,
        expected_size=request.expected_artifact_size,
        expected_sha256=manifest.artifact.sha256,
    )
    if not integrity.can_apply:
        return _append_terminal_rejected(
            request,
            reason=integrity.reason or "artifact_integrity_failed",
            phase="artifact_integrity",
            version=manifest.version,
            clock=clock,
        )

    append_event(
        request.ledger_path,
        attempt_id=request.attempt_id,
        status="started",
        metadata={"version": manifest.version},
        **append_kwargs,
    )
    staged = stage_artifact_to_versioned_dir(
        artifact_path,
        version=manifest.version,
        staging_root=request.staging_root,
        **append_kwargs,
    )
    if not staged.can_apply or staged.staging_dir is None:
        return _append_terminal_rejected(
            request,
            reason=staged.reason or "stage_failed",
            phase="stage",
            version=manifest.version,
            clock=clock,
        )

    preflight = preflight_staged_deploy(
        staged.staging_dir,
        persisted_data_dir=request.persisted_data_dir,
        active_pointer=request.active_pointer,
    )
    if not preflight.can_apply:
        return _append_terminal_rejected(
            request,
            reason=preflight.reason or "preflight_failed",
            phase="preflight",
            version=manifest.version,
            clock=clock,
        )

    apply_result = switch_active_version_pointer(
        active_pointer=request.active_pointer,
        version=manifest.version,
        staged_version_dir=staged.staging_dir,
    )
    if not apply_result.can_restart:
        return _append_terminal_rejected(
            request,
            reason=apply_result.reason or "apply_failed",
            phase="apply",
            version=manifest.version,
            clock=clock,
        )

    restart = record_restart_handoff(request.restart_command, runner=restart_runner)
    if not restart.handed_off:
        rollback = rollback_active_version_pointer(
            active_pointer=request.active_pointer,
            previous_version=apply_result.previous_version,
            ledger_path=request.ledger_path,
            attempt_id=request.attempt_id,
            reason=restart.reason or "restart_handoff_failed",
            metadata={"phase": "restart", "version": manifest.version},
            clock=clock,
        )
        return OtaOrchestratorResult(
            status=rollback.status,
            applied=False,
            reason=rollback.reason,
            phase="restart",
        )

    if health_poller is None:
        rollback = rollback_active_version_pointer(
            active_pointer=request.active_pointer,
            previous_version=apply_result.previous_version,
            ledger_path=request.ledger_path,
            attempt_id=request.attempt_id,
            reason="health_poller_missing",
            metadata={"phase": "health", "version": manifest.version},
            clock=clock,
        )
        return OtaOrchestratorResult(
            status=rollback.status,
            applied=False,
            reason=rollback.reason,
            phase="health",
        )

    health = poll_post_restart_health(health_poller, attempts=5)
    if not health.healthy:
        rollback = rollback_active_version_pointer(
            active_pointer=request.active_pointer,
            previous_version=apply_result.previous_version,
            ledger_path=request.ledger_path,
            attempt_id=request.attempt_id,
            reason=health.reason or "health_failed",
            metadata={"phase": "health", "version": manifest.version},
            clock=clock,
        )
        return OtaOrchestratorResult(
            status=rollback.status,
            applied=False,
            reason=rollback.reason,
            phase="health",
        )

    append_event(
        request.ledger_path,
        attempt_id=request.attempt_id,
        status="applied",
        reason="health_passed",
        metadata={"version": manifest.version},
        **append_kwargs,
    )
    return OtaOrchestratorResult(
        status="applied",
        applied=True,
        version=manifest.version,
        ledger_id=request.attempt_id,
    )
