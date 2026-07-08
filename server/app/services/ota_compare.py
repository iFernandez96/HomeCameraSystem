"""OTA target-version comparison helpers."""
from __future__ import annotations

import logging
from dataclasses import dataclass

from app.services.ota_version import CurrentVersionError, normalize_current_version

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class VersionComparisonResult:
    status: str
    current_version: str | None = None
    available_version: str | None = None
    relation: str | None = None
    reason: str | None = None

    @property
    def can_apply(self) -> bool:
        return self.status == "newer" and self.relation == "newer"


def _split_prerelease(version: str) -> tuple[tuple[int, int, int], str | None]:
    core, separator, prerelease = version.partition("-")
    major, minor, patch = core.split(".")
    return (int(major), int(minor), int(patch)), prerelease if separator else None


def _compare_prerelease(left: str | None, right: str | None) -> int:
    if left == right:
        return 0
    if left is None:
        return 1
    if right is None:
        return -1

    left_parts = left.split(".")
    right_parts = right.split(".")
    for index, left_part in enumerate(left_parts):
        if index >= len(right_parts):
            return 1
        right_part = right_parts[index]
        left_num = left_part.isdigit()
        right_num = right_part.isdigit()
        if left_num and right_num:
            left_value = int(left_part)
            right_value = int(right_part)
            if left_value != right_value:
                return 1 if left_value > right_value else -1
            continue
        if left_num != right_num:
            return -1 if left_num else 1
        if left_part != right_part:
            return 1 if left_part > right_part else -1
    if len(left_parts) == len(right_parts):
        return 0
    return -1


def _compare_semverish(left: str, right: str) -> int:
    left_core, left_prerelease = _split_prerelease(left)
    right_core, right_prerelease = _split_prerelease(right)
    if left_core != right_core:
        return 1 if left_core > right_core else -1
    return _compare_prerelease(left_prerelease, right_prerelease)


def compare_available_version(
    *, current_version: str | None, available_version: str | None
) -> VersionComparisonResult:
    """Classify whether an available OTA version is newer than current.

    Equal and older versions return ``rejected`` so callers can stop before any
    deploy tree or artifact side effects.
    """
    try:
        current = normalize_current_version(current_version).semverish
        available = normalize_current_version(available_version).semverish
    except CurrentVersionError:
        log.warning(
            "rejecting OTA version comparison: malformed current=%s available=%s",
            current_version,
            available_version,
        )
        return VersionComparisonResult(status="rejected", reason="malformed_version")

    comparison = _compare_semverish(available, current)
    if comparison <= 0:
        relation = "equal" if comparison == 0 else "older"
        log.info(
            "rejecting OTA apply: available version is %s current=%s available=%s",
            relation,
            current,
            available,
        )
        return VersionComparisonResult(
            status="rejected",
            current_version=current,
            available_version=available,
            relation=relation,
            reason=f"available_{relation}",
        )

    return VersionComparisonResult(
        status="newer",
        current_version=current,
        available_version=available,
        relation="newer",
    )
