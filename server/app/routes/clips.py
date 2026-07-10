"""Per-event clip fetch route (iter-201, Feature #1 slice 1).

`GET /api/events/{event_id}/clip` returns the per-event MP4 file
written by the host-side recorder (slice 2, deferred). Until that
recorder lands, every request 404s — but the route + auth gate are
in place so the client can light up its `<video>` modal (slice 3)
the moment a clip exists.

Auth: gated via the iter-184 router-level `Depends(get_current_user)`
on `app.include_router(...)`. NOT role-gated — family/viewer users
should be able to watch clips of events they care about. iter-?
could split per-camera ACLs later (Feature #4 routing surface), but
iter-201 keeps the gate simple: any authenticated user can fetch.

Path-traversal defense: the path parameter `event_id` is regex-
validated on the route signature (FastAPI / Pydantic enforces).
The service-layer `clip_path` ALSO validates, belt-and-braces.

Range requests / video seeking: FastAPI's `FileResponse` doesn't
emit `Accept-Ranges` by default; HTML5 `<video>` falls back to
sequential download. For typical 5-10 s clips at our bitrate (~50
KB/s) the load is fast even without Range support. If the operator
later ships longer clips or many concurrent viewers, swap to a
range-aware response then.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import tempfile
import zipfile
from typing import List

from fastapi import APIRouter, HTTPException, Path
from fastapi.responses import FileResponse
from starlette.background import BackgroundTask
from pydantic import BaseModel, ConfigDict, Field

from ..config import settings
from ..services import events_db, recording_service


router = APIRouter()
log = logging.getLogger(__name__)

# iter-330 (missing-feature #3, Event Export ZIP): regex + length
# bounds for export request body. `_VALID_EVENT_ID` mirrors the
# `recording_service._VALID_EVENT_ID` charset so the body validation
# matches the path-traversal defense at every layer. 50-item cap
# protects the asyncio thread pool from a "select all 6 months of
# events and download" misuse — the iter-? clip-retention sweep
# bounds total clips on disk anyway, but the cap keeps the per-
# request work bounded.
_EXPORT_ID_RE = re.compile(r"^[A-Za-z0-9_-]+$")
_EXPORT_MAX_IDS = 50

# iter-337 (systems-engineering-auditor C1): cap CONCURRENT export
# ZIP builds. The asyncio thread pool on the Nano 2GB is small
# (default 8 workers); simultaneous /api/events/export requests
# would saturate it and BLOCK every other to_thread caller —
# heartbeat DB writes (`_internal.py`), events search (`events.py`),
# people list, count_by_day. The container stays healthy (no OOM,
# no crash) but every API endpoint's latency spikes to seconds with
# no observable signal — `restart` is the only operator lever.
#
# logging-plan (docs/logging_plan.md §2 "Export ZIP"): lowered 2→1.
# Root cause of the production "stitch all captures fails" bug was a
# 512MB-container cgroup OOM-kill — two concurrent builds each held
# the whole ZIP in RAM (clips ~10.5MB H.264, 50 clips ≈ 400MB), so
# Semaphore(2) permitted >800MB vs the 512MB cap → silent OOMKill
# (OOMKilled=false, no log line). The build now streams to a temp
# file on disk (bounded RAM), but we still cap concurrent builds at
# 1 so two large exports can't race for the thread pool / disk I/O.
# Held during the `_build_export_zip` to_thread call only — the
# events_db lookup at the start of the route does NOT take it.
_EXPORT_SEMAPHORE = asyncio.Semaphore(1)


@router.get("/events/{event_id}/clip")
def get_event_clip(
    # iter-201: regex on the path param is the first wire-side
    # defense against path traversal — the service-layer
    # `clip_path` also validates. Same charset as
    # `recording_service._VALID_EVENT_ID`.
    event_id: str = Path(..., pattern=r"^[A-Za-z0-9_-]+$", max_length=128),
) -> FileResponse:
    if not recording_service.clip_exists(event_id):
        state = recording_service.clip_state(event_id)
        # logging-plan §2: clip 404. INFO (not WARN) — this is a
        # routine outcome (event older than the retention window, or
        # the recorder hadn't spun up when the event fired). The line
        # lets an operator distinguish "recorder never produced a
        # clip" from a transient FS error in recording_service.
        log.info(
            "clip fetch 404: no clip on disk for event_id=%s clip_state=%s",
            event_id,
            state.get("state"),
        )
        raise HTTPException(
            status_code=404,
            detail="clip not available for this event",
        )
    path = recording_service.clip_path(event_id)
    # Pin media_type so HTML5 `<video>` picks the right codec path
    # without sniffing. The host-side recorder (slice 2) writes
    # H.264 in MP4 — `video/mp4` is canonical.
    return FileResponse(
        path,
        media_type="video/mp4",
        filename="{}.mp4".format(event_id),
    )


@router.get("/events/{event_id}/clip/status")
def get_event_clip_status(
    event_id: str = Path(..., pattern=r"^[A-Za-z0-9_-]+$", max_length=128),
) -> dict:
    """Return the best-known clip lifecycle state for one event.

    This endpoint is intentionally separate from the MP4 route so the client can
    ask "why is the video not available?" without interpreting a 404.
    """
    return recording_service.clip_state(event_id)


@router.get("/events/{event_id}/tracks")
def get_event_tracks(
    # iter-356.53: per-event bbox-track sidecar. Same auth gating
    # as the clip route (route-include adds `Depends(require_role)`
    # in main.py); same path-param regex; same 404 semantics.
    # Sidecar is a JSON file written by the worker (`tracks.py`)
    # at clip-window expiry — present when iter-356.53+ produced
    # the clip, absent for legacy clips (client falls back to the
    # static `event.boxes` overlay).
    event_id: str = Path(..., pattern=r"^[A-Za-z0-9_-]+$", max_length=128),
) -> FileResponse:
    if not recording_service.tracks_exists(event_id):
        # logging-plan §2: tracks sidecar 404. DEBUG only — legacy
        # clips (pre-iter-356.53) have no sidecar and the client
        # gracefully falls back to the static `event.boxes` overlay,
        # so this is an expected, high-frequency miss, not a failure.
        log.debug(
            "tracks sidecar 404 (legacy clip / no sidecar) event_id=%s",
            event_id,
        )
        raise HTTPException(
            status_code=404,
            detail="bbox tracks not available for this event",
        )
    path = recording_service.tracks_path(event_id)
    return FileResponse(
        path,
        media_type="application/json",
        filename="{}.tracks.json".format(event_id),
    )


class _ExportBody(BaseModel):
    """iter-330 request body schema for POST /api/events/export.

    `event_ids` is bounded at 1..50 to prevent abuse (a 6-month
    Select-all would exhaust the thread pool). Each id matches the
    `_VALID_EVENT_ID` charset enforced by `recording_service` — same
    regex as the path-param validation on `GET /api/events/{id}/clip`.

    iter-356.x (security audit B1): forbid extras to match every other
    request-body schema in the codebase — silent acceptance of unknown
    keys would be a future foot-gun once a second field lands here.
    """
    model_config = ConfigDict(extra="forbid")
    event_ids: List[str] = Field(..., min_length=1, max_length=_EXPORT_MAX_IDS)


def _build_export_zip(events: list[dict]) -> str:
    """logging-plan (docs/logging_plan.md §2 "Export ZIP"): build the
    ZIP on DISK and return the temp-file path. The caller streams it
    back via `FileResponse` and unlinks it with a `BackgroundTask`.

    Why disk, not RAM (this is the "stitch all captures fails" fix):
    clips average ~10.5 MB (H.264 bitstream, incompressible by DEFLATE),
    so a 50-clip export is ~400 MB. The pre-fix path built the whole
    ZIP in one `io.BytesIO` and the route wrapped THAT in a SECOND
    `io.BytesIO` for `StreamingResponse` — two full copies (~800 MB) —
    while `Semaphore(2)` permitted two concurrent builds. On the
    512 MB-cgroup container that silently OOM-killed the export worker
    (uvicorn survived, `OOMKilled=false`, no log line). Writing to a
    `NamedTemporaryFile` on the data volume (8.6 GB free, same volume
    as the clips themselves) keeps memory bounded regardless of clip
    count, and dropping the second `io.BytesIO` removes the redundant
    copy.

    The manifest.json captures the events_db row data so the operator
    has a sidecar record of label / score / person_name / timestamps
    even after retention sweeps the source DB rows. JSON matches the
    `/api/events` wire shape.

    Path-traversal: `clip_path()` and snapshots resolution both
    re-validate the id / filename against the same regex used at
    insert time. A malicious client cannot inject `../etc/passwd`
    via event_ids — the `_ExportBody.event_ids` Pydantic regex
    rejects it, AND the recording_service helper rejects it, AND
    the snapshot path resolution rejects it. Three layers.

    Loud-logging contract (logging-plan §2): build start (event
    count), each `zf.write` OSError (clip swept mid-export — WARN,
    skipped), thumb path-escape ValueError (security WARN) vs
    missing-on-disk (DEBUG, benign), and 0-clips/0-thumbs landed are
    surfaced. The route wraps this call in try/except so an OOM/IO
    failure is never silent again.
    """
    # logging-plan §2: build start, event count.
    log.info("export ZIP build start: %d events", len(events))

    # Temp file on the data volume (same as recordings_dir, 8.6 GB
    # free) — NOT /tmp (the container's /tmp may be small / tmpfs =
    # RAM, which would re-introduce the OOM). delete=False so the file
    # survives the `with` block for FileResponse to stream; the route's
    # BackgroundTask unlinks it after the response is sent.
    export_dir = settings.recordings_dir
    try:
        export_dir.mkdir(parents=True, exist_ok=True)
    except OSError:
        log.exception(
            "export ZIP build failed: cannot create export dir %s "
            "(volume unmounted / full / read-only)",
            export_dir,
        )
        raise

    tmp = tempfile.NamedTemporaryFile(
        prefix="homecam_export_", suffix=".zip", delete=False,
        dir=str(export_dir),
    )
    tmp_path = tmp.name
    tmp.close()

    manifest_entries: list[dict] = []
    clips_written = 0
    thumbs_written = 0
    try:
        with zipfile.ZipFile(
            tmp_path, mode="w", compression=zipfile.ZIP_DEFLATED,
        ) as zf:
            for ev in events:
                event_id = ev["id"]
                entry = dict(ev)  # shallow copy for the manifest
                entry["clip_included"] = False
                entry["thumb_included"] = False

                # Clip — only included if recording_service knows about
                # it AND the file is on disk. Missing clips are common
                # (events older than the retention window, or the
                # recorder hadn't spun up yet). Manifest records the
                # absence.
                if recording_service.clip_exists(event_id):
                    clip_path = recording_service.clip_path(event_id)
                    try:
                        zf.write(clip_path, "{}.mp4".format(event_id))
                        entry["clip_included"] = True
                        clips_written += 1
                    except OSError as exc:
                        # Race: file was swept between exists() and
                        # write(). Manifest still records absence; don't
                        # crash export. logging-plan §2: WARN + skip.
                        log.warning(
                            "export ZIP: clip swept mid-export, skipping "
                            "event_id=%s path=%s: %s",
                            event_id, clip_path, exc,
                        )

                # Thumb — resolve via the same path-traversal-safe
                # pattern as the SPA snapshots endpoint. event.thumb_url
                # is "/snapshots/thumb_1700000000.jpg" or
                # "/api/snapshots/...".
                thumb_url = ev.get("thumb_url")
                if thumb_url:
                    # Strip URL prefixes to get the bare filename. Any
                    # path component is rejected by the strict filename
                    # regex below.
                    fname = thumb_url.rsplit("/", 1)[-1]
                    if re.match(r"^thumb_[0-9]+\.jpg$", fname):
                        target = settings.snapshots_dir / fname
                        try:
                            resolved = target.resolve()
                            resolved.relative_to(
                                settings.snapshots_dir.resolve(),
                            )
                            if resolved.is_file():
                                zf.write(resolved, "{}.jpg".format(event_id))
                                entry["thumb_included"] = True
                                thumbs_written += 1
                            else:
                                # logging-plan §2: missing-on-disk is
                                # benign (retention swept the thumb) →
                                # DEBUG, not WARN.
                                log.debug(
                                    "export ZIP: thumb missing on disk for "
                                    "event_id=%s fname=%s",
                                    event_id, fname,
                                )
                        except ValueError:
                            # logging-plan §2: path escape is a SECURITY
                            # signal (resolved outside snapshots_dir) →
                            # WARN, distinct from missing-on-disk.
                            log.warning(
                                "export ZIP: thumb path escape rejected for "
                                "event_id=%s fname=%s (resolved outside "
                                "snapshots_dir)",
                                event_id, fname,
                            )
                        except OSError as exc:
                            log.warning(
                                "export ZIP: thumb fs error for event_id=%s "
                                "fname=%s: %s",
                                event_id, fname, exc,
                            )

                manifest_entries.append(entry)

            # Always emit a manifest, even if zero clips / thumbs
            # landed — the operator at least gets the metadata of what
            # they selected.
            zf.writestr(
                "manifest.json",
                json.dumps(
                    {
                        "v": 1,
                        "exported_count": len(manifest_entries),
                        "events": manifest_entries,
                    },
                    indent=2,
                ),
            )
    except Exception:
        # Any failure building the ZIP (OSError on disk-full, etc.):
        # clean up the partial temp file so it doesn't leak, then
        # re-raise to the route wrapper (which logs with event count +
        # bytes). logging-plan §2: never silent.
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise

    try:
        size = os.path.getsize(tmp_path)
    except OSError:
        size = -1
    log.info(
        "export ZIP build done: %d events, %d clips, %d thumbs, %d bytes",
        len(events), clips_written, thumbs_written, size,
    )
    return tmp_path


@router.post("/events/export")
async def export_events(body: _ExportBody) -> FileResponse:
    """iter-330 (missing-feature #3): bundle one or more event clips +
    thumbnails + a manifest.json into a ZIP for offline / sharing
    use. The owner / family / viewer can all export — the auth gate
    is the same as the rest of /api/events.

    Selection state lives in the client (EventList multi-select);
    the server takes a list of event IDs and returns a ZIP.
    Missing clips/thumbs (already pruned by retention sweep) appear
    in the manifest with `clip_included: false` / `thumb_included: false`
    so the operator can see what was selected vs delivered.

    Response shape (logging-plan §2 — the "stitch all captures fails"
    fix): the ZIP is built to a temp file on disk and returned via
    `FileResponse` with a `BackgroundTask` that unlinks it after the
    response is sent. This bounds memory regardless of clip count
    (the old in-RAM `StreamingResponse(io.BytesIO(...))` double-copy
    OOM-killed the 512 MB container with no log line). The downloaded
    ZIP contract is unchanged: same `homecam_events.zip` filename,
    same members (`<id>.mp4`, `<id>.jpg`, `manifest.json`).

    Sharp edges respected:
    - 1 MB request body cap (iter-75): 50 short ids easily fit.
    - Path traversal: 3-layer defense (Pydantic regex, recording_service
      regex, Path.resolve+relative_to on the snapshots dir).
    - Thread pool: `asyncio.to_thread` wraps the synchronous
      zipfile build so the asyncio loop isn't blocked.
    - Concurrency: `_EXPORT_SEMAPHORE` (iter-337, lowered 2→1) caps
      concurrent ZIP builds so the asyncio thread pool isn't saturated
      by simultaneous exports blocking heartbeat / events search.
    """
    # Lookup events_db rows for the requested IDs. Outside the
    # Semaphore so unknown-id 404s + invalid-id 400s respond fast
    # without queuing behind concurrent zip builds. logging-plan §2:
    # wrap the DB read so a get_by_ids exception is never silent.
    try:
        events = await asyncio.to_thread(
            events_db.get_by_ids, settings.events_db_path, body.event_ids,
        )
    except Exception:
        log.exception(
            "export: events_db.get_by_ids failed for %d requested ids "
            "(db=%s)",
            len(body.event_ids), settings.events_db_path,
        )
        raise HTTPException(
            status_code=500,
            detail="failed to look up events for export",
        )
    if not events:
        # logging-plan §2: 0 events resolved from N requested ids. INFO
        # — usually a stale client selection (events swept since the
        # list loaded), not an error.
        log.info(
            "export: 0 events resolved from %d requested ids",
            len(body.event_ids),
        )
        raise HTTPException(
            status_code=404,
            detail="no events found for the requested IDs",
        )

    # Belt-and-braces: re-validate every id against the export regex
    # before passing to the ZIP builder. Pydantic's max_length already
    # bounded the list, but the per-id regex is enforced HERE because
    # the Pydantic Field doesn't run a per-item pattern check.
    for ev in events:
        if not _EXPORT_ID_RE.match(ev["id"]):
            # logging-plan §2: a STORED id failing charset re-validation
            # is a data-integrity alarm — the id came back from the DB,
            # so either the insert path or the DB itself admitted a
            # value the charset regex forbids. ERROR, with the offending
            # id repr so the operator can find the bad row.
            log.error(
                "export: stored event id failed charset re-validation "
                "(DATA INTEGRITY): id=%r — refusing to build ZIP",
                ev["id"],
            )
            raise HTTPException(
                status_code=400,
                detail="invalid event id in selection",
            )

    # iter-337: gate ONLY the expensive ZIP build behind the semaphore.
    # logging-plan §2: note when the build queues (semaphore busy) so a
    # stuck/serialized export is visible.
    if _EXPORT_SEMAPHORE.locked():
        log.info(
            "export: ZIP build queued (semaphore busy) for %d events",
            len(events),
        )
    async with _EXPORT_SEMAPHORE:
        # logging-plan §2: wrap the to_thread build so an OOM / IO
        # failure is NEVER silent again. Log event count + approx bytes
        # (sum of on-disk clip sizes) so the journal records the scale
        # of the export that failed.
        try:
            zip_path = await asyncio.to_thread(_build_export_zip, events)
        except Exception:
            approx_bytes = 0
            for ev in events:
                eid = ev.get("id")
                try:
                    if eid and recording_service.clip_exists(eid):
                        approx_bytes += recording_service.clip_path(
                            eid,
                        ).stat().st_size
                except OSError:
                    pass
            log.exception(
                "export: ZIP build FAILED for %d events (~%d bytes of "
                "clips) — likely OOM or disk IO",
                len(events), approx_bytes,
            )
            raise HTTPException(
                status_code=500,
                detail="failed to build export archive",
            )

    return FileResponse(
        zip_path,
        media_type="application/zip",
        filename="homecam_events.zip",
        background=BackgroundTask(_unlink_quiet, zip_path),
    )


def _unlink_quiet(path: str) -> None:
    """Remove the temp export ZIP after FileResponse finishes streaming.
    logging-plan §2: a failed cleanup leaks disk on the data volume —
    log it (DEBUG) so a slow leak is diagnosable, but never raise (the
    response has already been sent)."""
    try:
        os.unlink(path)
    except FileNotFoundError:
        pass
    except OSError as exc:
        log.debug("export: temp ZIP cleanup failed for %s: %s", path, exc)
