from __future__ import annotations

import fcntl
import hashlib
import json
import logging
import os
import re
import shutil
import sqlite3
import tarfile
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from tempfile import mkdtemp
from threading import Lock
from typing import Any, Callable, Iterable, Mapping

from app.services.backup_archive import decrypt_encrypted_backup, sha256_file
from app.services.backup_crypto import BackupCryptoError
from app.services.backup_ledger import append_attempt, attempt_metadata
from app.services.backup_manifest import MANIFEST_VERSION, validate_manifest

log = logging.getLogger(__name__)

LIST_BACKUPS_FILENAME_PATTERN = r"^[A-Za-z0-9_.-]+$"


class RestoreBlocked(RuntimeError):
    """Typed block for restore preflight failures."""

    def __init__(self, reason: str, *, path: Path | None = None, role: str | None = None):
        super().__init__(reason)
        self.reason = reason
        self.path = path
        self.role = role


class MaintenanceConflict(RuntimeError):
    """Typed conflict for concurrent maintenance or restore-blocked writes."""

    def __init__(self, active_operation: str, requested_operation: str):
        super().__init__(
            f"{requested_operation} conflicts with active {active_operation}"
        )
        self.active_operation = active_operation
        self.requested_operation = requested_operation

    def response(self) -> dict[str, object]:
        """Return the stable wire shape shared by routes and middleware."""
        return {
            "code": "maintenance_conflict",
            "active_operation": self.active_operation,
            "requested_operation": self.requested_operation,
            "retryable": True,
        }


@dataclass(frozen=True)
class MaintenanceState:
    active: bool
    operation: str | None
    blocks_mutations: bool

    def response(self) -> dict[str, object]:
        return {
            "active": self.active,
            "operation": self.operation,
            "blocks_mutations": self.blocks_mutations,
        }


@dataclass(frozen=True)
class RestoreBackup:
    archive_path: Path
    manifest_path: Path
    manifest: dict[str, Any]
    source_path: Path
    cleanup_paths: tuple[Path, ...] = ()


@dataclass(frozen=True)
class RestoreCompatibilityResult:
    compatible: bool
    reason: str | None = None
    detail: str | None = None


@dataclass(frozen=True)
class RestoreStaging:
    staging_root: Path
    actions: tuple[dict[str, object], ...]


@dataclass(frozen=True)
class RestoreApplyResult:
    changed_count: int
    target_sha256: dict[str, str]


@dataclass(frozen=True)
class RestoreOrchestratorRequest:
    filename: str
    backup_target_dir: Path
    current_app_version: str
    current_schema_version: int | str | None
    restore_roots: Mapping[str, Path]
    required_roles: Iterable[str]
    staging_parent: Path
    backup_parent: Path
    ledger_id: str
    restart_command: Iterable[str] | None = None
    ledger_path: Path | None = None
    reauth_jwt_secret_path: Path | None = None
    reauth_sessions_db_path: Path | None = None
    recovery_private_key_path: Path | None = None


class MaintenanceLock:
    """Coordinate restore maintenance with ordinary in-process mutations."""

    def __init__(self) -> None:
        self._lock = Lock()
        self._active_operation: str | None = None
        self._active_mutations = 0

    @property
    def active_operation(self) -> str | None:
        return self.snapshot().operation

    def snapshot(self) -> MaintenanceState:
        with self._lock:
            operation = self._active_operation
            return MaintenanceState(
                active=operation is not None,
                operation=operation,
                # Online backup is designed to coexist with writes. Restore is
                # the destructive replacement/validation window.
                blocks_mutations=operation == "restore",
            )

    def acquire(self, operation: str) -> "_MaintenanceLease":
        with self._lock:
            if self._active_operation is not None:
                raise MaintenanceConflict(self._active_operation, operation)
            if operation == "restore" and self._active_mutations:
                raise MaintenanceConflict("ordinary_mutation", operation)
            self._active_operation = operation
        return _MaintenanceLease(self, operation)

    def acquire_mutation(self, operation: str) -> "_MutationLease":
        """Admit a normal mutation unless restore has closed the gate."""
        with self._lock:
            if self._active_operation == "restore":
                raise MaintenanceConflict("restore", operation)
            self._active_mutations += 1
        return _MutationLease(self)

    def reset_for_startup(self) -> None:
        """Clear process-local state whenever a new app lifespan starts."""
        with self._lock:
            self._active_operation = None
            self._active_mutations = 0

    def _release(self, operation: str) -> None:
        with self._lock:
            if self._active_operation == operation:
                self._active_operation = None

    def _release_mutation(self) -> None:
        with self._lock:
            if self._active_mutations:
                self._active_mutations -= 1


