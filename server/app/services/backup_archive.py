from __future__ import annotations

import hashlib
import json
import os
import re
import tarfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

from app.services.backup_manifest import BackupInventoryEntry, validate_manifest

_BACKUP_NAME_RE = re.compile(r"^homecam-backup-[0-9]{8}T[0-9]{6}Z\.tar\.gz$")


@dataclass(frozen=True)
class BackupArchiveDraft:
    archive_tmp_path: Path
    manifest: dict[str, Any]


@dataclass(frozen=True)
class PublishedBackup:
    archive_path: Path
    manifest_path: Path
    archive_sha256: str


def write_archive_to_temp(
    *,
    target_dir: Path,
    manifest: dict[str, Any],
    inventory: Iterable[BackupInventoryEntry],
    temp_stem: str = "homecam-backup",
) -> BackupArchiveDraft:
    """Write a backup tarball to a route-invisible temp file."""
    manifest = validate_manifest(manifest)
    target_dir.mkdir(parents=True, exist_ok=True)
    archive_tmp_path = target_dir / f"{temp_stem}.tar.gz.tmp~"
    _unlink_quiet(archive_tmp_path)

    entries_by_role = {entry.role: entry for entry in inventory}
    try:
        with tarfile.open(archive_tmp_path, "w:gz") as archive:
            for item in manifest["files"]:
                if item.get("absent", False):
                    continue
                entry = entries_by_role.get(item["role"])
                if entry is None:
                    raise ValueError(f"manifest role has no inventory entry: {item['role']}")
                archive.add(entry.path, arcname=item["path"], recursive=False)
    except Exception:
        _unlink_quiet(archive_tmp_path)
        raise

    enriched = dict(manifest)
    enriched["archive_sha256"] = sha256_file(archive_tmp_path)
    return BackupArchiveDraft(
        archive_tmp_path=archive_tmp_path,
        manifest=validate_manifest(enriched),
    )


def publish_backup_atomically(
    *,
    draft: BackupArchiveDraft,
    target_dir: Path,
    final_archive_name: str,
) -> PublishedBackup:
    """Publish temp archive and manifest with same-filesystem replaces."""
    if not _BACKUP_NAME_RE.match(final_archive_name):
        raise ValueError("final archive name is not a valid backup filename")
    target_dir.mkdir(parents=True, exist_ok=True)
    final_archive_path = target_dir / final_archive_name
    final_manifest_path = target_dir / f"{final_archive_name}.manifest.json"
    manifest_tmp_path = target_dir / f"{final_manifest_path.name}.tmp~"
    _unlink_quiet(manifest_tmp_path)

    try:
        payload = json.dumps(draft.manifest, sort_keys=True).encode("utf-8")
        manifest_tmp_path.write_bytes(payload)
        os.replace(str(manifest_tmp_path), str(final_manifest_path))
        os.replace(str(draft.archive_tmp_path), str(final_archive_path))
    except Exception:
        _unlink_quiet(manifest_tmp_path)
        _unlink_quiet(draft.archive_tmp_path)
        raise

    return PublishedBackup(
        archive_path=final_archive_path,
        manifest_path=final_manifest_path,
        archive_sha256=draft.manifest["archive_sha256"],
    )


def apply_backup_retention(
    *,
    target_dir: Path,
    keep_newest: int,
    protect: Path | None = None,
) -> list[Path]:
    """Delete old published backup archives, preserving invalid names."""
    if keep_newest < 0:
        raise ValueError("keep_newest must be non-negative")
    if not target_dir.exists():
        return []

    protect_resolved = protect.resolve() if protect is not None and protect.exists() else None
    candidates: list[Path] = []
    for child in target_dir.iterdir():
        if child.is_file() and _BACKUP_NAME_RE.match(child.name):
            candidates.append(child)
    candidates.sort(key=lambda path: (path.stat().st_mtime, path.name), reverse=True)

    deleted: list[Path] = []
    for archive_path in candidates[keep_newest:]:
        if protect_resolved is not None and archive_path.resolve() == protect_resolved:
            continue
        archive_path.unlink()
        deleted.append(archive_path)
        manifest_path = archive_path.with_name(f"{archive_path.name}.manifest.json")
        if manifest_path.exists():
            manifest_path.unlink()
            deleted.append(manifest_path)
    return deleted


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def _unlink_quiet(path: Path) -> None:
    try:
        path.unlink()
    except FileNotFoundError:
        pass
    except OSError:
        pass
