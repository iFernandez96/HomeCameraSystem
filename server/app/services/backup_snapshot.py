from __future__ import annotations

import os
import shutil
import sqlite3
from contextlib import contextmanager
from pathlib import Path
from tempfile import mkdtemp
from typing import Iterable, Iterator

from app.services.backup_manifest import BackupBlocked, BackupInventoryEntry


def sqlite_integrity_check(path: Path) -> None:
    """Fail unless *path* is a complete, readable SQLite database."""
    try:
        with sqlite3.connect(str(path), timeout=30.0) as conn:
            rows = [str(row[0]) for row in conn.execute("PRAGMA integrity_check")]
    except sqlite3.Error as exc:
        raise BackupBlocked(
            "SQLite snapshot could not be validated",
            path=path,
        ) from exc
    if rows != ["ok"]:
        raise BackupBlocked(
            "SQLite snapshot failed integrity_check",
            path=path,
        )


@contextmanager
def materialize_consistent_inventory(
    inventory: Iterable[BackupInventoryEntry],
    *,
    staging_parent: Path,
) -> Iterator[list[BackupInventoryEntry]]:
    """Yield immutable backup inputs and remove them after archive creation.

    SQLite sources are copied with SQLite's online backup API so committed WAL
    pages are represented without archiving a live database file or either WAL
    sidecar. Ordinary persisted files are copied to the same private staging
    tree, preventing a later atomic writer from changing bytes between manifest
    hashing and tar creation.
    """
    staging_parent.mkdir(parents=True, exist_ok=True)
    staging_root = Path(
        mkdtemp(prefix=".homecam-backup-snapshot-", dir=staging_parent)
    )
    os.chmod(staging_root, 0o700)
    materialized: list[BackupInventoryEntry] = []
    try:
        for entry in inventory:
            relative_path = _relative_source_path(entry)
            role_root = staging_root / entry.role
            target = role_root / relative_path
            role_root.mkdir(parents=True, exist_ok=True)

            if not entry.path.exists():
                if entry.required:
                    raise BackupBlocked(
                        "required persisted file is missing",
                        role=entry.role,
                        path=entry.path,
                    )
            elif not entry.path.is_file():
                raise BackupBlocked(
                    "persisted path is not a regular file",
                    role=entry.role,
                    path=entry.path,
                )
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                if entry.kind == "sqlite":
                    try:
                        _online_sqlite_backup(entry.path, target)
                    except sqlite3.Error as exc:
                        raise BackupBlocked(
                            "SQLite online backup failed",
                            role=entry.role,
                            path=entry.path,
                        ) from exc
                else:
                    shutil.copy2(entry.path, target)

            materialized.append(
                BackupInventoryEntry(
                    role=entry.role,
                    path=target,
                    allowed_root=role_root,
                    required=entry.required,
                    kind=entry.kind,
                )
            )
        yield materialized
    finally:
        shutil.rmtree(staging_root, ignore_errors=True)


def _relative_source_path(entry: BackupInventoryEntry) -> Path:
    try:
        relative = entry.path.relative_to(entry.allowed_root)
    except ValueError as exc:
        raise BackupBlocked(
            "persisted path is outside its allowed backup root",
            role=entry.role,
            path=entry.path,
        ) from exc
    if not relative.parts:
        raise BackupBlocked(
            "persisted path has no relative filename",
            role=entry.role,
            path=entry.path,
        )
    return relative


def _online_sqlite_backup(source_path: Path, target_path: Path) -> None:
    """Copy one live database without copying its WAL/SHM sidecars."""
    fd = os.open(target_path, os.O_CREAT | os.O_EXCL | os.O_RDWR, 0o600)
    os.close(fd)
    try:
        with sqlite3.connect(str(source_path), timeout=30.0) as source:
            source.execute("PRAGMA query_only=ON")
            with sqlite3.connect(str(target_path), timeout=30.0) as target:
                source.backup(target, pages=256, sleep=0.01)
                # journal_mode is persistent database metadata and the online
                # copy inherits WAL from the source. Convert the closed
                # snapshot to a standalone database so later validation never
                # creates archive-relevant WAL/SHM sidecars.
                target.execute("PRAGMA journal_mode=DELETE")
        sqlite_integrity_check(target_path)
        os.chmod(target_path, source_path.stat().st_mode & 0o777)
    except Exception:
        try:
            target_path.unlink()
        except OSError:
            pass
        raise
