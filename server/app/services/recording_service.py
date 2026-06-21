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
import shutil
import time
from pathlib import Path

from ..config import settings


log = logging.getLogger(__name__)


# --- byte-budget / free-space safety net (plan S4.5 / blocker B2) ---
#
# Time-based retention (`sweep_old_clips`) is the PRIMARY reclaimer, but it is
# AGE-only: on a 2 GB Jetson SD card an "always present" detection that fills a
# fresh clip every `max_visit_s` (~37-56 MB each) can exhaust the card in hours
# while every clip is still days inside the retention window — so time-sweep
# reclaims NOTHING for weeks. `evict_to_free_space` is the age-independent
# backstop: it deletes the OLDEST clips, regardless of age, until free space is
# back above a floor.
#
# SERVER_MIN_FREE_BYTES — the server's eviction floor. ~300 MB on a 2 GB card:
# big enough to absorb one in-flight `<event_id>.mp4.tmp` finalize (a capped
# visit is ~37-56 MB; faststart's second pass doubles transient usage) plus
# headroom for events.db WAL growth and the timelapse reel build, while still
# leaving the bulk of the card for clips. It is a FLOOR the evictor restores TO,
# not a reserve we leave permanently free.
#
# This MUST stay strictly BELOW the worker's `WORKER_MIN_FREE_BYTES`
# (detection/visit_runtime.py) so the worker stops CREATING new footage before
# the server is ever forced to start DELETING it — otherwise the worker would
# live-lock opening visits that the server immediately evicts. The ordering
# invariant is pinned by test_disk_floor_ordering.py.
SERVER_MIN_FREE_BYTES = 300 * 1024 * 1024  # ~300 MB


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
    except (ValueError, FileNotFoundError, OSError) as e:
        # Sidecar removal is independent of the boolean returned, but
        # an un-deletable sidecar still leaves orphaned bbox-track
        # data on disk — DEBUG breadcrumb (benign: list routes index
        # by the MP4 basename).
        log.debug(
            "delete_clip: could not remove tracks sidecar for %s: %s",
            event_id,
            e,
        )
    try:
        path.unlink()
        return True
    except FileNotFoundError:
        # Already gone — the common "event deleted but clip was never
        # recorded / already swept" case. DEBUG, not WARN.
        log.debug("delete_clip: clip already absent for %s", event_id)
        return False
    except OSError as e:
        # A real failure (permission flip, RO mount, busy file): the
        # clip LINGERS on disk despite the event being deleted, which
        # is a privacy + disk-leak surprise. WARN so it surfaces.
        log.warning(
            "delete_clip: failed to unlink clip for %s (clip lingers "
            "on disk): %s",
            event_id,
            e,
        )
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
        except Exception as e:
            # The user's Settings retention tier (week / month / 5-year)
            # could not be resolved — every sweep now silently uses the
            # env default instead, so their choice is IGNORED. WARN with
            # the reason + the fallback value so the discrepancy between
            # "what the UI shows" and "what's actually swept" is visible.
            retention_days = settings.recordings_retention_days
            log.warning(
                "sweep: could not resolve retention preset (%s: %s); "
                "falling back to env default %d days — user's Settings "
                "retention choice is being ignored",
                type(e).__name__,
                e,
                retention_days,
            )
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
        # Note how many we'd already deleted before the listdir died
        # mid-walk so the operator knows the sweep was partial.
        log.warning(
            "sweep failed to list %s after deleting %d clip(s): %s",
            rec_dir,
            deleted,
            e,
        )
    return deleted


def _list_clips_by_mtime(rec_dir: Path) -> list:
    """List `<rec_dir>/*.mp4` clips as ``(mtime, Path)`` tuples sorted OLDEST
    first. Skips entries we can't stat (mid-delete races, permission flips).

    Tracks sidecars (`.tracks.json`) are intentionally NOT counted as evictable
    units — they're tiny and ride along with their clip; deleting a clip leaves
    its sidecar to time-sweep. The evictor reclaims real space (the H.264
    bytes), so it operates on `.mp4` only."""
    out = []
    try:
        for entry in rec_dir.iterdir():
            if not entry.is_file() or entry.suffix != ".mp4":
                continue
            try:
                mtime = entry.stat().st_mtime
            except OSError:
                continue
            out.append((mtime, entry))
    except OSError as e:
        log.warning("evict: failed to list %s: %s", rec_dir, e)
    out.sort(key=lambda pair: pair[0])
    return out