@dataclass(frozen=True)
class _MaintenanceLease:
    lock: MaintenanceLock
    operation: str

    def __enter__(self) -> "_MaintenanceLease":
        return self

    def __exit__(self, _exc_type: object, _exc: object, _tb: object) -> None:
        self.lock._release(self.operation)


@dataclass(frozen=True)
class _MutationLease:
    lock: MaintenanceLock

    def __enter__(self) -> "_MutationLease":
        return self

    def __exit__(self, _exc_type: object, _exc: object, _tb: object) -> None:
        self.lock._release_mutation()


@contextmanager
def cross_process_maintenance_lease(lock_path: Path, operation: str):
    """Serialize backup/restore maintenance across API and timer processes."""
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(lock_path, os.O_RDWR | os.O_CREAT, 0o600)
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise MaintenanceConflict("cross_process_maintenance", operation) from exc
        yield
    finally:
        try:
            fcntl.flock(fd, fcntl.LOCK_UN)
        finally:
            os.close(fd)


def open_restore_backup(
    *,
    backup_target_dir: Path,
    filename: str,
    recovery_private_key_path: Path | None = None,
    staging_parent: Path | None = None,
) -> RestoreBackup:
    """Open a published backup and its manifest after listBackups-equivalent filtering."""
    if not _is_list_backups_safe_name(filename):
        log.warning("restore rejected unsafe backup filename: %r", filename)
        raise RestoreBlocked("unsafe backup filename")

    root = backup_target_dir.resolve()
    archive_path = (root / filename).resolve()
    try:
        archive_path.relative_to(root)
    except ValueError as exc:
        log.warning("restore rejected path escaping backup target: %s", archive_path)
        raise RestoreBlocked("backup filename escapes target root", path=archive_path) from exc

    if not archive_path.is_file():
        raise RestoreBlocked("backup archive not found", path=archive_path)
    if archive_path.name.endswith(".hcbk"):
        if recovery_private_key_path is None:
            raise RestoreBlocked("backup recovery key is not mounted")
        try:
            bundle = decrypt_encrypted_backup(
                encrypted_path=archive_path,
                recovery_private_key_path=recovery_private_key_path,
                staging_parent=staging_parent or backup_target_dir / ".restore-decrypt",
            )
        except (BackupCryptoError, OSError, ValueError, json.JSONDecodeError) as exc:
            raise RestoreBlocked(
                "encrypted backup authentication failed",
                path=archive_path,
            ) from exc
        return RestoreBackup(
            archive_path=bundle.archive_path,
            manifest_path=bundle.manifest_path,
            manifest=bundle.manifest,
            source_path=archive_path,
            cleanup_paths=bundle.cleanup_paths,
        )

    manifest_path = archive_path.with_name(f"{archive_path.name}.manifest.json")
    if not manifest_path.is_file():
        raise RestoreBlocked("backup manifest not found", path=manifest_path)

    try:
        with tarfile.open(archive_path, "r:gz"):
            pass
    except tarfile.TarError as exc:
        raise RestoreBlocked("backup archive cannot be opened", path=archive_path) from exc

    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise RestoreBlocked("backup manifest cannot be opened", path=manifest_path) from exc

    return RestoreBackup(
        archive_path=archive_path,
        manifest_path=manifest_path,
        manifest=validate_manifest(manifest),
        source_path=archive_path,
    )


