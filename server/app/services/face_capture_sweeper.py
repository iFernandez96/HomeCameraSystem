"""iter-356.62 slice 3 (privacy controls): TTL sweeper for face +
person captures.

Mirrors `recording_service.sweep_old_clips` (server/app/services/
recording_service.py). The detection worker writes JPEG + sidecar
pairs under `<face_captures_dir>/<name>/` and (Slice 1) under
`<person_captures_dir>/<name>/`. This sweeper deletes files older
than `detection_config.face_capture_retention_days` so household
biometric data doesn't accumulate forever.

Best-effort: an OSError on one file (permission flip, half-mounted
volume) doesn't abort the rest of the walk. Sidecar `<basename>.json`
is removed alongside the JPEG.
"""
from __future__ import annotations

import logging
import os
import time
from pathlib import Path

from ..config import settings

log = logging.getLogger(__name__)


def sweep_old_face_captures(retention_days: int | None = None) -> int:
    """Delete face/person captures older than ``retention_days``
    (defaults to the live `detection_config.face_capture_retention_days`).
    Returns the count of JPEGs deleted across BOTH roots
    (`face_captures_dir` + `person_captures_dir`).

    Best-effort: a single OSError doesn't abort the sweep. Sidecar
    `.json` removal is also best-effort and does NOT count toward
    the return value (the user-visible artefact is the JPEG).

    Skips entirely when retention_days <= 0 — same misconfiguration
    guard as `recording_service.sweep_old_clips`. The retention
    config field clamps to [1, 365] so this branch only fires if a
    caller passes an explicit override.
    """
    if retention_days is None:
        # Lazy import to avoid an import cycle (detection_config →
        # config → app modules → this module).
        try:
            from .detection_config import detection_config as _dc
            retention_days = _dc.get().face_capture_retention_days
        except Exception as e:
            # The user's live face-capture retention setting could not
            # be resolved — the sweep silently falls back to the 30-day
            # default, IGNORING their Settings choice. WARN with the
            # reason + fallback so the discrepancy is visible (mirrors
            # recording_service.sweep_old_clips).
            retention_days = 30
            log.warning(
                "face_capture_sweeper: could not resolve retention "
                "config (%s: %s); falling back to %d days — user's "
                "Settings choice is being ignored",
                type(e).__name__,
                e,
                retention_days,
            )
    if retention_days <= 0:
        log.warning(
            "face_capture_retention_days=%d skipped sweep; manual deletion required",
            retention_days,
        )
        return 0
    cutoff = time.time() - (retention_days * 86400)
    deleted = 0
    for root in (settings.face_captures_dir, settings.person_captures_dir):
        deleted += _sweep_root(root, cutoff)
    return deleted


def _sweep_root(root: Path, cutoff: float) -> int:
    """Walk `<root>/<name>/*.jpg` and unlink every file older than
    `cutoff`. Sidecar `.json` files are unlinked alongside the JPEG.
    Returns the count of JPEGs removed under this root."""
    if not root.is_dir():
        return 0
    deleted = 0
    try:
        children = list(root.iterdir())
    except OSError as e:
        log.warning("face_capture_sweeper: cannot list %s: %s", root, e)
        return 0
    for sub in children:
        try:
            if not sub.is_dir():
                continue
        except OSError:
            continue
        try:
            entries = list(sub.iterdir())
        except OSError as e:
            log.warning("face_capture_sweeper: cannot list %s: %s", sub, e)
            continue
        for entry in entries:
            try:
                if not entry.is_file():
                    continue
                if entry.suffix != ".jpg":
                    continue
                mtime = entry.stat().st_mtime
            except OSError:
                continue
            if mtime >= cutoff:
                continue
            sidecar = entry.with_suffix(".json")
            try:
                os.remove(str(entry))
                deleted += 1
            except OSError as e:
                log.warning(
                    "face_capture_sweeper: failed to remove %s: %s", entry, e
                )
                continue
            try:
                if sidecar.is_file():
                    os.remove(str(sidecar))
            except OSError:
                # Sidecar removal best-effort; orphans are harmless
                # (the list routes index by JPEG basename).
                pass
    return deleted