def evict_to_free_space(
    min_free_bytes: int | None = None,
    *,
    disk_usage=None,
    list_clips=None,
) -> dict:
    """AGE-INDEPENDENT free-space evictor (plan S4.5 / blocker B2).

    While free space at ``settings.recordings_dir`` is below
    ``min_free_bytes`` (default ``SERVER_MIN_FREE_BYTES``), delete the OLDEST
    clip (by mtime) until free space is at/above the floor — or no clips remain.
    Unlike ``sweep_old_clips`` this ignores clip AGE entirely: it is the
    backstop for the "always present" adversary that fills the card faster than
    the retention window expires.

    ``disk_usage`` and ``list_clips`` are injectable for offline tests
    (default: ``shutil.disk_usage`` and ``_list_clips_by_mtime``). Returns
    ``{"deleted": int, "freed_bytes": int}``. Best-effort; never raises.
    """
    if min_free_bytes is None:
        min_free_bytes = SERVER_MIN_FREE_BYTES
    if disk_usage is None:
        disk_usage = shutil.disk_usage
    if list_clips is None:
        list_clips = _list_clips_by_mtime

    rec_dir = settings.recordings_dir
    result = {"deleted": 0, "freed_bytes": 0}
    if not rec_dir.exists():
        return result

    def _free() -> int:
        try:
            return int(disk_usage(str(rec_dir)).free)
        except OSError as e:
            # Can't read free space → don't blind-delete; treat as "above
            # floor" so a transient stat failure never nukes the card.
            log.warning(
                "evict: disk_usage(%s) failed (%s) — skipping eviction",
                rec_dir,
                e,
            )
            return min_free_bytes

    if _free() >= min_free_bytes:
        return result  # already above floor → no-op

    # Snapshot oldest-first; delete until free >= floor or we run out.
    clips = list_clips(rec_dir)
    for _mtime, path in clips:
        if _free() >= min_free_bytes:
            break
        try:
            size = path.stat().st_size
        except OSError:
            size = 0
        try:
            path.unlink()
        except FileNotFoundError:
            continue
        except OSError as e:
            log.warning("evict: failed to unlink %s: %s", path.name, e)
            continue
        result["deleted"] += 1
        result["freed_bytes"] += size
        # Eviction is space-pressure, not a routine age sweep — log each one
        # by name so a card filling up is visible in journald.
        log.warning(
            "evict: deleted oldest clip %s (%d bytes) to free disk space "
            "below floor (%d bytes)",
            path.name,
            size,
            min_free_bytes,
        )

    if _free() < min_free_bytes and not clips:
        # Nothing left to delete but still under the floor — the card is full
        # of non-clip data (db, timelapse reels, face captures). Surface it.
        log.error(
            "evict: free space still below floor (%d bytes) but no clips left "
            "to evict in %s — disk pressure is from non-clip data",
            min_free_bytes,
            rec_dir,
        )
    elif result["deleted"]:
        log.info(
            "evict: reclaimed %d clip(s), %d bytes",
            result["deleted"],
            result["freed_bytes"],
        )
    return result


def sweep_and_evict(retention_days: int | None = None) -> dict:
    """Combined retention pass: run the time-based ``sweep_old_clips`` FIRST
    (cheap, removes genuinely-old clips), THEN the age-independent byte-budget
    ``evict_to_free_space`` to reclaim space if the card is still under the
    free-space floor.

    This is the single entrypoint the periodic scheduler / lifespan should call
    so both tiers always run together in the correct order. Returns
    ``{"swept": int, "evicted": int, "freed_bytes": int}``.
    """
    swept = sweep_old_clips(retention_days)
    ev = evict_to_free_space()
    return {
        "swept": swept,
        "evicted": ev["deleted"],
        "freed_bytes": ev["freed_bytes"],
    }