def restore_api_response_from_orchestrator(
    request: RestoreOrchestratorRequest,
    *,
    maintenance_lock: MaintenanceLock | None = None,
    restart_runner: Callable[[list[str]], object] | None = None,
) -> dict[str, object]:
    """Compose B10-B16 restore steps into a route-ready response body."""
    restore: RestoreBackup | None = None
    compatibility = RestoreCompatibilityResult(False, "not_run")
    response: dict[str, object] | None = None
    apply_started = False
    status = "not_restored"
    reason: str | None = None

    try:
        lease = (
            maintenance_lock.acquire("restore")
            if maintenance_lock is not None
            else _NullLease()
        )
        with lease:
            with cross_process_maintenance_lease(
                request.backup_target_dir / ".maintenance.lock",
                "restore",
            ):
                restore = open_restore_backup(
                    backup_target_dir=request.backup_target_dir,
                    filename=request.filename,
                    recovery_private_key_path=request.recovery_private_key_path,
                    staging_parent=request.staging_parent,
                )
                compatibility = check_restore_compatibility(
                    restore.manifest,
                    current_app_version=request.current_app_version,
                    current_schema_version=request.current_schema_version,
                )
                if not compatibility.compatible:
                    reason = compatibility.reason or "incompatible_backup"
                    response = _restore_not_restored(
                        reason=compatibility.reason or "incompatible_backup",
                        phase="compatibility",
                        detail=compatibility.detail,
                    )
                    return response

                staging = stage_restore_archive(
                    restore,
                    restore_roots=request.restore_roots,
                    required_roles=request.required_roles,
                    staging_parent=request.staging_parent,
                )
                apply_started = True
                apply_result = apply_staged_restore(
                    staging,
                    backup_parent=request.backup_parent,
                    validators=[validate_restored_state],
                )

                if (
                    request.reauth_jwt_secret_path is not None
                    or request.reauth_sessions_db_path is not None
                ):
                    if (
                        request.reauth_jwt_secret_path is None
                        or request.reauth_sessions_db_path is None
                    ):
                        raise RestoreBlocked("incomplete restore reauthentication policy")
                    force_reauthentication(
                        jwt_secret_path=request.reauth_jwt_secret_path,
                        sessions_db_path=request.reauth_sessions_db_path,
                    )

                restart_required = request.restart_command is not None
                restart_applied = False
                if request.restart_command is not None and restart_runner is not None:
                    run_restart_handoff(request.restart_command, runner=restart_runner)
                    restart_applied = True

                response = {
                    "ok": True,
                    "restored": True,
                    "status": "restored",
                    "filename": restore.source_path.name,
                    "manifest_id": sha256_file(restore.manifest_path),
                    "changed_file_count": apply_result.changed_count,
                    "restart_required": restart_required,
                    "restart_applied": restart_applied,
                    "ledger_id": request.ledger_id,
                }
                status = "restored"
                return response
    except MaintenanceConflict as exc:
        reason = "maintenance_conflict"
        response = _restore_not_restored(
            reason="maintenance_conflict",
            phase="maintenance_lock",
            detail=str(exc),
        )
        response["maintenance"] = exc.response()
        return response
    except RestoreBlocked as exc:
        reason = exc.reason
        response = _restore_not_restored(
            reason=exc.reason,
            phase="restore",
            detail=str(exc.path) if exc.path is not None else exc.role,
        )
        return response
    except (OSError, tarfile.TarError, ValueError) as exc:
        reason = exc.__class__.__name__
        response = _restore_not_restored(
            reason=exc.__class__.__name__,
            phase="restore",
            detail=str(exc),
        )
        return response
    finally:
        if request.ledger_path is not None:
            manifest = restore.manifest if restore is not None else None
            archive_digest = None
            if restore is not None and restore.source_path.exists():
                try:
                    archive_digest = sha256_file(restore.source_path)
                except OSError:
                    archive_digest = None
            changed_count = 0
            if response is not None:
                changed_count = int(response.get("changed_file_count", 0) or 0)
            restart_health = "not_run"
            if response is not None and response.get("restart_applied"):
                restart_health = "restart_handoff_applied"
            elif response is not None and response.get("restart_required"):
                restart_health = "restart_deferred"
            rollback_status = "not_needed"
            if not (response and response.get("ok")):
                rollback_status = "rolled_back" if apply_started else "not_run"
            append_attempt(
                request.ledger_path,
                attempt_id=request.ledger_id,
                operation="restore",
                ok=bool(response and response.get("ok")),
                status=status,
                reason=reason,
                metadata=attempt_metadata(
                    manifest,
                    archive_digest=archive_digest,
                    compatibility_decision=(
                        "compatible" if compatibility.compatible else (
                            compatibility.reason or "not_run"
                        )
                    ),
                    changed_files_count=changed_count,
                    restart_health_result=restart_health,
                    rollback_status=rollback_status,
                ),
            )
        if restore is not None:
            for cleanup_path in restore.cleanup_paths:
                try:
                    cleanup_path.unlink()
                except OSError:
                    pass


