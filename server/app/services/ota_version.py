"""Current-version normalization for OTA apply decisions."""
from __future__ import annotations

import logging
import os
import re
from dataclasses import dataclass

log = logging.getLogger(__name__)

_SEMVERISH_RE = re.compile(
    r"^v?"
    r"(?P<core>0|[1-9]\d*)\.(?P<minor>0|[1-9]\d*)\.(?P<patch>0|[1-9]\d*)"
    r"(?P<prerelease>-[0-9A-Za-z][0-9A-Za-z.-]*)?"
    r"(?P<build>\+[0-9A-Za-z][0-9A-Za-z.-]*)?"
    r"$"
)


class CurrentVersionError(ValueError):
    """Raised when the running version cannot be trusted for OTA apply."""

    blocks_apply = True


@dataclass(frozen=True)
class CurrentVersion:
    semverish: str
    build_id: str | None


def normalize_current_version(raw: str | None) -> CurrentVersion:
    """Normalize a HOMECAM_VERSION value to semver-ish core plus build id."""
    value = (raw or "").strip()
    match = _SEMVERISH_RE.fullmatch(value)
    if match is None:
        log.warning("blocking OTA apply: malformed HOMECAM_VERSION=%s", raw)
        raise CurrentVersionError("malformed HOMECAM_VERSION blocks OTA apply")

    semverish = (
        f"{match.group('core')}.{match.group('minor')}.{match.group('patch')}"
        f"{match.group('prerelease') or ''}"
    )
    build = match.group("build")
    return CurrentVersion(semverish=semverish, build_id=build[1:] if build else None)


def current_version_from_env(env: dict[str, str] | None = None) -> CurrentVersion:
    source = env if env is not None else os.environ
    return normalize_current_version(source.get("HOMECAM_VERSION", "0.1.0"))
