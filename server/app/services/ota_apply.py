"""OTA active-version pointer transaction."""
from __future__ import annotations

import logging
import os
import re
import shutil
from dataclasses import dataclass
from pathlib import Path

log = logging.getLogger(__name__)

_VERSION_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._+-]*$")


@dataclass(frozen=True)
class ApplyTransactionResult:
    status: str
    active_pointer: Path
    active_version: str | None = None
    previous_version: str | None = None
    reason: str | None = None
    client_backup_dir: Path | None = None
    applied_components: tuple[str, ...] = ()
    host_commands: tuple[str, ...] = ()

    @property
    def can_restart(self) -> bool:
        return self.status == "applied"


def _read_pointer(path: Path) -> str | None:
    try:
        value = path.read_text(encoding="utf-8").strip()
    except OSError:
        return None
    return value or None


def planned_host_commands(
    *, staged_version_dir: Path, restart_command: tuple[str, ...]
) -> tuple[str, ...]:
    detection_source = staged_version_dir / "detection"
    commands = [
        f"rsync -a --delete {detection_source.as_posix()}/ ./detection/",
    ]
    if restart_command:
        commands.append(" ".join(restart_command))
    return tuple(commands)


def _copy_children(source: Path, target: Path) -> None:
    for child in source.iterdir():
        destination = target / child.name
        if child.is_dir():
            shutil.copytree(child, destination, symlinks=False)
        else:
            shutil.copy2(child, destination)


def _clear_children(target: Path) -> None:
    for child in target.iterdir():
        if child.is_dir():
            shutil.rmtree(child)
        else:
            child.unlink()


def _restore_client_dist(*, target: Path, backup_dir: Path) -> bool:
    try:
        _clear_children(target)
        _copy_children(backup_dir, target)
    except OSError:
        log.warning("rejecting OTA client dist restore reason=%s", "client_restore_failed")
        return False
    return True


def restore_client_dist_backup(*, target: Path, backup_dir: Path | None) -> bool:
    if backup_dir is None or not backup_dir.is_dir() or not target.is_dir():
        return False
    return _restore_client_dist(target=target, backup_dir=backup_dir)


def apply_staged_client_dist(
    *,
    active_pointer: Path,
    version: str,
    staged_version_dir: Path,
    client_dist_target: Path,
    restart_command: tuple[str, ...],
) -> ApplyTransactionResult:
    """Partially apply a staged OTA by replacing the served client dist bytes."""
    clean_version = version.strip()
    previous = _read_pointer(active_pointer)
    if _VERSION_RE.fullmatch(clean_version) is None:
        log.warning("rejecting OTA apply transaction reason=%s version=%s", "malformed_version", version)
        return ApplyTransactionResult(
            status="rejected",
            active_pointer=active_pointer,
            previous_version=previous,
            reason="malformed_version",
        )

    source = staged_version_dir / "client" / "dist"
    if not (source / "index.html").is_file():
        log.warning(
            "rejecting OTA apply transaction reason=%s staged_version_dir=%s",
            "missing_staged_client_dist",
            staged_version_dir,
        )
        return ApplyTransactionResult(
            status="rejected",
            active_pointer=active_pointer,
            previous_version=previous,
            reason="missing_staged_client_dist",
        )
    if not client_dist_target.is_dir():
        return ApplyTransactionResult(
            status="rejected",
            active_pointer=active_pointer,
            previous_version=previous,
            reason="missing_client_dist_target",
        )

    backup_dir = staged_version_dir / ".ota-client-dist-backup"
    if backup_dir.exists():
        shutil.rmtree(backup_dir)
    try:
        shutil.copytree(client_dist_target, backup_dir, symlinks=False)
        _clear_children(client_dist_target)
        _copy_children(source, client_dist_target)
    except OSError:
        if backup_dir.is_dir():
            _restore_client_dist(target=client_dist_target, backup_dir=backup_dir)
        log.warning("rejecting OTA apply transaction reason=%s", "client_dist_apply_failed")
        return ApplyTransactionResult(
            status="rejected",
            active_pointer=active_pointer,
            previous_version=previous,
            reason="client_dist_apply_failed",
            client_backup_dir=backup_dir if backup_dir.is_dir() else None,
        )

    pointer_result = switch_active_version_pointer(
        active_pointer=active_pointer,
        version=clean_version,
        staged_version_dir=staged_version_dir,
    )
    if not pointer_result.can_restart:
        _restore_client_dist(target=client_dist_target, backup_dir=backup_dir)
        return pointer_result

    return ApplyTransactionResult(
        status="applied",
        active_pointer=active_pointer,
        active_version=clean_version,
        previous_version=previous,
        client_backup_dir=backup_dir,
        applied_components=("client",),
        host_commands=planned_host_commands(
            staged_version_dir=staged_version_dir,
            restart_command=restart_command,
        ),
    )


def switch_active_version_pointer(
    *,
    active_pointer: Path,
    version: str,
    staged_version_dir: Path,
) -> ApplyTransactionResult:
    """Atomically publish the single active-version marker file."""
    clean_version = version.strip()
    previous = _read_pointer(active_pointer)
    if _VERSION_RE.fullmatch(clean_version) is None:
        log.warning("rejecting OTA apply transaction reason=%s version=%s", "malformed_version", version)
        return ApplyTransactionResult(
            status="rejected",
            active_pointer=active_pointer,
            previous_version=previous,
            reason="malformed_version",
        )
    if not staged_version_dir.is_dir():
        log.warning(
            "rejecting OTA apply transaction reason=%s staged_version_dir=%s",
            "missing_staged_version_dir",
            staged_version_dir,
        )
        return ApplyTransactionResult(
            status="rejected",
            active_pointer=active_pointer,
            previous_version=previous,
            reason="missing_staged_version_dir",
        )

    active_pointer.parent.mkdir(parents=True, exist_ok=True)
    tmp = active_pointer.with_name(f"{active_pointer.name}.tmp")
    try:
        tmp.write_text(clean_version + "\n", encoding="utf-8")
        os.replace(tmp, active_pointer)
    except OSError:
        try:
            tmp.unlink()
        except OSError:
            pass
        log.warning("rejecting OTA apply transaction reason=%s", "active_pointer_write_failed")
        return ApplyTransactionResult(
            status="rejected",
            active_pointer=active_pointer,
            previous_version=previous,
            reason="active_pointer_write_failed",
        )

    log.info(
        "ota active pointer switched previous_version=%s active_version=%s path=%s",
        previous,
        clean_version,
        active_pointer,
    )
    return ApplyTransactionResult(
        status="applied",
        active_pointer=active_pointer,
        active_version=clean_version,
        previous_version=previous,
    )
