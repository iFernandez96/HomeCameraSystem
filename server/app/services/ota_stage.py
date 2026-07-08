"""Versioned OTA artifact staging."""
from __future__ import annotations

import json
import logging
import os
import re
import shutil
import tarfile
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

log = logging.getLogger(__name__)

_VERSION_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._+-]*$")


@dataclass(frozen=True)
class StageArtifactResult:
    status: str
    version: str
    staging_dir: Path | None = None
    reason: str | None = None

    @property
    def can_apply(self) -> bool:
        return self.status == "staged" and self.staging_dir is not None


def _default_clock() -> datetime:
    return datetime.now(UTC)


def _atomic_write_json(path: Path, payload: dict[str, object]) -> None:
    tmp = path.with_name(f"{path.name}.tmp")
    tmp.write_text(
        json.dumps(payload, sort_keys=True, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )
    os.replace(tmp, path)


def _reject(version: str, reason: str) -> StageArtifactResult:
    log.warning("rejecting OTA artifact staging version=%s reason=%s", version, reason)
    return StageArtifactResult(status="rejected", version=version, reason=reason)


def _safe_extract_tar(artifact_path: Path, destination: Path) -> bool:
    try:
        with tarfile.open(artifact_path) as archive:
            destination_resolved = destination.resolve()
            for member in archive.getmembers():
                member_path = (destination / member.name).resolve()
                if (
                    member.name.startswith("/")
                    or member_path != destination_resolved
                    and destination_resolved not in member_path.parents
                ):
                    log.warning(
                        "rejecting OTA artifact staging path=%s reason=%s member=%s",
                        artifact_path,
                        "unsafe_tar_member",
                        member.name,
                    )
                    return False
            archive.extractall(destination)
    except (OSError, tarfile.TarError):
        return False
    return True


def stage_artifact_to_versioned_dir(
    artifact_path: Path,
    *,
    version: str,
    staging_root: Path,
    clock: Callable[[], datetime | str] = _default_clock,
) -> StageArtifactResult:
    """Copy or unpack an artifact into ``staging_root/<version>`` atomically.

    Directory artifacts are copied recursively. Tar artifacts are extracted with
    path traversal checks. The live deploy directory and persisted data
    directory are intentionally not accepted as parameters, keeping this slice
    limited to caller-provided scratch paths.
    """
    clean_version = version.strip()
    if _VERSION_RE.fullmatch(clean_version) is None:
        return _reject(version, "malformed_version")

    if not artifact_path.exists():
        return _reject(clean_version, "missing_artifact")

    staging_root.mkdir(parents=True, exist_ok=True)
    final_dir = staging_root / clean_version
    tmp_dir = staging_root / f".{clean_version}.tmp"
    if final_dir.exists():
        return _reject(clean_version, "staging_version_exists")
    if tmp_dir.exists():
        shutil.rmtree(tmp_dir)
    tmp_dir.mkdir()

    try:
        if artifact_path.is_dir():
            shutil.copytree(artifact_path, tmp_dir, dirs_exist_ok=True)
        else:
            if not _safe_extract_tar(artifact_path, tmp_dir):
                shutil.rmtree(tmp_dir, ignore_errors=True)
                return _reject(clean_version, "artifact_unpack_failed")

        created_at = clock()
        if isinstance(created_at, datetime):
            if created_at.tzinfo is None:
                created_at = created_at.replace(tzinfo=UTC)
            created_at_value = created_at.astimezone(UTC).isoformat().replace("+00:00", "Z")
        else:
            created_at_value = created_at
        _atomic_write_json(
            tmp_dir / ".ota-stage.json",
            {
                "artifact_path": str(artifact_path),
                "created_at": created_at_value,
                "version": clean_version,
            },
        )
        os.replace(tmp_dir, final_dir)
    except OSError:
        shutil.rmtree(tmp_dir, ignore_errors=True)
        return _reject(clean_version, "stage_write_failed")

    log.info("ota artifact staged version=%s staging_dir=%s", clean_version, final_dir)
    return StageArtifactResult(
        status="staged", version=clean_version, staging_dir=final_dir
    )
