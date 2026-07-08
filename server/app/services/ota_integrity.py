"""Local OTA artifact integrity checks."""
from __future__ import annotations

import hashlib
import logging
from dataclasses import dataclass
from pathlib import Path

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class ArtifactIntegrityResult:
    status: str
    path: Path
    size: int | None = None
    sha256: str | None = None
    reason: str | None = None

    @property
    def can_apply(self) -> bool:
        return self.status == "verified"


def verify_local_artifact(
    path: Path, *, expected_size: int, expected_sha256: str
) -> ArtifactIntegrityResult:
    """Verify a local artifact's byte size and sha256 without writing anywhere."""
    if expected_size < 0:
        log.warning(
            "rejecting OTA artifact integrity check path=%s reason=%s",
            path,
            "malformed_expected_size",
        )
        return ArtifactIntegrityResult(
            status="rejected", path=path, reason="malformed_expected_size"
        )
    expected_digest = expected_sha256.strip().lower()
    if len(expected_digest) != 64 or any(ch not in "0123456789abcdef" for ch in expected_digest):
        log.warning(
            "rejecting OTA artifact integrity check path=%s reason=%s",
            path,
            "malformed_expected_sha256",
        )
        return ArtifactIntegrityResult(
            status="rejected", path=path, reason="malformed_expected_sha256"
        )

    try:
        size = path.stat().st_size
    except OSError:
        log.warning(
            "rejecting OTA artifact integrity check path=%s reason=%s",
            path,
            "missing_artifact",
        )
        return ArtifactIntegrityResult(
            status="rejected", path=path, reason="missing_artifact"
        )

    if size != expected_size:
        log.warning(
            "rejecting OTA artifact integrity check path=%s reason=%s actual=%s expected=%s",
            path,
            "size_mismatch",
            size,
            expected_size,
        )
        return ArtifactIntegrityResult(
            status="rejected", path=path, size=size, reason="size_mismatch"
        )

    digest = hashlib.sha256()
    try:
        with path.open("rb") as fh:
            for chunk in iter(lambda: fh.read(1024 * 1024), b""):
                digest.update(chunk)
    except OSError:
        log.warning(
            "rejecting OTA artifact integrity check path=%s reason=%s",
            path,
            "artifact_read_failed",
        )
        return ArtifactIntegrityResult(
            status="rejected", path=path, size=size, reason="artifact_read_failed"
        )

    actual_digest = digest.hexdigest()
    if actual_digest != expected_digest:
        log.warning(
            "rejecting OTA artifact integrity check path=%s reason=%s actual=%s expected=%s",
            path,
            "sha256_mismatch",
            actual_digest,
            expected_digest,
        )
        return ArtifactIntegrityResult(
            status="rejected",
            path=path,
            size=size,
            sha256=actual_digest,
            reason="sha256_mismatch",
        )

    return ArtifactIntegrityResult(
        status="verified", path=path, size=size, sha256=actual_digest
    )