def check_restore_compatibility(
    manifest: dict[str, Any],
    *,
    current_app_version: str,
    current_schema_version: int | str | None = None,
) -> RestoreCompatibilityResult:
    """Compare restore metadata before any archive extraction is attempted."""
    if not isinstance(manifest, dict):
        return RestoreCompatibilityResult(False, "invalid_manifest", "manifest must be an object")
    if manifest.get("v") != MANIFEST_VERSION:
        return RestoreCompatibilityResult(False, "manifest_version_mismatch")
    try:
        manifest = validate_manifest(manifest)
    except ValueError as exc:
        return RestoreCompatibilityResult(False, "invalid_manifest", str(exc))

    if manifest["app_version"] != current_app_version:
        return RestoreCompatibilityResult(False, "app_version_mismatch")

    manifest_schema_version = manifest.get("schema_version")
    if manifest_schema_version != current_schema_version:
        return RestoreCompatibilityResult(False, "schema_version_mismatch")
    return RestoreCompatibilityResult(True)


def dry_run_restore(
    restore: RestoreBackup,
    *,
    restore_roots: Mapping[str, Path],
    required_roles: Iterable[str],
) -> dict[str, object]:
    """Validate archive bytes and build a restore plan without writing files."""
    manifest = validate_manifest(restore.manifest)
    archive_sha256 = manifest.get("archive_sha256")
    if archive_sha256 is not None and archive_sha256 != _sha256_file(restore.archive_path):
        raise RestoreBlocked("backup archive checksum mismatch", path=restore.archive_path)

    required_role_set = set(required_roles)
    present_required_roles = {
        item["role"]
        for item in manifest["files"]
        if item.get("required") and not item.get("absent", False)
    }
    missing_roles = sorted(required_role_set - present_required_roles)
    if missing_roles:
        raise RestoreBlocked("backup missing required roles", role=",".join(missing_roles))

    actions: list[dict[str, object]] = []
    planned_paths: set[Path] = set()
    with tarfile.open(restore.archive_path, "r:gz") as archive:
        members_by_name = {member.name: member for member in archive.getmembers()}
        for item in manifest["files"]:
            if item.get("absent", False):
                continue
            member_name = item["path"]
            _reject_unsafe_archive_name(member_name)
            member = members_by_name.get(member_name)
            if member is None:
                raise RestoreBlocked("backup archive missing manifest file")
            if not member.isfile():
                raise RestoreBlocked("backup archive member is not a regular file")
            if member.size != item["size"]:
                raise RestoreBlocked("backup archive member size mismatch")

            extracted = archive.extractfile(member)
            if extracted is None:
                raise RestoreBlocked("backup archive member cannot be read")
            digest = _sha256_stream(extracted)
            if digest != item["sha256"]:
                raise RestoreBlocked("backup archive member checksum mismatch")

            target_root = restore_roots.get(item["role"])
            if target_root is None:
                raise RestoreBlocked("no restore target root for role", role=item["role"])
            target_path = _target_path_for_manifest_item(target_root, member_name)
            if target_path in planned_paths:
                raise RestoreBlocked("duplicate restore target path", path=target_path)
            planned_paths.add(target_path)
            actions.append(
                {
                    "role": item["role"],
                    "source": member_name,
                    "target_path": str(target_path),
                    "size": item["size"],
                    "sha256": item["sha256"],
                    "mode": item["mode"],
                    "action": "write",
                }
            )

    return {
        "ok": True,
        "dry_run": True,
        "archive": restore.archive_path.name,
        "actions": actions,
    }


