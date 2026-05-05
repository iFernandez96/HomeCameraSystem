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
import io
import json
import re
import zipfile
from typing import List

from fastapi import APIRouter, HTTPException, Path
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel, ConfigDict, Field

from ..config import settings
from ..services import events_db, recording_service


router = APIRouter()

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
# ZIP builds at 2. The asyncio thread pool on the Nano 2GB is small
# (default 8 workers); 8 simultaneous /api/events/export requests
# would saturate it and BLOCK every other to_thread caller —
# heartbeat DB writes (`_internal.py`), events search (`events.py`),
# people list, count_by_day. The container stays healthy (no OOM,
# no crash) but every API endpoint's latency spikes to seconds with
# no observable signal — `restart` is the only operator lever. The
# Semaphore caps concurrent zip builds at 2 so the other 6 thread-
# pool slots stay free for the rest of the API. Held during the
# `_build_export_zip` to_thread call only — the events_db lookup
# at the start of the route does NOT take the semaphore.
_EXPORT_SEMAPHORE = asyncio.Semaphore(2)


@router.get("/events/{event_id}/clip")
def get_event_clip(
    # iter-201: regex on the path param is the first wire-side
    # defense against path traversal — the service-layer
    # `clip_path` also validates. Same charset as
    # `recording_service._VALID_EVENT_ID`.
    event_id: str = Path(..., pattern=r"^[A-Za-z0-9_-]+$", max_length=128),
) -> FileResponse:
    if not recording_service.clip_exists(event_id):
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


def _build_export_zip(events: list[dict]) -> bytes:
    """iter-330: build the ZIP in-memory. At 50 events × ~200 KB
    average (clip + thumb + manifest entry) the bundle is ~10 MB —
    well within RAM headroom even on the Nano. Streaming via the
    generator interface adds complexity that this endpoint doesn't
    need at the documented scale; if a future iter raises the cap
    past 200 events, swap to `zipfile.ZipFile(StreamingResponse(...))`
    with a chunked generator.

    The manifest.json captures the events_db row data so the
    operator has a sidecar record of label / score / person_name /
    timestamps even after retention sweeps the source DB rows. JSON
    matches the `/api/events` wire shape.

    Path-traversal: `clip_path()` and snapshots resolution both
    re-validate the id / filename against the same regex used at
    insert time. A malicious client cannot inject `../etc/passwd`
    via event_ids — the `_ExportBody.event_ids` Pydantic regex
    rejects it, AND the recording_service helper rejects it, AND
    the snapshot path resolution rejects it. Three layers.
    """
    buf = io.BytesIO()
    manifest_entries: list[dict] = []
    with zipfile.ZipFile(buf, mode="w", compression=zipfile.ZIP_DEFLATED) as zf:
        for ev in events:
            event_id = ev["id"]
            entry = dict(ev)  # shallow copy for the manifest
            entry["clip_included"] = False
            entry["thumb_included"] = False

            # Clip — only included if recording_service knows about it
            # AND the file is on disk. Missing clips are common (events
            # older than the retention window, or the recorder hadn't
            # spun up yet). Manifest records the absence.
            if recording_service.clip_exists(event_id):
                clip_path = recording_service.clip_path(event_id)
                try:
                    zf.write(clip_path, "{}.mp4".format(event_id))
                    entry["clip_included"] = True
                except OSError:
                    # Race: file was swept between exists() and write().
                    # Manifest still records absence; don't crash export.
                    pass

            # Thumb — resolve via the same path-traversal-safe pattern
            # as the SPA snapshots endpoint. event.thumb_url is something
            # like "/snapshots/thumb_1700000000.jpg" or "/api/snapshots/...".
            thumb_url = ev.get("thumb_url")
            if thumb_url:
                # Strip both legacy and gated URL prefixes to get the bare
                # filename. Any path component is rejected by the strict
                # filename regex below.
                fname = thumb_url.rsplit("/", 1)[-1]
                if re.match(r"^thumb_[0-9]+\.jpg$", fname):
                    target = settings.snapshots_dir / fname
                    try:
                        resolved = target.resolve()
                        resolved.relative_to(settings.snapshots_dir.resolve())
                        if resolved.is_file():
                            zf.write(resolved, "{}.jpg".format(event_id))
                            entry["thumb_included"] = True
                    except (ValueError, OSError):
                        # Path escape or fs error — skip cleanly.
                        pass

            manifest_entries.append(entry)

        # Always emit a manifest, even if zero clips / thumbs landed —
        # the operator at least gets the metadata of what they selected.
        zf.writestr(
            "manifest.json",
            json.dumps(
                {"v": 1, "exported_count": len(manifest_entries), "events": manifest_entries},
                indent=2,
            ),
        )
    return buf.getvalue()


@router.post("/events/export")
async def export_events(body: _ExportBody) -> StreamingResponse:
    """iter-330 (missing-feature #3): bundle one or more event clips +
    thumbnails + a manifest.json into a ZIP for offline / sharing
    use. The owner / family / viewer can all export — the auth gate
    is the same as the rest of /api/events.

    Selection state lives in the client (EventList multi-select);
    the server takes a list of event IDs and streams back a ZIP.
    Missing clips/thumbs (already pruned by retention sweep) appear
    in the manifest with `clip_included: false` / `thumb_included: false`
    so the operator can see what was selected vs delivered.

    Sharp edges respected:
    - 1 MB request body cap (iter-75): 50 short ids easily fit.
    - Path traversal: 3-layer defense (Pydantic regex, recording_service
      regex, Path.resolve+relative_to on the snapshots dir).
    - Thread pool: `asyncio.to_thread` wraps the synchronous
      zipfile build so the asyncio loop isn't blocked on a 5 MB
      compress.
    - Concurrency: `_EXPORT_SEMAPHORE` (iter-337) caps concurrent
      ZIP builds at 2 so the asyncio thread pool isn't saturated
      by 8 simultaneous exports blocking heartbeat / events search.
    """
    # Lookup events_db rows for the requested IDs. Outside the
    # Semaphore so unknown-id 404s + invalid-id 400s respond fast
    # without queuing behind concurrent zip builds.
    events = await asyncio.to_thread(
        events_db.get_by_ids, settings.events_db_path, body.event_ids,
    )
    if not events:
        raise HTTPException(
            status_code=404,
            detail="no events found for the requested IDs",
        )

    # Belt-and-braces: re-validate every id against the export regex
    # before passing to the ZIP builder. Pydantic's max_length already
    # bounded the list, but the per-id regex is enforced HERE because
    # the iter-? Pydantic Field doesn't run a per-item pattern check.
    for ev in events:
        if not _EXPORT_ID_RE.match(ev["id"]):
            raise HTTPException(
                status_code=400,
                detail="invalid event id in selection",
            )

    # iter-337: gate ONLY the expensive ZIP build behind the
    # semaphore — at most 2 concurrent zip-builds across all clients.
    async with _EXPORT_SEMAPHORE:
        zip_bytes = await asyncio.to_thread(_build_export_zip, events)
    return StreamingResponse(
        io.BytesIO(zip_bytes),
        media_type="application/zip",
        headers={
            "Content-Disposition": "attachment; filename=homecam_events.zip",
            "Content-Length": str(len(zip_bytes)),
        },
    )
