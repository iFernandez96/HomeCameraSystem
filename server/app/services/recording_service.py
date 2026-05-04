"""Per-event MP4 clip storage (iter-201, Feature #1 slice 1).

iter-201 ships the **storage + retention surface only** — the
actual ffmpeg ring-buffer that produces the clips lives in slice 2
(host-side recorder, deferred until Jetson access). Clients that
fetch a clip via the iter-201 `GET /api/events/{id}/clip` route
will see 404 until the recorder lands.

File layout:
    settings.recordings_dir/{event_id}.mp4

Event IDs flow through `event_bus.make_detection_event`; they're
url-safe opaque strings (alphanumeric + dash + underscore) and the
route `clips.py` regex-validates them as a path-traversal defense.

Retention:
    Clips older than `settings.recordings_retention_days` are
    deleted by the sweeper, called periodically by the server's
    lifespan or on-demand from a future admin endpoint.

Public surface (iter-201, slice 1):
- `clip_path(event_id)`            — resolve to a Path; doesn't
                                     check existence.
- `clip_exists(event_id)`          — True if the file is present.
- `delete_clip(event_id)`          — best-effort unlink; no error
                                     if missing.
- `sweep_old_clips(retention_days)` — return count of deleted files.
"""
from __future__ import annotations

import logging
import os
import re
import time
from pathlib import Path

from ..config import settings


log = logging.getLogger(__name__)


# Same charset as the regex used by `routes/clips.py` for the path
# parameter — the route is the wire-side enforcement, this constant
# documents the same shape so any future caller that builds an
# event_id from outside the route layer can validate against it.
_VALID_EVENT_ID = re.compile(r"^[A-Za-z0-9_-]+$")


def _is_safe_event_id(event_id: str) -> bool:
    """True if the event_id is bare and url-safe. Used as a
    defense-in-depth check in `clip_path` — the route already
    regex-validates, but a future internal caller might miss it."""
    return bool(event_id) and _VALID_EVENT_ID.match(event_id) is not None


def clip_path(event_id: str) -> Path:
    """Compose the on-disk path for an event's clip. Does NOT
    check existence — caller decides whether to 404 or return.

    Raises ``ValueError`` on a malformed event_id (path-traversal
    defense; the route layer also enforces this via regex on the
    Path parameter)."""
    if not _is_safe_event_id(event_id):
        raise ValueError("invalid event_id: {!r}".format(event_id))
    return settings.recordings_dir / "{}.mp4".format(event_id)


def clip_exists(event_id: str) -> bool:
    """True if the per-event clip file is present on disk."""
    try:
        return clip_path(event_id).is_file()
    except ValueError:
        return False


def tracks_path(event_id: str) -> Path:
    """Compose the on-disk path for an event's bbox-track sidecar
    (iter-356.53). Same charset gate + recordings_dir as `clip_path`;
    sidecar lives next to the MP4 (`<id>.tracks.json`).

    Raises ``ValueError`` on a malformed event_id."""
    if not _is_safe_event_id(event_id):
        raise ValueError("invalid event_id: {!r}".format(event_id))
    return settings.recordings_dir / "{}.tracks.json".format(event_id)


def tracks_exists(event_id: str) -> bool:
    """True if the per-event bbox-track sidecar is present on disk.
    False on missing file OR malformed id (mirrors `clip_exists`)."""
    try:
        return tracks_path(event_id).is_file()
    except ValueError:
        return False


def delete_clip(event_id: str) -> bool:
    """Best-effort deletion. Returns True on successful unlink of the
    MP4 (regardless of sidecar status), False on missing file or
    invalid id. Never raises.

    iter-356.53: also unlink the `.tracks.json` sidecar if present.
    Sidecar removal is independent — a missing/un-deletable sidecar
    doesn't change the boolean returned, since the user-visible clip
    is the MP4."""
    try:
        path = clip_path(event_id)
    except ValueError:
        return False
    try:
        sidecar = tracks_path(event_id)
        if sidecar.is_file():
            sidecar.unlink()
    except (ValueError, FileNotFoundError, OSError):
        pass
    try:
        path.unlink()
        return True
    except (FileNotFoundError, OSError):
        return False


def sweep_old_clips(retention_days: int | None = None) -> int:
    """Delete clips older than ``retention_days`` (defaults to
    ``settings.recordings_retention_days``). Returns the count of
    files deleted. Best-effort — silently skips files we can't
    stat/unlink (permission flips, half-mounted volumes, etc.)
    rather than aborting mid-sweep.

    Called by:
    - Server lifespan startup (catch up after long downtime)
    - A future periodic task (slice 2 candidate)
    - On-demand from a future admin endpoint
    """
    if retention_days is None:
        # iter-257: prefer the preset-derived value from
        # detection_config over the env-pinned `settings`. The user
        # picks a tier (week / month / 5-year) from the Settings UI;
        # this function honours the live choice on every sweep.
        # Lazy import to dodge import-cycle (detection_config →
        # settings → app modules → recording_service).
        try:
            from .detection_config import (
                detection_config as _dc,
                preset_retention_days as _preset_retention_days,
            )
            retention_days = _preset_retention_days(_dc.get().clip_retention_preset)
        except Exception:
            retention_days = settings.recordings_retention_days
    if retention_days <= 0:
        # Retention 0 or negative would delete every clip; treat as
        # a misconfiguration and skip the sweep entirely. Operator
        # can manually clear the dir if they actually want that.
        log.warning(
            "recordings_retention_days=%d skipped sweep; manual deletion required",
            retention_days,
        )
        return 0
    rec_dir = settings.recordings_dir
    if not rec_dir.exists():
        return 0
    cutoff = time.time() - (retention_days * 86400)
    deleted = 0
    # iter-356.53: also sweep `.tracks.json` sidecars older than the
    # cutoff. Suffix-match the same way the .mp4 sweep does so a
    # mistakenly-named operator file (e.g. `notes.tracks.json`)
    # doesn't get deleted.
    try:
        for entry in rec_dir.iterdir():
            if not entry.is_file():
                continue
            is_clip = entry.suffix == ".mp4"
            is_tracks_sidecar = entry.name.endswith(".tracks.json")
            if not (is_clip or is_tracks_sidecar):
                # Don't touch non-mp4 / non-sidecar files — operator
                # might keep ad-hoc test clips or partial ffmpeg
                # work-files that share the dir.
                continue
            try:
                mtime = entry.stat().st_mtime
            except OSError:
                continue
            if mtime < cutoff:
                try:
                    entry.unlink()
                    if is_clip:
                        deleted += 1
                except OSError as e:
                    log.warning(
                        "sweep failed to delete %s: %s", entry.name, e
                    )
    except OSError as e:
        log.warning("sweep failed to list %s: %s", rec_dir, e)
    return deleted
