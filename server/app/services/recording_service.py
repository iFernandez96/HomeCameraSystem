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
import json
import os
import re
import shutil
import time
from pathlib import Path
from typing import Iterable

from ..config import settings
from ..log import RateLimitedLog


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
_CLIP_STATE_LEDGER = ".clip_state.json"
_CLIP_LIFECYCLE_STATES = {"recording", "finalizing", "failed"}
_STALE_ACTIVE_AFTER_S = 15 * 60
_clip_status_scan_gate = RateLimitedLog(60.0)


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
        path = clip_path(event_id)
        return path.is_file() and path.stat().st_size > 0
    except (ValueError, OSError):
        return False


def clip_state_ledger_path() -> Path:
    """Path to the worker-written clip-state ledger."""
    return settings.recordings_dir / _CLIP_STATE_LEDGER


def read_clip_state_ledger() -> dict:
    """Read the worker's clip-state ledger.

    Returns a normalized ``{"v": 1, "events": {...}}`` shape. Any missing,
    corrupt, or malformed file reads as an empty ledger; the API must never fail
    a clip fetch because observability state is unavailable.
    """
    path = clip_state_ledger_path()
    try:
        with path.open("r") as f:
            data = json.load(f)
    except (FileNotFoundError, OSError, json.JSONDecodeError):
        return {"v": 1, "events": {}}
    if not isinstance(data, dict):
        return {"v": 1, "events": {}}
    events = data.get("events")
    if not isinstance(events, dict):
        events = {}
    return {"v": 1, "events": events}


def clip_state(event_id: str) -> dict:
    """Best known state for an event clip.

    Disk availability wins over stale ledger state: if ``<id>.mp4`` exists, the
    route can serve it and the state is ``available`` even if the worker crashed
    before updating the ledger.
    """
    if not _is_safe_event_id(event_id):
        raise ValueError("invalid event_id: {!r}".format(event_id))
    if clip_exists(event_id):
        path = clip_path(event_id)
        size = None
        updated_ts = None
        try:
            stat = path.stat()
            size = stat.st_size
            updated_ts = stat.st_mtime
        except OSError:
            pass
        return {
            "event_id": event_id,
            "state": "available",
            "source": "disk",
            "bytes": size,
            "updated_ts": updated_ts,
        }
    rec = read_clip_state_ledger()["events"].get(event_id)
    if isinstance(rec, dict):
        out = _public_clip_state(event_id, rec)
        if out.get("state") == "available":
            # A historical ledger claim is not proof of playback after
            # retention, manual deletion, or a zero-byte placeholder. Only the
            # non-empty disk check above may return available.
            try:
                zero_byte = clip_path(event_id).is_file() and (
                    clip_path(event_id).stat().st_size == 0
                )
            except OSError:
                zero_byte = False
            if zero_byte:
                try:
                    clip_path(event_id).unlink()
                except FileNotFoundError:
                    pass
                except OSError as exc:
                    log.warning(
                        "could not remove empty failed clip for %s: %s",
                        event_id,
                        exc,
                    )
                out.update({
                    "state": "failed",
                    "failure_code": "empty_output",
                    "failure_stage": "publishing",
                    "failure_summary": "The saved video file is empty.",
                    "failure_detail": (
                        "A filename was created, but it contains no playable "
                        "video data."
                    ),
                    "retryable": False,
                })
            else:
                out["state"] = "unknown"
        out.setdefault("event_id", event_id)
        out.setdefault("source", "ledger")
        return out
    return {"event_id": event_id, "state": "unknown", "source": "missing"}


def _is_stale_active(rec: dict, now: float | None = None) -> bool:
    if rec.get("state") not in {"recording", "finalizing"}:
        return False
    try:
        raw_updated = rec.get("updated_ts")
        if raw_updated is None:
            # Older worker ledgers did not include a heartbeat timestamp. We
            # cannot truthfully infer their age; startup reconciliation handles
            # current-version records with timestamps.
            return False
        updated = float(raw_updated)
    except (TypeError, ValueError):
        return False
    current = time.time() if now is None else now
    return current - updated > _STALE_ACTIVE_AFTER_S


def _public_clip_state(event_id: str, rec: dict) -> dict:
    """Return only client-safe lifecycle and plain-language diagnostics."""
    allowed = {
        "state", "updated_ts", "start_ts", "end_ts", "bytes", "last_seen",
        "failure_code", "failure_stage", "failure_summary", "failure_detail",
        "retryable", "eta_point_ts", "eta_min_ts", "eta_max_ts",
        "eta_model_samples", "eta_historical_spread_s", "eta_model",
        "eta_backtest_median_error_s", "eta_backtest_p90_error_s",
        "processing_stage", "queue_ahead",
        "eta_live_progress", "validation_progress", "validation_speed",
    }
    out = {key: rec[key] for key in allowed if key in rec}
    out["event_id"] = event_id
    if _is_stale_active(rec):
        out.update({
            "state": "failed",
            "failure_code": "worker_restarted",
            "failure_stage": rec.get("state"),
            "failure_summary": "Video processing was interrupted.",
            "failure_detail": (
                "The camera worker stopped before it could publish this "
                "event's video. Waiting longer will not make it appear."
            ),
            "retryable": False,
        })
    elif out.get("state") == "failed" and not out.get("failure_summary"):
        out.update({
            "failure_code": rec.get("reason") or "legacy_capture_failure",
            "failure_stage": "processing",
            "failure_summary": "No playable video was saved.",
            "failure_detail": (
                "The older recorder reported a processing failure but did "
                "not save a more specific explanation."
            ),
            "retryable": False,
        })
    return out


