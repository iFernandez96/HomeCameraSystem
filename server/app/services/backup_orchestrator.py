from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from app.services.backup_archive import (
    apply_backup_retention,
    encrypted_backup_api_response,
    publish_encrypted_backup_atomically,
    remove_plaintext_backup_intermediates,
    write_archive_to_temp,
)
from app.services.backup_crypto import BackupCryptoError, recipient_fingerprint
from app.services.backup_ledger import append_attempt, attempt_metadata
from app.services.backup_manifest import (
    BackupBlocked,
    build_manifest_from_inventory,
    build_persisted_state_inventory,
)
from app.services.backup_restore import (
    MaintenanceConflict,
    MaintenanceLock,
    cross_process_maintenance_lease,
)
from app.services.backup_snapshot import materialize_consistent_inventory
from app.services.backup_status import record_backup_failure, record_backup_success


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
            with cross_process_maintenance_lease(
                request.target_dir / ".maintenance.lock",
                "backup",
            ):
                remove_plaintext_backup_intermediates(request.target_dir)
                recipient_path = Path(
                    getattr(
                        request.settings_obj,
                        "backup_recipient_public_key_path",
                    )
                )
                recipient_id = recipient_fingerprint(recipient_path)
                inventory = build_persisted_state_inventory(
                    settings_obj=request.settings_obj
                )
                stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
                final_name = f"homecam-backup-{stamp}.hcbk"
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
                published = publish_encrypted_backup_atomically(
                    draft=draft,
                    target_dir=request.target_dir,
                    final_archive_name=final_name,
                    recipient_public_key_path=recipient_path,
                )
                try:
                    apply_backup_retention(
                        target_dir=request.target_dir,
                        keep_newest=int(
                            getattr(request.settings_obj, "backup_retention_count", 14)
                        ),
                        protect=published.archive_path,
                    )
                except Exception:
                    published.archive_path.unlink(missing_ok=True)
                    raise
                candidate_response = encrypted_backup_api_response(published)
                candidate_response["ledger_id"] = request.attempt_id
                status_path = Path(
                    getattr(request.settings_obj, "backup_status_path")
                )
                try:
                    state = record_backup_success(
                        status_path,
                        filename=published.archive_path.name,
                        archive_digest=published.archive_sha256,
                        recipient_fingerprint=recipient_id,
                    )
                except Exception:
                    # Status is part of the publication contract. Do not leave a
                    # route-visible artifact that the ledger reports as failed.
                    published.archive_path.unlink(missing_ok=True)
                    raise
                candidate_response["backup_age_s"] = 0.0
                candidate_response["replication_status"] = state["replication_status"]
                response = candidate_response
            status = "encrypted_published"
            return response
    except MaintenanceConflict as exc:
        reason = "maintenance_conflict"
        response = _backup_failed(reason, str(exc), request.attempt_id)
        response["maintenance"] = exc.response()
        return response
    except BackupBlocked as exc:
        reason = exc.reason
        detail = str(exc.path) if exc.path is not None else exc.role
        return _backup_failed(reason, detail, request.attempt_id)
    except BackupCryptoError as exc:
        reason = "backup_encryption_failed"
        return _backup_failed(reason, str(exc), request.attempt_id)
    except (OSError, TypeError, ValueError) as exc:
        reason = exc.__class__.__name__
        return _backup_failed(reason, str(exc), request.attempt_id)
    finally:
        if response is None and reason != "maintenance_conflict":
            status_path_value = getattr(
                request.settings_obj,
                "backup_status_path",
                None,
            )
            if status_path_value is not None:
                try:
                    record_backup_failure(
                        Path(status_path_value),
                        reason=reason or "backup_failed",
                    )
                except OSError:
                    pass
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