def stage_restore_archive(
    restore: RestoreBackup,
    *,
    restore_roots: Mapping[str, Path],
    required_roles: Iterable[str],
    staging_parent: Path,
) -> RestoreStaging:
    """Extract verified archive members under a temp staging root."""
    plan = dry_run_restore(
        restore,
        restore_roots=restore_roots,
        required_roles=required_roles,
    )
    staging_parent.mkdir(parents=True, exist_ok=True)
    staging_root = Path(mkdtemp(prefix="homecam-restore-", dir=staging_parent))
    staged_actions: list[dict[str, object]] = []

    try:
        with tarfile.open(restore.archive_path, "r:gz") as archive:
            members_by_name = {member.name: member for member in archive.getmembers()}
            for action in plan["actions"]:
                source = str(action["source"])
                _reject_unsafe_archive_name(source)
                member = members_by_name[source]
                staged_path = (staging_root / source).resolve()
                try:
                    staged_path.relative_to(staging_root)
                except ValueError as exc:
                    raise RestoreBlocked("staged path escapes staging root") from exc
                staged_path.parent.mkdir(parents=True, exist_ok=True)
                extracted = archive.extractfile(member)
                if extracted is None:
                    raise RestoreBlocked("backup archive member cannot be read")
                with staged_path.open("wb") as out:
                    shutil.copyfileobj(extracted, out)
                os.chmod(staged_path, int(action["mode"]))
                digest = _sha256_file(staged_path)
                if digest != action["sha256"]:
                    raise RestoreBlocked("staged file checksum mismatch")
                enriched = dict(action)
                enriched["staged_path"] = str(staged_path)
                staged_actions.append(enriched)
    except Exception:
        shutil.rmtree(staging_root, ignore_errors=True)
        raise

    return RestoreStaging(
        staging_root=staging_root,
        actions=tuple(staged_actions),
    )


def apply_staged_restore(
    staging: RestoreStaging,
    *,
    backup_parent: Path,
    validators: Iterable[Callable[[RestoreStaging], None]] = (),
    replace: Callable[[str, str], None] = os.replace,
) -> RestoreApplyResult:
    """Replace live files from staging; rollback restores pre-restore bytes."""
    backup_parent.mkdir(parents=True, exist_ok=True)
    backup_root = Path(mkdtemp(prefix="homecam-pre-restore-", dir=backup_parent))
    applied: list[tuple[Path, Path | None]] = []

    try:
        for index, action in enumerate(staging.actions):
            target_path = Path(str(action["target_path"]))
            staged_path = Path(str(action["staged_path"]))
            target_path.parent.mkdir(parents=True, exist_ok=True)
            backup_path: Path | None = None
            if target_path.exists():
                backup_path = backup_root / str(index)
                backup_path.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(target_path, backup_path)
            replace(str(staged_path), str(target_path))
            os.chmod(target_path, int(action["mode"]))
            applied.append((target_path, backup_path))

        for validator in validators:
            validator(staging)

        return RestoreApplyResult(
            changed_count=len(applied),
            target_sha256={
                str(target): _sha256_file(target)
                for target, _backup in applied
                if target.exists()
            },
        )
    except Exception:
        _rollback_applied(applied)
        raise
    finally:
        shutil.rmtree(backup_root, ignore_errors=True)