def clip_statuses(event_ids: Iterable[str]) -> dict[str, str]:
    """Return truthful clip lifecycle states for a batch of events.

    The event list and search routes can return up to 1,000 rows. Reading the
    worker ledger separately for every row would turn one request into 1,000
    JSON reads, while making the client poll ``/clip/status`` per card would
    create the same N+1 problem over HTTP. This helper reads the ledger once
    and scans the recordings directory once.

    A final MP4 on disk is the only proof of ``available``. In particular, an
    old ledger record that says ``available`` is ignored after retention or
    manual cleanup removes the file. ``recording``, ``finalizing``, and
    ``failed`` remain authoritative worker lifecycle states; malformed or
    missing records degrade to ``unknown`` rather than making a claim the UI
    cannot substantiate.
    """
    safe_ids = {
        event_id
        for event_id in event_ids
        if isinstance(event_id, str) and _is_safe_event_id(event_id)
    }
    statuses = {event_id: "unknown" for event_id in safe_ids}
    if not safe_ids:
        return statuses

    ledger_events = read_clip_state_ledger()["events"]
    for event_id in safe_ids:
        rec = ledger_events.get(event_id)
        if not isinstance(rec, dict):
            continue
        state = rec.get("state")
        if state in _CLIP_LIFECYCLE_STATES:
            statuses[event_id] = (
                "failed" if _is_stale_active(rec) else state
            )

    try:
        with os.scandir(settings.recordings_dir) as entries:
            for entry in entries:
                name = entry.name
                if not name.endswith(".mp4"):
                    continue
                event_id = name[:-4]
                if event_id not in safe_ids:
                    continue
                try:
                    if entry.is_file() and entry.stat().st_size > 0:
                        statuses[event_id] = "available"
                except OSError as exc:
                    if _clip_status_scan_gate.should_log():
                        log.warning(
                            "clip status scan could not inspect %s: %s",
                            entry.path,
                            exc,
                        )
    except OSError as exc:
        if _clip_status_scan_gate.should_log():
            log.warning(
                "clip status scan failed for recordings dir %s: %s",
                settings.recordings_dir,
                exc,
            )

    return statuses


def clip_eta_ranges(event_ids: Iterable[str]) -> dict[str, dict]:
    """Return worker-authored ETA bounds for active, non-stale clips."""
    safe_ids = {
        event_id for event_id in event_ids
        if isinstance(event_id, str) and _is_safe_event_id(event_id)
    }
    ledger_events = read_clip_state_ledger()["events"]
    ranges: dict[str, dict] = {}
    for event_id in safe_ids:
        rec = ledger_events.get(event_id)
        if not isinstance(rec, dict) or _is_stale_active(rec):
            continue
        if rec.get("state") not in {"recording", "finalizing"}:
            continue
        try:
            point = float(rec["eta_point_ts"])
            low = float(rec["eta_min_ts"])
            high = float(rec["eta_max_ts"])
        except (KeyError, TypeError, ValueError):
            continue
        activity_present = None
        finalize_if_clear_ts = None
        if rec.get("state") == "recording":
            try:
                last_seen = float(rec["last_seen"])
                activity_present = time.time() - last_seen <= 2.0
                finalize_if_clear_ts = last_seen + float(
                    rec["absence_finalize_s"]
                )
            except (KeyError, TypeError, ValueError):
                pass
        if low > 0 and low <= point <= high:
            ranges[event_id] = {
                "point_ts": point,
                "min_ts": low,
                "max_ts": high,
                "model_samples": int(rec.get("eta_model_samples") or 0),
                "backtest_median_error_s": rec.get(
                    "eta_backtest_median_error_s"
                ),
                "live_progress": bool(rec.get("eta_live_progress")),
                "activity_present": activity_present,
                "finalize_if_clear_ts": finalize_if_clear_ts,
            }
    return ranges


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
    now = time.time()
    cutoff = now - (retention_days * 86400)
    try:
        from .events_db import retention_class_by_id
        retention_classes = retention_class_by_id(settings.events_db_path)
    except Exception:
        # Fail closed: if protection state cannot be read, do not risk deleting
        # footage the owner explicitly retained.
        log.exception("sweep: could not load protected event ids; skipping sweep")
        return 0
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
            event_id = (
                entry.name[:-12] if is_tracks_sidecar else entry.stem
            )
            retention_class = retention_classes.get(event_id, "ordinary")
            if retention_class in {"incident", "permanent"}:
                continue
            try:
                mtime = entry.stat().st_mtime
            except OSError:
                continue
            event_cutoff = cutoff
            if retention_class == "important":
                important_days = max(int(retention_days) * 3, 30)
                event_cutoff = now - important_days * 86400
            if mtime < event_cutoff:
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


