from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from app.services.backup_archive import (
    backup_api_response_from_published,
    publish_backup_atomically,
    write_archive_to_temp,
)
from app.services.backup_ledger import append_attempt, attempt_metadata
from app.services.backup_manifest import (
    BackupBlocked,
    build_manifest_from_inventory,
    build_persisted_state_inventory,
)
from app.services.backup_restore import MaintenanceConflict, MaintenanceLock
from app.services.backup_snapshot import materialize_consistent_inventory


@dataclass(frozen=True)
class BackupOrchestratorRequest:
    attempt_id: str
    target_dir: Path
    ledger_path: Path
    app_version: str
    settings_obj: object


def orchestrate_backup(
    request: BackupOrchestratorRequest,
    *,
    maintenance_lock: MaintenanceLock | None = None,
) -> dict[str, object]:
    inventory = []
    manifest: dict[str, Any] | None = None
    response: dict[str, object] | None = None
    reason: str | None = None
    status = "failed"

    try:
        lease = (
            maintenance_lock.acquire("backup")
            if maintenance_lock is not None
            else _NullLease()
        )
        with lease:
            inventory = build_persisted_state_inventory(
                settings_obj=request.settings_obj
            )
            stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
            final_name = f"homecam-backup-{stamp}.tar.gz"
            with materialize_consistent_inventory(
                inventory,
                staging_parent=request.target_dir,
            ) as stable_inventory:
                manifest = build_manifest_from_inventory(
                    stable_inventory,
                    app_version=request.app_version,
                )
                draft = write_archive_to_temp(
                    target_dir=request.target_dir,
                    manifest=manifest,
                    inventory=stable_inventory,
                    temp_stem=f"homecam-backup-{stamp}",
                )
            published = publish_backup_atomically(
                draft=draft,
                target_dir=request.target_dir,
                final_archive_name=final_name,
            )
            response = backup_api_response_from_published(published)
            response["ledger_id"] = request.attempt_id
            status = "published"
            return response
    except MaintenanceConflict as exc:
        reason = "maintenance_conflict"
        return _backup_failed(reason, str(exc), request.attempt_id)
    except BackupBlocked as exc:
        reason = exc.reason
        detail = str(exc.path) if exc.path is not None else exc.role
        return _backup_failed(reason, detail, request.attempt_id)
    except (OSError, ValueError) as exc:
        reason = exc.__class__.__name__
        return _backup_failed(reason, str(exc), request.attempt_id)
    finally:
        metadata = _ledger_metadata(
            manifest=manifest,
            inventory=inventory,
            response=response,
            compatibility_decision="not_applicable",
            changed_files_count=0,
            restart_health_result="not_run",
            rollback_status="not_needed" if response else "not_run",
        )
        append_attempt(
            request.ledger_path,
            attempt_id=request.attempt_id,
            operation="backup",
            ok=response is not None,
            status=status,
            reason=reason,
            metadata=metadata,
        )


def _ledger_metadata(
    *,
    manifest: dict[str, Any] | None,
    inventory: list[object],
    response: dict[str, object] | None,
    compatibility_decision: str,
    changed_files_count: int,
    restart_health_result: str,
    rollback_status: str,
) -> dict[str, Any]:
    archive_digest = None
    if response is not None:
        archive_digest = response.get("archive_digest")
    return attempt_metadata(
        manifest,
        archive_digest=str(archive_digest) if archive_digest else None,
        inventory_count=len(inventory),
        compatibility_decision=compatibility_decision,
        changed_files_count=changed_files_count,
        restart_health_result=restart_health_result,
        rollback_status=rollback_status,
    )


def _backup_failed(
    reason: str,
    detail: str | None,
    ledger_id: str,
) -> dict[str, object]:
    body: dict[str, object] = {
        "ok": False,
        "status": "not_backed_up",
        "reason": reason,
        "ledger_id": ledger_id,
    }
    if detail:
        body["detail"] = detail
    return body


@dataclass(frozen=True)
class _NullLease:
    def __enter__(self) -> "_NullLease":
        return self

    def __exit__(self, _exc_type: object, _exc: object, _tb: object) -> None:
        return None