def validate_restored_state(staging: RestoreStaging) -> None:
    """Validate restored persisted files with offline real loaders where possible."""
    role_paths = {
        str(action["role"]): Path(str(action["target_path"]))
        for action in staging.actions
    }

    users_db_path = role_paths.get("users_db")
    if users_db_path is not None:
        _validate_sqlite_integrity(users_db_path, "users_db")
        from app.auth import users_db

        users_db.init_db(users_db_path)
        users_db.count_users(users_db_path)

    for role in ("events_db", "audit_db"):
        sqlite_path = role_paths.get(role)
        if sqlite_path is not None:
            _validate_sqlite_integrity(sqlite_path, role)

    detection_config_path = role_paths.get("detection_config")
    if detection_config_path is not None:
        _require_json_type(detection_config_path, dict)
        from app.services.detection_config import DetectionConfigStore

        DetectionConfigStore(path=detection_config_path).get()

    security_state_path = role_paths.get("security_state")
    if security_state_path is not None:
        payload = _require_json_type(security_state_path, dict)
        # Generated exports are deliberately absent from backups. Never revive
        # their absolute paths or transient reservations from a restored state
        # file; a normal server restart may preserve live ready jobs, while a
        # restore always resets this explicitly ephemeral collection.
        if isinstance(payload.get("timeline_exports"), dict) and payload[
            "timeline_exports"
        ]:
            payload["timeline_exports"] = {}
            _atomic_write_json(security_state_path, payload)

    push_subs_path = role_paths.get("push_subs")
    if push_subs_path is not None:
        _require_json_type(push_subs_path, list)
        from app.services.push_service import PushService

        PushService(persist_path=push_subs_path)

    for role, expected_type in (
        ("clip_shares", dict),
        ("digest_state", dict),
        ("camera_exposure", dict),
        ("camera_exposure_presets", list),
    ):
        state_path = role_paths.get(role)
        if state_path is not None:
            _require_json_type(state_path, expected_type)

    jwt_secret_path = role_paths.get("jwt_secret")
    if jwt_secret_path is not None:
        from app.auth import jwt_secret

        if not jwt_secret_path.exists() or len(jwt_secret_path.read_bytes()) != 32:
            raise RestoreBlocked("invalid restored jwt secret", path=jwt_secret_path)
        if jwt_secret.load_or_generate(jwt_secret_path) != jwt_secret_path.read_bytes():
            raise RestoreBlocked("invalid restored jwt secret", path=jwt_secret_path)

    _validate_vapid_keys(
        role_paths.get("vapid_private_key"),
        role_paths.get("vapid_public_key"),
    )


def force_reauthentication(*, jwt_secret_path: Path, sessions_db_path: Path) -> None:
    """Invalidate every pre-restore token and discard stale session metadata."""
    from app.auth import jwt_secret
    from app.sessions import sessions_db

    try:
        # Rotate first. If the process stops before the metadata cleanup, every
        # old access/refresh token is already cryptographically invalid.
        jwt_secret.rotate(jwt_secret_path)
        sessions_db.clear_all(sessions_db_path)
    except (OSError, sqlite3.Error) as exc:
        raise RestoreBlocked("restore could not force reauthentication") from exc


def _validate_sqlite_integrity(path: Path, role: str) -> None:
    try:
        with sqlite3.connect(str(path), timeout=30.0) as conn:
            rows = [str(row[0]) for row in conn.execute("PRAGMA integrity_check")]
    except sqlite3.Error as exc:
        raise RestoreBlocked(
            "invalid restored SQLite database",
            path=path,
            role=role,
        ) from exc
    if rows != ["ok"]:
        raise RestoreBlocked(
            "restored SQLite integrity_check failed",
            path=path,
            role=role,
        )