def storage_forecast(now: float | None = None) -> dict:
    """Measure 24-hour and seven-day clip growth for runway estimates."""
    if now is None:
        now = time.time()
    rec_dir = settings.recordings_dir
    recent_bytes = 0
    seven_day_bytes = 0
    daily_bytes = [0] * 7
    protected_bytes = 0
    try:
        from .events_db import protected_event_ids
        protected_ids = protected_event_ids(settings.events_db_path)
    except Exception:
        log.exception("storage forecast: could not load protected event ids")
        protected_ids = set()
    try:
        clips = _list_clips_by_mtime(rec_dir) if rec_dir.exists() else []
        for mtime, path in clips:
            try:
                size = path.stat().st_size
            except OSError:
                continue
            if mtime >= now - 86400:
                recent_bytes += size
            age_s = max(0.0, now - mtime)
            if age_s < 7 * 86400:
                seven_day_bytes += size
                daily_bytes[min(6, int(age_s // 86400))] += size
            if Path(path.name).stem in protected_ids:
                protected_bytes += size
    except Exception:
        log.exception("storage forecast: clip scan failed")
    return {
        "recording_gb_per_day": recent_bytes / (1024 ** 3),
        "recording_gb_per_day_7d": seven_day_bytes / (7 * (1024 ** 3)),
        "recording_peak_gb_per_day_7d": max(daily_bytes) / (1024 ** 3),
        "protected_recording_gb": protected_bytes / (1024 ** 3),
    }


def retention_preview(now: float | None = None, limit: int = 12) -> dict:
    """Explain retention classes and the next age-based deletions."""
    now = time.time() if now is None else now
    try:
        from .detection_config import (
            detection_config as _dc,
            preset_retention_days as _preset_retention_days,
        )
        ordinary_days = _preset_retention_days(_dc.get().clip_retention_preset)
    except Exception:
        ordinary_days = settings.recordings_retention_days
    from .events_db import retention_class_by_id, retention_summary
    classes = retention_class_by_id(settings.events_db_path)
    candidates = []
    class_bytes = {name: 0 for name in ("ordinary", "important", "incident", "permanent")}
    for mtime, path in _list_clips_by_mtime(settings.recordings_dir):
        event_id = path.stem
        retention_class = classes.get(event_id, "ordinary")
        try:
            size = path.stat().st_size
        except OSError:
            size = 0
        class_bytes[retention_class if retention_class in class_bytes else "ordinary"] += size
        if retention_class in {"incident", "permanent"}:
            continue
        days = max(ordinary_days * 3, 30) if retention_class == "important" else ordinary_days
        candidates.append({
            "event_id": event_id,
            "retention_class": retention_class,
            "bytes": size,
            "delete_after_ts": mtime + days * 86400,
            "overdue": now >= mtime + days * 86400,
        })
    candidates.sort(key=lambda row: (row["delete_after_ts"], row["event_id"]))
    return {
        **retention_summary(settings.events_db_path),
        "class_bytes": class_bytes,
        "ordinary_days": ordinary_days,
        "important_days": max(ordinary_days * 3, 30),
        "next_deletions": candidates[:limit],
    }


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
    try:
        from .events_db import retention_class_by_id
        retention_classes = retention_class_by_id(settings.events_db_path)
    except Exception:
        log.exception("evict: could not load protected event ids; skipping eviction")
        return result
    # Preserve the oldest-first guarantee inside each tier, but spend ordinary
    # footage before footage the owner marked important.
    clips.sort(key=lambda pair: (
        retention_classes.get(Path(pair[1].name).stem, "ordinary") == "important",
        pair[0],
    ))
    for _mtime, path in clips:
        if _free() >= min_free_bytes:
            break
        retention_class = retention_classes.get(Path(path.name).stem, "ordinary")
        if retention_class in {"incident", "permanent"}:
            continue
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


def sweep_and_evict(
    retention_days: int | None = None,
    *,
    disk_usage=None,
    list_clips=None,
) -> dict:
    """Combined retention pass: run the time-based ``sweep_old_clips`` FIRST
    (cheap, removes genuinely-old clips), THEN the age-independent byte-budget
    ``evict_to_free_space`` to reclaim space if the card is still under the
    free-space floor.

    This is the single entrypoint the periodic scheduler / lifespan should call
    so both tiers always run together in the correct order. Returns
    ``{"swept": int, "evicted": int, "freed_bytes": int}``.
    """
    swept = sweep_old_clips(retention_days)
    ev = evict_to_free_space(disk_usage=disk_usage, list_clips=list_clips)
    return {
        "swept": swept,
        "evicted": ev["deleted"],
        "freed_bytes": ev["freed_bytes"],
    }
