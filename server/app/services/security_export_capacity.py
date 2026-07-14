"""Shared disk-capacity reservations for timeline and evidence exports."""
from __future__ import annotations

import math
import re
import shutil
import threading
from pathlib import Path
from typing import Any, Iterable

from ..config import settings

CAPACITY_LOCK = threading.RLock()
_EPHEMERAL_RESERVATIONS: dict[str, int] = {}
_MIN_OVERHEAD_BYTES = 1024 * 1024
_TIMELINE_TEMP_RE = re.compile(
    r"^\.timeline-([0-9a-f]{32})\.(?:part\.mp4|ffconcat)$"
)
_INCIDENT_TEMP_RE = re.compile(
    r"^\.incident-[0-9a-f]{32}-[0-9a-f]{32}-[A-Za-z0-9_-]+\.part\.zip$"
)
_INCIDENT_OUTPUT_RE = re.compile(
    r"^incident-[0-9a-f]{32}-[0-9a-f]{32}\.zip$"
)


class ExportCapacityError(RuntimeError):
    def __init__(self, status_code: int, detail: str) -> None:
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


def conservative_reservation(sizes: Iterable[int]) -> int:
    payload = sum(max(0, int(size)) for size in sizes)
    overhead = max(_MIN_OVERHEAD_BYTES, int(math.ceil(payload * 0.05)))
    return payload + overhead


def _export_dir() -> Path:
    path = settings.security_exports_dir
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    return path


def workspace_bytes() -> int:
    """Count retained/served files; hidden build temporaries use reservations."""
    total = 0
    try:
        children = list(_export_dir().iterdir())
    except OSError:
        raise ExportCapacityError(
            507, "Export storage is unavailable; check the storage mount."
        )
    for path in children:
        if not path.is_file():
            continue
        # Only exact application-owned build temporaries are represented by
        # reservations. Other hidden files still consume the workspace cap.
        if _TIMELINE_TEMP_RE.fullmatch(path.name) or _INCIDENT_TEMP_RE.fullmatch(
            path.name
        ):
            continue
        try:
            total += path.stat().st_size
        except OSError:
            continue
    return total


def cleanup_owned_temps(
    state: dict[str, Any],
    *,
    include_timeline: bool = True,
    include_incident: bool = True,
) -> int:
    """Remove only inactive application-owned crash temporaries.

    Caller must hold ``CAPACITY_LOCK``. Incident cleanup is used only at boot
    or while the incident-export serializer is held, since incident builds are
    represented by in-memory reservations rather than persisted job IDs.
    """
    active_ids = {
        str(job_id)
        for job_id, job in state.get("timeline_exports", {}).items()
        if isinstance(job, dict) and job.get("status") in {"pending", "running"}
    }
    removed = 0
    try:
        children = list(_export_dir().iterdir())
    except OSError:
        return 0
    for path in children:
        if not path.is_file():
            continue
        timeline_match = _TIMELINE_TEMP_RE.fullmatch(path.name)
        owned = (
            include_timeline
            and timeline_match is not None
            and timeline_match.group(1) not in active_ids
        ) or (
            include_incident and _INCIDENT_TEMP_RE.fullmatch(path.name) is not None
        )
        if not owned:
            continue
        try:
            path.unlink(missing_ok=True)
            removed += 1
        except OSError:
            continue
    return removed


def cleanup_incident_outputs_at_startup() -> int:
    """Remove exact one-response incident ZIPs left by a process crash.

    Call only during application startup, before requests can be serving one
    of these files. Runtime cleanup would race FileResponse readers.
    """
    removed = 0
    with CAPACITY_LOCK:
        try:
            children = list(_export_dir().iterdir())
        except OSError:
            return 0
        for path in children:
            if not path.is_file() or _INCIDENT_OUTPUT_RE.fullmatch(path.name) is None:
                continue
            try:
                path.unlink(missing_ok=True)
                removed += 1
            except OSError:
                continue
    return removed


def timeline_reserved_bytes(
    state: dict[str, Any], *, exclude_job_id: str | None = None
) -> int:
    total = 0
    for job_id, job in state.get("timeline_exports", {}).items():
        if job_id == exclude_job_id or not isinstance(job, dict):
            continue
        if job.get("status") in {"pending", "running"}:
            total += max(0, int(job.get("reservation_bytes", 0) or 0))
    return total


def ephemeral_reserved_bytes(*, exclude_key: str | None = None) -> int:
    return sum(
        size for key, size in _EPHEMERAL_RESERVATIONS.items()
        if key != exclude_key
    )


def _limits() -> tuple[int, int]:
    return (
        max(1, int(settings.security_export_max_total_bytes)),
        max(0, int(settings.security_export_min_free_bytes)),
    )


def ensure_reservation_fits(
    state: dict[str, Any],
    reservation_bytes: int,
) -> None:
    """Check a new reservation. Caller must hold CAPACITY_LOCK."""
    max_total, min_free = _limits()
    reserved = timeline_reserved_bytes(state) + ephemeral_reserved_bytes()
    retained = workspace_bytes()
    if retained + reserved + reservation_bytes > max_total:
        raise ExportCapacityError(
            507,
            "Export storage limit reached; wait for old exports to expire or shorten the range.",
        )
    try:
        free = shutil.disk_usage(_export_dir()).free
    except OSError:
        raise ExportCapacityError(
            507, "Export storage is unavailable; check the storage mount."
        )
    if free - reserved - reservation_bytes < min_free:
        raise ExportCapacityError(
            507,
            "Not enough free storage for this export; shorten the range or free disk space.",
        )


def ensure_finished_output_fits(
    state: dict[str, Any],
    output_bytes: int,
    *,
    exclude_job_id: str | None = None,
    exclude_ephemeral_key: str | None = None,
) -> None:
    """Recheck a completed hidden temp file before publishing it."""
    max_total, min_free = _limits()
    retained = workspace_bytes()
    reserved = timeline_reserved_bytes(
        state, exclude_job_id=exclude_job_id
    ) + ephemeral_reserved_bytes(exclude_key=exclude_ephemeral_key)
    if retained + reserved + output_bytes > max_total:
        raise ExportCapacityError(
            507,
            "Finished export would exceed the export storage limit; shorten the range.",
        )
    try:
        free = shutil.disk_usage(_export_dir()).free
    except OSError:
        raise ExportCapacityError(
            507, "Export storage is unavailable; check the storage mount."
        )
    # ``output_bytes`` already occupies disk as a hidden temp file, but other
    # outstanding jobs have not necessarily written their reserved bytes yet.
    # Preserve the floor after those jobs consume their reservations too.
    if free - reserved < min_free:
        raise ExportCapacityError(
            507,
            "Finished export would leave too little free storage; free disk space and retry.",
        )


def claim_ephemeral(key: str, reservation_bytes: int, state: dict[str, Any]) -> None:
    """Claim an evidence-export reservation. Caller must hold CAPACITY_LOCK."""
    ensure_reservation_fits(state, reservation_bytes)
    _EPHEMERAL_RESERVATIONS[key] = reservation_bytes


def release_ephemeral(key: str) -> None:
    with CAPACITY_LOCK:
        _EPHEMERAL_RESERVATIONS.pop(key, None)


def reset_for_tests() -> None:
    with CAPACITY_LOCK:
        _EPHEMERAL_RESERVATIONS.clear()
