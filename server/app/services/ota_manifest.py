"""Local OTA update manifest reader.

This slice intentionally reads only a caller-provided local JSON file. Network
discovery, artifact verification, and route wiring are later OTA steps.
"""
from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass
from pathlib import Path

log = logging.getLogger(__name__)

_SHA256_RE = re.compile(r"^[0-9a-fA-F]{64}$")


@dataclass(frozen=True)
class OtaArtifact:
    name: str
    sha256: str


@dataclass(frozen=True)
class OtaManifest:
    version: str
    artifact: OtaArtifact


@dataclass(frozen=True)
class ManifestReadResult:
    status: str
    manifest: OtaManifest | None = None
    reason: str | None = None

    @property
    def can_apply(self) -> bool:
        return self.status == "available" and self.manifest is not None


def _unavailable(reason: str, path: Path) -> ManifestReadResult:
    log.warning("OTA manifest unavailable path=%s reason=%s", path, reason)
    return ManifestReadResult(status="unavailable", reason=reason)


def read_local_manifest(path: Path) -> ManifestReadResult:
    """Read and validate a local update manifest JSON file.

    Required schema:
    ``{"version": "...", "artifact": {"name": "...", "sha256": "..."}}``.
    Missing or malformed input returns ``unavailable`` instead of raising so an
    apply caller can stop before touching deploy files.
    """
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return _unavailable("missing", path)

    try:
        raw = json.loads(text)
    except json.JSONDecodeError:
        return _unavailable("malformed_json", path)

    if not isinstance(raw, dict):
        return _unavailable("not_object", path)

    version = raw.get("version")
    artifact = raw.get("artifact")
    if not isinstance(version, str) or not version.strip():
        return _unavailable("missing_version", path)
    if not isinstance(artifact, dict):
        return _unavailable("missing_artifact", path)

    name = artifact.get("name")
    sha256 = artifact.get("sha256")
    if not isinstance(name, str) or not name.strip():
        return _unavailable("missing_artifact_name", path)
    clean_name = name.strip()
    if Path(clean_name).name != clean_name:
        return _unavailable("malformed_artifact_name", path)
    if not isinstance(sha256, str) or _SHA256_RE.fullmatch(sha256.strip()) is None:
        return _unavailable("malformed_sha256", path)

    manifest = OtaManifest(
        version=version.strip(),
        artifact=OtaArtifact(name=clean_name, sha256=sha256.strip().lower()),
    )
    return ManifestReadResult(status="available", manifest=manifest)
