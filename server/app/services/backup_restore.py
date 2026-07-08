from __future__ import annotations

import hashlib
import json
import logging
import re
import tarfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Mapping

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


@dataclass(frozen=True)
class RestoreBackup:
    archive_path: Path
    manifest_path: Path
    manifest: dict[str, Any]


@dataclass(frozen=True)
class RestoreCompatibilityResult:
    compatible: bool
    reason: str | None = None
    detail: str | None = None


def open_restore_backup(*, backup_target_dir: Path, filename: str) -> RestoreBackup:
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

    manifest_path = archive_path.with_name(f"{archive_path.name}.manifest.json")
    if not archive_path.is_file():
        raise RestoreBlocked("backup archive not found", path=archive_path)
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
    )


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


def _is_list_backups_safe_name(filename: str) -> bool:
    return bool(re.fullmatch(LIST_BACKUPS_FILENAME_PATTERN, filename))


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