def run_restart_handoff(
    argv: Iterable[str],
    *,
    runner: Callable[[list[str]], object],
) -> object:
    """Invoke an injected restart runner with argv only, never a shell string."""
    if isinstance(argv, str):
        raise ValueError("restart command must be an argv list, not a shell string")
    command = list(argv)
    if not command or not all(isinstance(part, str) and part for part in command):
        raise ValueError("restart command must be a non-empty argv list")
    return runner(command)


@dataclass(frozen=True)
class _NullLease:
    def __enter__(self) -> "_NullLease":
        return self

    def __exit__(self, _exc_type: object, _exc: object, _tb: object) -> None:
        return None


def _restore_not_restored(
    *,
    reason: str,
    phase: str,
    detail: str | None = None,
) -> dict[str, object]:
    body: dict[str, object] = {
        "ok": False,
        "restored": False,
        "status": "not_restored",
        "reason": reason,
        "phase": phase,
    }
    if detail:
        body["detail"] = detail
    return body


def _is_list_backups_safe_name(filename: str) -> bool:
    return bool(re.fullmatch(LIST_BACKUPS_FILENAME_PATTERN, filename)) and (
        filename.endswith(".hcbk") or filename.endswith(".tar.gz")
    )


def _reject_unsafe_archive_name(name: str) -> None:
    path = Path(name)
    if path.is_absolute() or ".." in path.parts or not name or name != path.as_posix():
        raise RestoreBlocked("unsafe archive member name")


def _target_path_for_manifest_item(target_root: Path, manifest_path: str) -> Path:
    role_relative_parts = Path(manifest_path).parts[1:]
    if not role_relative_parts:
        raise RestoreBlocked("manifest file path has no role-relative target")
    root = target_root.resolve()
    target_path = root.joinpath(*role_relative_parts).resolve()
    try:
        target_path.relative_to(root)
    except ValueError as exc:
        raise RestoreBlocked("restore target escapes role root", path=target_path) from exc
    return target_path


def _sha256_stream(stream: Any) -> str:
    digest = hashlib.sha256()
    for chunk in iter(lambda: stream.read(1024 * 1024), b""):
        digest.update(chunk)
    return digest.hexdigest()


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _rollback_applied(applied: list[tuple[Path, Path | None]]) -> None:
    for target_path, backup_path in reversed(applied):
        if backup_path is None:
            try:
                target_path.unlink()
            except FileNotFoundError:
                pass
            continue
        os.replace(str(backup_path), str(target_path))


def _require_json_type(path: Path, expected_type: type) -> object:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise RestoreBlocked("invalid restored json", path=path) from exc
    if not isinstance(payload, expected_type):
        raise RestoreBlocked("invalid restored json shape", path=path)
    return payload


def _atomic_write_json(path: Path, payload: object) -> None:
    temp = path.with_suffix(path.suffix + ".normalize.tmp")
    data = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")
    try:
        with temp.open("wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temp, 0o600)
        os.replace(temp, path)
    finally:
        try:
            temp.unlink(missing_ok=True)
        except OSError:
            pass


def _validate_vapid_keys(private_path: Path | None, public_path: Path | None) -> None:
    if private_path is None and public_path is None:
        return
    if private_path is None or public_path is None:
        raise RestoreBlocked("incomplete restored VAPID keypair")
    try:
        from cryptography.hazmat.primitives import serialization
        from py_vapid import Vapid

        private_pem = private_path.read_bytes()
        public_pem = public_path.read_bytes()
        Vapid.from_pem(private_pem)
        serialization.load_pem_public_key(public_pem)
    except Exception as exc:
        raise RestoreBlocked("invalid restored VAPID keypair") from exc
