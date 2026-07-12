"""Authenticated local security-platform API."""
from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import tempfile
import time
import uuid
import zipfile
from datetime import datetime
from pathlib import Path
from typing import Annotated, Any, Literal, Union

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from fastapi.responses import FileResponse
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from starlette.background import BackgroundTask

from ..auth.dependencies import get_current_user_role, require_role
from ..config import settings
from ..services import events_db, recording_service
from ..services.detection_config import detection_config
from ..services.security_automation import (
    dry_run,
    execute_actions,
    mask_automation,
    masked_target,
)
from ..services.security_export_capacity import (
    CAPACITY_LOCK,
    ExportCapacityError,
    claim_ephemeral,
    cleanup_owned_temps,
    conservative_reservation,
    ensure_finished_output_fits,
    release_ephemeral,
)
from ..services.security_deterrence import (
    capabilities as deterrence_capabilities,
    manual as manual_deterrence,
)
from ..services.security_resilience import PACKAGE_OVERDUE_S, public_outages
from ..services.security_store import security_store
from ..services import security_timeline
from ..services import media_tokens

router = APIRouter(prefix="/security", tags=["security"])
identity_router = APIRouter(tags=["identity-feedback"])
_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
_NAME_RE = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_-]{0,62}[A-Za-z0-9_]$|^[A-Za-z0-9_]$")
_EXPORT_TASKS: set[asyncio.Task] = set()
_INCIDENT_EXPORT_LOCK = asyncio.Lock()


def _not_found(detail: str = "not found") -> HTTPException:
    return HTTPException(status_code=404, detail=detail)


def _event(event_id: str) -> dict[str, Any]:
    if _ID_RE.fullmatch(event_id) is None:
        raise _not_found("event not found")
    rows = events_db.get_by_ids(settings.events_db_path, [event_id])
    if not rows:
        raise _not_found("event not found")
    return rows[0]


# -- MediaMTX audio grants ----------------------------------------------------


class MediaTokenBody(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    action: Literal["publish", "read"]
    path: Literal["talk", "listen"]


@router.post("/media-token")
async def create_media_token(
    body: MediaTokenBody,
    user_and_role: tuple[str, str] = Depends(get_current_user_role),
) -> dict[str, Any]:
    expected = {("publish", "talk"), ("read", "listen")}
    if (body.action, body.path) not in expected:
        raise HTTPException(
            status_code=422,
            detail="unsupported media action and path combination",
        )
    _username, role = user_and_role
    if body.action == "publish" and role not in {"owner", "admin"}:
        raise HTTPException(status_code=403, detail="owner role required for talk")
    config = detection_config.get()
    if config.operating_mode == "privacy":
        raise HTTPException(
            status_code=409,
            detail="Audio is unavailable while Privacy mode is active.",
        )
    if not config.audio_enabled:
        raise HTTPException(
            status_code=409,
            detail="Audio is disabled; enable configured audio hardware first.",
        )
    try:
        token, expires_ts = media_tokens.issue(body.action, body.path)
    except media_tokens.MediaTokenUnavailable:
        raise HTTPException(
            status_code=503,
            detail="Too many audio sessions are starting; wait and retry.",
        )
    return {"token": token, "expires_ts": expires_ts}


# -- Timeline -----------------------------------------------------------------


@router.get("/timeline")
async def timeline(
    camera_id: Annotated[str, Query(pattern=r"^[a-z0-9_]{1,32}$")],
    since_ts: Annotated[float, Query(gt=0)],
    until_ts: Annotated[float, Query(gt=0)],
) -> dict[str, Any]:
    try:
        segments = await asyncio.to_thread(
            security_timeline.list_segments, camera_id, since_ts, until_ts
        )
    except security_timeline.TimelineError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    gaps, _recorded, _missing = security_timeline.coverage(
        segments, since_ts, until_ts
    )
    markers = await asyncio.to_thread(
        events_db.search,
        settings.events_db_path,
        camera_id=camera_id,
        since_ts=since_ts,
        until_ts=until_ts,
        limit=2000,
    )
    return {
        "v": 1,
        "camera_id": camera_id,
        "since_ts": since_ts,
        "until_ts": until_ts,
        "spans": [segment.public() for segment in segments],
        "gaps": gaps,
        "markers": markers,
    }


@router.get("/timeline/segments/{camera_id}/{filename}")
async def timeline_segment(camera_id: str, filename: str) -> FileResponse:
    try:
        path = await asyncio.to_thread(
            security_timeline.resolve_segment, camera_id, filename
        )
    except security_timeline.TimelineError:
        raise _not_found("segment not found")
    return FileResponse(
        path, media_type="video/mp4",
        headers={"Cache-Control": "private, no-store"},
    )


class TimelineExportBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    camera_id: str = Field(pattern=r"^[a-z0-9_]{1,32}$")
    since_ts: float = Field(gt=0)
    until_ts: float = Field(gt=0)


def _hold_task(task: asyncio.Task, job_id: str) -> None:
    _EXPORT_TASKS.add(task)

    def _done(completed: asyncio.Task) -> None:
        _EXPORT_TASKS.discard(completed)
        if completed.cancelled():
            # asyncio.to_thread cannot stop the underlying thread. Do not mark
            # failed here while it may still publish; restart reconciliation
            # handles a process exit.
            log.warning("timeline export task wrapper cancelled job_id=%s", job_id)
            return
        exc = completed.exception()
        if exc is not None:
            # run_export_job contains its own best-effort terminal transition;
            # retrieving here prevents the event loop's unobserved-exception
            # warning and preserves a safe breadcrumb if that outer guard broke.
            log.error(
                "timeline export task crashed job_id=%s error_type=%s",
                job_id,
                type(exc).__name__,
                exc_info=exc,
            )

    task.add_done_callback(_done)


@router.post("/timeline/exports", status_code=status.HTTP_202_ACCEPTED)
async def create_timeline_export(body: TimelineExportBody) -> dict[str, Any]:
    try:
        job = await asyncio.to_thread(
            security_timeline.create_export_job,
            body.camera_id,
            body.since_ts,
            body.until_ts,
        )
    except ExportCapacityError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.detail)
    except security_timeline.TimelineError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    task = asyncio.create_task(
        asyncio.to_thread(security_timeline.run_export_job, job["id"])
    )
    _hold_task(task, job["id"])
    return job


@router.get("/timeline/exports/{job_id}")
async def timeline_export_status(job_id: str) -> dict[str, Any]:
    if _ID_RE.fullmatch(job_id) is None:
        raise _not_found("export job not found")
    job = security_timeline.get_export_job(job_id)
    if job is None:
        raise _not_found("export job not found")
    return job


@router.get("/timeline/exports/{job_id}/file")
async def timeline_export_file(job_id: str) -> FileResponse:
    if _ID_RE.fullmatch(job_id) is None:
        raise _not_found("export not found")
    path = security_timeline.get_export_path(job_id)
    if path is None:
        raise _not_found("export not ready")
    return FileResponse(
        path,
        media_type="video/mp4",
        filename="homecam-timeline-{}.mp4".format(job_id),
        headers={"Cache-Control": "private, no-store"},
    )


# -- Deterministic local metadata search --------------------------------------

_CLOCK_FILTER_RE = re.compile(
    r"\b(after|before)\s+([0-9]{1,2})(?::([0-9]{2}))?\s*(am|pm)?\b",
    re.IGNORECASE,
)
_SEARCH_STOP_WORDS = {"a", "an", "at", "in", "of", "on", "the"}


def _clock_minute(hour_text: str, minute_text: str | None, suffix: str | None) -> int | None:
    hour = int(hour_text)
    minute = int(minute_text or "0")
    if minute > 59:
        return None
    if suffix:
        if hour < 1 or hour > 12:
            return None
        hour %= 12
        if suffix.casefold() == "pm":
            hour += 12
    elif hour > 23:
        return None
    return hour * 60 + minute


@router.get("/search")
async def security_search(
    q: Annotated[str, Query(min_length=1, max_length=128)],
    limit: Annotated[int, Query(ge=1, le=100)] = 30,
) -> dict[str, Any]:
    query = " ".join(q.lower().split())
    after_minute = None
    before_minute = None
    for match in _CLOCK_FILTER_RE.finditer(query):
        minute = _clock_minute(match.group(2), match.group(3), match.group(4))
        if minute is None:
            continue
        if match.group(1).casefold() == "after":
            after_minute = minute
        else:
            before_minute = minute
    text_query = _CLOCK_FILTER_RE.sub(" ", query)
    unknown_only = bool(re.search(r"\b(?:unknown|unrecognized)\b", text_query))
    text_query = re.sub(r"\b(?:unknown|unrecognized)\b", " ", text_query)
    tokens = [
        "person" if token == "people" else token
        for token in re.split(r"[^a-z0-9]+", text_query)
        if token and token not in _SEARCH_STOP_WORDS
    ]
    rows = await asyncio.to_thread(events_db.recent, settings.events_db_path, 2000)
    ranked: list[tuple[float, float, str, dict[str, Any]]] = []
    for event in rows:
        if unknown_only and not (
            event.get("label") == "person" and not event.get("person_name")
        ):
            continue
        event_time = datetime.fromtimestamp(float(event.get("ts") or 0.0))
        event_minute = event_time.hour * 60 + event_time.minute
        if after_minute is not None and event_minute < after_minute:
            continue
        if before_minute is not None and event_minute >= before_minute:
            continue
        fields = [
            (str(event.get("person_name") or "").lower(), 6.0, "recognized person"),
            (str(event.get("rule_name") or "").lower(), 5.0, "smart rule"),
            (str(event.get("label") or "").replace("_", " ").lower(), 4.0, "event label"),
            (str(event.get("package_state") or "").lower(), 4.0, "package state"),
            (str(event.get("source") or "vision").lower(), 2.0, "signal source"),
            (str(event.get("camera_id") or "").replace("_", " ").lower(), 2.0, "camera"),
        ]
        searchable = " ".join(value for value, _weight, _reason in fields)
        if tokens and not all(token in searchable for token in tokens):
            continue
        matches: list[tuple[float, str]] = []
        for value, weight, reason in fields:
            hits = sum(1 for token in tokens if token in value)
            if hits:
                matches.append((weight * hits, reason))
        if not matches and not (unknown_only or after_minute is not None or before_minute is not None):
            continue
        score = sum(match[0] for match in matches) or 1.0
        if unknown_only:
            reason = "unrecognized person"
        elif after_minute is not None or before_minute is not None:
            reason = "time and metadata filters"
        else:
            reason = max(matches, key=lambda match: (match[0], match[1]))[1]
        who = event.get("person_name") or str(event.get("label", "event")).replace("_", " ")
        normalized_score = min(1.0, score / (max(1, len(tokens)) * 6.0))
        item = {
            "event": event,
            "score": normalized_score,
            "description": "{} at {}".format(who, event.get("camera_id", "camera")),
            "match_reason": reason,
        }
        ranked.append((-score, -float(event.get("ts", 0.0)), str(event.get("id")), item))
    ranked.sort(key=lambda row: row[:3])
    return {
        "v": 1,
        "query": q,
        "index_status": {
            "mode": "local_metadata",
            "status": "ready",
            "indexed_events": len(rows),
        },
        "items": [row[3] for row in ranked[:limit]],
    }


# -- Visits -------------------------------------------------------------------


def _visit_groups() -> list[dict[str, Any]]:
    rows = events_db.recent(settings.events_db_path, 5000)
    rows.sort(key=lambda event: (float(event.get("ts", 0.0)), str(event.get("id"))))
    groups: dict[str, list[dict[str, Any]]] = {}
    last_person: dict[str, tuple[str, float]] = {}
    for event in rows:
        explicit = event.get("visit_id") or event.get("related_event_id")
        person = event.get("person_name")
        ts = float(event.get("start_ts") or event.get("ts") or 0.0)
        if explicit:
            group_id = "visit:{}".format(explicit)
        elif person:
            person_key = str(person).casefold()
            previous = last_person.get(person_key)
            if previous is not None and ts - previous[1] <= 300.0:
                group_id = previous[0]
            else:
                group_id = "person:{}:{}".format(
                    re.sub(r"[^a-z0-9]+", "_", person_key).strip("_") or "person",
                    event["id"],
                )
            last_person[person_key] = (group_id, float(event.get("end_ts") or ts))
        else:
            # Unknown events are deliberately never grouped merely because
            # they happened near each other.
            group_id = "event:{}".format(event["id"])
        groups.setdefault(group_id, []).append(event)

    out: list[dict[str, Any]] = []
    for group_id, events in groups.items():
        starts = [float(event.get("start_ts") or event.get("ts") or 0.0) for event in events]
        ends = [float(event.get("end_ts") or event.get("ts") or 0.0) for event in events]
        names = [event.get("person_name") for event in events if event.get("person_name")]
        summary = {
            "id": group_id,
            "visit_id": next((event.get("visit_id") or event.get("related_event_id") for event in events if event.get("visit_id") or event.get("related_event_id")), None),
            "start_ts": min(starts),
            "end_ts": max(ends),
            "person_name": names[0] if names else None,
            "camera_ids": sorted({str(event.get("camera_id")) for event in events}),
            "event_ids": [str(event["id"]) for event in events],
            "event_count": len(events),
            "events": events,
            "people": sorted({str(name) for name in names}),
            "labels": sorted({str(event.get("label")) for event in events}),
        }
        out.append(summary)
    return sorted(out, key=lambda visit: (-visit["start_ts"], visit["id"]))


@router.get("/visits")
async def visits(
    limit: Annotated[int, Query(ge=1, le=500)] = 100,
) -> dict[str, Any]:
    groups = await asyncio.to_thread(_visit_groups)
    keys = {"id", "start_ts", "end_ts", "camera_ids", "people", "labels", "events"}
    items = [{key: value for key, value in group.items() if key in keys} for group in groups[:limit]]
    return {"items": items}


@router.get("/visits/{visit_id:path}")
async def visit_detail(visit_id: str) -> dict[str, Any]:
    groups = await asyncio.to_thread(_visit_groups)
    for group in groups:
        if group["id"] == visit_id:
            keys = {"id", "start_ts", "end_ts", "camera_ids", "people", "labels", "events"}
            return {key: value for key, value in group.items() if key in keys}
    raise _not_found("visit not found")


# -- Incidents and evidence ---------------------------------------------------


class IncidentCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    title: str = Field(min_length=1, max_length=120)
    notes: str = Field(default="", max_length=5000)
    event_id: str | None = Field(default=None, pattern=r"^[A-Za-z0-9_-]{1,128}$")

    @field_validator("title")
    @classmethod
    def _title(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("title must not be blank")
        return value.strip()


class IncidentPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")
    title: str | None = Field(default=None, min_length=1, max_length=120)
    notes: str | None = Field(default=None, max_length=5000)
    status: Literal["open", "closed"] | None = None


def _incident_public(row: dict[str, Any], include_events: bool = False) -> dict[str, Any]:
    result = {k: v for k, v in row.items() if k not in {"audit"}}
    result["event_count"] = len(row.get("event_ids", []))
    if include_events:
        result["events"] = events_db.get_by_ids(
            settings.events_db_path, list(row.get("event_ids", []))
        )
        result["audit"] = row.get("audit", [])
    return result


def _incident_audit(row: dict[str, Any], action: str, username: str, **detail: Any) -> None:
    row.setdefault("audit", []).append({
        "ts": time.time(), "action": action, "username": username, **detail,
    })


def _require_incident_owner(row: dict[str, Any], username: str) -> None:
    if row.get("owner_username") != username:
        raise HTTPException(
            status_code=403,
            detail="only the incident owner may change or export this incident",
        )


@router.get("/incidents")
async def incidents() -> dict[str, Any]:
    rows = security_store.read()["incidents"].values()
    items = sorted(
        [_incident_public(row) for row in rows if isinstance(row, dict)],
        key=lambda row: (-float(row.get("updated_ts", 0.0)), str(row.get("id"))),
    )
    return {"v": 1, "items": items, "total": len(items)}


@router.post("/incidents", status_code=status.HTTP_201_CREATED)
async def create_incident(
    body: IncidentCreate,
    username: str = Depends(require_role("owner")),
) -> dict[str, Any]:
    previous_retention = None
    if body.event_id is not None:
        await asyncio.to_thread(_event, body.event_id)
        previous_retention = events_db.retention_class_by_id(
            settings.events_db_path
        ).get(body.event_id, "ordinary")
        if not await asyncio.to_thread(
            events_db.set_retention_class,
            settings.events_db_path,
            body.event_id,
            "incident",
        ):
            raise _not_found("event not found")
    now = time.time()
    row = {
        "id": uuid.uuid4().hex,
        "owner_username": username,
        "title": body.title,
        "notes": body.notes,
        "status": "open",
        "event_ids": [body.event_id] if body.event_id is not None else [],
        "created_ts": now,
        "updated_ts": now,
        "audit": [],
    }
    _incident_audit(row, "created", username)
    if body.event_id is not None:
        _incident_audit(row, "event_added", username, event_id=body.event_id)

    def _add(state: dict[str, Any]) -> dict[str, Any]:
        state["incidents"][row["id"]] = row
        return row
    try:
        created = security_store.transact(_add)
    except Exception:
        if body.event_id is not None and previous_retention is not None:
            await asyncio.to_thread(
                events_db.set_retention_class,
                settings.events_db_path,
                body.event_id,
                previous_retention,
            )
        raise
    return _incident_public(created, include_events=True)


@router.get("/incidents/{incident_id}")
async def incident_detail(incident_id: str) -> dict[str, Any]:
    row = security_store.read()["incidents"].get(incident_id)
    if not isinstance(row, dict):
        raise _not_found("incident not found")
    return _incident_public(row, include_events=True)


@router.patch("/incidents/{incident_id}")
async def update_incident(
    incident_id: str,
    body: IncidentPatch,
    username: str = Depends(require_role("owner")),
) -> dict[str, Any]:
    patch = body.model_dump(exclude_unset=True)
    if "title" in patch:
        patch["title"] = patch["title"].strip()

    def _update(state: dict[str, Any]) -> dict[str, Any]:
        row = state["incidents"].get(incident_id)
        if not isinstance(row, dict):
            raise KeyError
        _require_incident_owner(row, username)
        row.update(patch)
        row["updated_ts"] = time.time()
        _incident_audit(row, "updated", username, fields=sorted(patch))
        return row
    try:
        row = security_store.transact(_update)
    except KeyError:
        raise _not_found("incident not found")
    return _incident_public(row, include_events=True)


@router.delete("/incidents/{incident_id}")
async def delete_incident(
    incident_id: str,
    username: str = Depends(require_role("owner")),
) -> dict[str, bool]:
    def _delete(state: dict[str, Any]) -> bool:
        row = state["incidents"].get(incident_id)
        if not isinstance(row, dict):
            return False
        _require_incident_owner(row, username)
        del state["incidents"][incident_id]
        return True
    if not security_store.transact(_delete):
        raise _not_found("incident not found")
    return {"deleted": True}


@router.post("/incidents/{incident_id}/events/{event_id}")
async def add_incident_event(
    incident_id: str,
    event_id: str,
    username: str = Depends(require_role("owner")),
) -> dict[str, Any]:
    await asyncio.to_thread(_event, event_id)

    def _add(state: dict[str, Any]) -> dict[str, Any]:
        row = state["incidents"].get(incident_id)
        if not isinstance(row, dict):
            raise KeyError
        _require_incident_owner(row, username)
        if event_id not in row["event_ids"]:
            row["event_ids"].append(event_id)
            _incident_audit(row, "event_added", username, event_id=event_id)
            row["updated_ts"] = time.time()
        return row
    try:
        row = security_store.transact(_add)
    except KeyError:
        raise _not_found("incident not found")
    await asyncio.to_thread(
        events_db.set_retention_class, settings.events_db_path, event_id, "incident"
    )
    return _incident_public(row, include_events=True)


@router.delete("/incidents/{incident_id}/events/{event_id}")
async def remove_incident_event(
    incident_id: str,
    event_id: str,
    username: str = Depends(require_role("owner")),
) -> dict[str, Any]:
    def _remove(state: dict[str, Any]) -> tuple[dict[str, Any], bool]:
        row = state["incidents"].get(incident_id)
        if not isinstance(row, dict):
            raise KeyError
        _require_incident_owner(row, username)
        if event_id in row.get("event_ids", []):
            row["event_ids"].remove(event_id)
            _incident_audit(row, "event_removed", username, event_id=event_id)
            row["updated_ts"] = time.time()
        still_used = any(
            event_id in other.get("event_ids", [])
            for other in state["incidents"].values()
            if isinstance(other, dict)
        )
        return row, still_used
    try:
        row, still_used = security_store.transact(_remove)
    except KeyError:
        raise _not_found("incident not found")
    # Never auto-unprotect here: the event may have been manually protected
    # before it joined this incident. Explicit event protection owns removal.
    del still_used
    return _incident_public(row, include_events=True)


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _pdf_escape(value: str) -> str:
    return value.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")


def _incident_pdf(row: dict[str, Any], events: list[dict[str, Any]]) -> bytes:
    """Generate a dependency-free, printable evidence summary PDF."""
    lines = [
        "HomeCam Incident Report",
        "Title: {}".format(row.get("title") or "Untitled"),
        "Owner: {}".format(row.get("owner_username") or "Unknown"),
        "Status: {}".format(row.get("status") or "open"),
        "Created: {}".format(time.strftime("%Y-%m-%d %H:%M:%S %Z", time.localtime(float(row.get("created_ts", 0))))),
        "Evidence events: {}".format(len(events)),
        "",
    ]
    notes = str(row.get("notes") or "No notes.").replace("\r", " ").replace("\n", " ")
    lines.extend(["Notes:", notes[:500], "", "Evidence timeline:"])
    for event in sorted(events, key=lambda item: float(item.get("ts", 0))):
        stamp = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(float(event.get("ts", 0))))
        subject = event.get("person_name") or event.get("label") or "event"
        lines.append("{}  {}  {}".format(stamp, subject, event.get("id")))
    lines = [line[:105] for line in lines[:48]]
    content = ["BT", "/F1 11 Tf", "50 760 Td"]
    for index, line in enumerate(lines):
        if index:
            content.append("0 -14 Td")
        content.append("({}) Tj".format(_pdf_escape(line)))
    content.append("ET")
    stream = "\n".join(content).encode("latin-1", "replace")
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        b"<< /Length %d >>\nstream\n" % len(stream) + stream + b"\nendstream",
    ]
    body = bytearray(b"%PDF-1.4\n%HomeCam\n")
    offsets = [0]
    for number, obj in enumerate(objects, 1):
        offsets.append(len(body))
        body.extend("{} 0 obj\n".format(number).encode())
        body.extend(obj + b"\nendobj\n")
    xref = len(body)
    body.extend("xref\n0 {}\n".format(len(objects) + 1).encode())
    body.extend(b"0000000000 65535 f \n")
    for offset in offsets[1:]:
        body.extend("{:010d} 00000 n \n".format(offset).encode())
    body.extend(
        "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{}\n%%EOF\n".format(
            len(objects) + 1, xref
        ).encode()
    )
    return bytes(body)


def _incident_reservation(row: dict[str, Any]) -> int:
    events = events_db.get_by_ids(
        settings.events_db_path, list(row.get("event_ids", []))
    )
    sizes = [len(json.dumps(events, sort_keys=True).encode("utf-8"))]
    for event in events:
        clip = recording_service.clip_path(str(event["id"]))
        if clip is not None and clip.is_file():
            try:
                sizes.append(clip.stat().st_size)
            except OSError:
                continue
    return conservative_reservation(sizes)


def _build_evidence_zip(
    row: dict[str, Any], capacity_key: str
) -> tuple[Path, str]:
    settings.security_exports_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    unique = uuid.uuid4().hex
    fd, raw_path = tempfile.mkstemp(
        prefix=".incident-{}-{}-".format(row["id"], unique), suffix=".part.zip",
        dir=str(settings.security_exports_dir),
    )
    os.close(fd)
    temp_path = Path(raw_path)
    final_path = settings.security_exports_dir / "incident-{}-{}.zip".format(
        row["id"], unique
    )
    temp_path.chmod(0o600)
    events = events_db.get_by_ids(settings.events_db_path, list(row.get("event_ids", [])))
    evidence: list[dict[str, Any]] = []
    published = False
    try:
        with zipfile.ZipFile(temp_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            events_body = json.dumps(events, indent=2, sort_keys=True).encode("utf-8")
            archive.writestr("events.json", events_body)
            evidence.append({"path": "events.json", "sha256": hashlib.sha256(events_body).hexdigest(), "bytes": len(events_body)})
            report_body = _incident_pdf(row, events)
            archive.writestr("incident-report.pdf", report_body)
            evidence.append({"path": "incident-report.pdf", "sha256": hashlib.sha256(report_body).hexdigest(), "bytes": len(report_body)})
            for event in events:
                clip = recording_service.clip_path(str(event["id"]))
                if clip is not None and clip.is_file():
                    name = "clips/{}.mp4".format(event["id"])
                    archive.write(clip, name, compress_type=zipfile.ZIP_STORED)
                    evidence.append({"path": name, "sha256": _sha256_file(clip), "bytes": clip.stat().st_size})
            manifest = {
                "v": 1,
                "created_ts": time.time(),
                "incident": _incident_public(row),
                "audit": row.get("audit", []),
                "evidence": evidence,
            }
            manifest_body = json.dumps(manifest, indent=2, sort_keys=True).encode("utf-8")
            archive.writestr("manifest.json", manifest_body)
        output_size = temp_path.stat().st_size
        digest = _sha256_file(temp_path)
        with CAPACITY_LOCK:
            ensure_finished_output_fits(
                security_store.read(), output_size,
                exclude_ephemeral_key=capacity_key,
            )
            os.replace(temp_path, final_path)
            final_path.chmod(0o600)
            published = True
        return final_path, digest
    finally:
        try:
            temp_path.unlink(missing_ok=True)
        except OSError:
            pass
        if not published:
            try:
                final_path.unlink(missing_ok=True)
            except OSError:
                pass


@router.post("/incidents/{incident_id}/export")
async def export_incident(
    incident_id: str,
    username: str = Depends(require_role("owner")),
) -> FileResponse:
    def _audit_request(state: dict[str, Any]) -> dict[str, Any]:
        row = state["incidents"].get(incident_id)
        if not isinstance(row, dict):
            raise KeyError
        _require_incident_owner(row, username)
        _incident_audit(row, "evidence_export_requested", username)
        row["updated_ts"] = time.time()
        return row
    try:
        row = security_store.transact(_audit_request)
    except KeyError:
        raise _not_found("incident not found")
    capacity_key = "incident:{}".format(uuid.uuid4().hex)
    try:
        reservation = await asyncio.to_thread(_incident_reservation, row)
        with CAPACITY_LOCK:
            claim_ephemeral(capacity_key, reservation, security_store.read())
        async with _INCIDENT_EXPORT_LOCK:
            with CAPACITY_LOCK:
                cleanup_owned_temps(
                    security_store.read(),
                    include_timeline=False,
                    include_incident=True,
                )
            path, digest = await asyncio.to_thread(
                _build_evidence_zip, row, capacity_key
            )
    except ExportCapacityError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.detail)
    finally:
        release_ephemeral(capacity_key)

    def _audit_success(state: dict[str, Any]) -> None:
        current = state["incidents"].get(incident_id)
        if isinstance(current, dict):
            _require_incident_owner(current, username)
            _incident_audit(current, "evidence_exported", username)
            current["updated_ts"] = time.time()

    try:
        security_store.transact(_audit_success)
        return FileResponse(
            path,
            media_type="application/zip",
            filename="homecam-incident-{}.zip".format(incident_id),
            headers={
                "X-HomeCam-SHA256": digest,
                "Cache-Control": "private, no-store",
            },
            background=BackgroundTask(path.unlink, missing_ok=True),
        )
    except Exception:
        # If the success audit or response construction fails after publish,
        # no BackgroundTask will run. Do not leak an unreferenced retained ZIP.
        try:
            path.unlink(missing_ok=True)
        except OSError:
            pass
        raise


# -- Automations --------------------------------------------------------------


class AutomationTriggers(BaseModel):
    model_config = ConfigDict(extra="forbid")
    labels: list[Annotated[str, Field(pattern=r"^[a-z0-9_]{1,64}$")]] = Field(default_factory=list, max_length=32)
    sources: list[Literal["vision", "audio", "doorbell", "tamper", "system"]] = Field(default_factory=list, max_length=5)
    camera_ids: list[Annotated[str, Field(pattern=r"^[a-z0-9_]{1,32}$")]] = Field(default_factory=list, max_length=32)
    rule_ids: list[Annotated[str, Field(pattern=r"^[a-z0-9_]{1,32}$")]] = Field(default_factory=list, max_length=16)


class AutomationConditions(BaseModel):
    model_config = ConfigDict(extra="forbid")
    operating_modes: list[Literal["home", "away", "night", "privacy"]] = Field(default_factory=list, max_length=4)
    person: Literal["any", "known", "unknown"] = "any"
    min_score: float = Field(default=0.0, ge=0.0, le=1.0)


class PushAction(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["push"]
    title: str | None = Field(default=None, min_length=1, max_length=80)


class WebhookAction(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["webhook"]
    url: str = Field(min_length=8, max_length=2048)
    secret: str | None = Field(default=None, max_length=256)

    @field_validator("url")
    @classmethod
    def _url(cls, value: str) -> str:
        masked_target(value)
        return value


class MqttAction(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["mqtt"]
    topic: str = Field(min_length=1, max_length=256, pattern=r"^[^+#\x00]+$")


class PhysicalAction(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["light", "warning", "siren"]
    duration_s: float = Field(default=10.0, ge=1.0, le=60.0)


AutomationAction = Annotated[
    Union[PushAction, WebhookAction, MqttAction, PhysicalAction],
    Field(discriminator="kind"),
]


class AutomationBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=1, max_length=80)
    enabled: bool = True
    triggers: AutomationTriggers = Field(default_factory=AutomationTriggers)
    conditions: AutomationConditions = Field(default_factory=AutomationConditions)
    actions: list[AutomationAction] = Field(min_length=1, max_length=8)

    @field_validator("name")
    @classmethod
    def _name(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("name must not be blank")
        return value.strip()

    @model_validator(mode="after")
    def _physical_needs_rule(self) -> "AutomationBody":
        if any(action.kind in {"light", "warning", "siren"} for action in self.actions):
            if not self.triggers.rule_ids:
                raise ValueError("physical actions require an explicit smart rule trigger")
        return self


def _preserve_webhook_secrets(
    actions: list[dict[str, Any]], old: dict[str, Any] | None
) -> list[dict[str, Any]]:
    old_actions = old.get("actions", []) if isinstance(old, dict) else []
    for index, action in enumerate(actions):
        if action.get("kind") != "webhook" or action.get("secret") is not None:
            continue
        if (
            index < len(old_actions)
            and old_actions[index].get("kind") == "webhook"
            and old_actions[index].get("url") == action.get("url")
        ):
            action["secret"] = old_actions[index].get("secret")
    return actions


@router.get("/automations")
async def automations() -> dict[str, Any]:
    rows = security_store.read()["automations"].values()
    items = sorted(
        [mask_automation(row) for row in rows if isinstance(row, dict)],
        key=lambda row: (str(row.get("name", "")).casefold(), str(row.get("id"))),
    )
    return {"v": 1, "items": items, "total": len(items)}


@router.post("/automations", status_code=status.HTTP_201_CREATED)
async def create_automation(
    body: AutomationBody,
    _username: str = Depends(require_role("owner")),
) -> dict[str, Any]:
    now = time.time()
    row = {
        "id": uuid.uuid4().hex,
        **body.model_dump(),
        "created_ts": now,
        "updated_ts": now,
    }

    def _add(state: dict[str, Any]) -> dict[str, Any]:
        state["automations"][row["id"]] = row
        return row
    return mask_automation(security_store.transact(_add))


@router.get("/automations/{automation_id}")
async def automation_detail(automation_id: str) -> dict[str, Any]:
    row = security_store.read()["automations"].get(automation_id)
    if not isinstance(row, dict):
        raise _not_found("automation not found")
    return mask_automation(row)


@router.put("/automations/{automation_id}")
async def update_automation(
    automation_id: str,
    body: AutomationBody,
    _username: str = Depends(require_role("owner")),
) -> dict[str, Any]:
    incoming = body.model_dump()

    def _update(state: dict[str, Any]) -> dict[str, Any]:
        old = state["automations"].get(automation_id)
        if not isinstance(old, dict):
            raise KeyError
        incoming["actions"] = _preserve_webhook_secrets(incoming["actions"], old)
        row = {
            "id": automation_id,
            **incoming,
            "created_ts": old.get("created_ts", time.time()),
            "updated_ts": time.time(),
        }
        state["automations"][automation_id] = row
        return row
    try:
        row = security_store.transact(_update)
    except KeyError:
        raise _not_found("automation not found")
    return mask_automation(row)


class AutomationToggleBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    enabled: bool


@router.patch("/automations/{automation_id}")
async def toggle_automation(
    automation_id: str,
    body: AutomationToggleBody,
    _username: str = Depends(require_role("owner")),
) -> dict[str, Any]:
    """Change only enabled state; never round-trip masked webhook data."""
    def _update(state: dict[str, Any]) -> dict[str, Any]:
        row = state["automations"].get(automation_id)
        if not isinstance(row, dict):
            raise KeyError
        row["enabled"] = body.enabled
        row["updated_ts"] = time.time()
        return row

    try:
        row = security_store.transact(_update)
    except KeyError:
        raise _not_found("automation not found")
    return mask_automation(row)


@router.delete("/automations/{automation_id}")
async def delete_automation(
    automation_id: str,
    _username: str = Depends(require_role("owner")),
) -> dict[str, bool]:
    def _delete(state: dict[str, Any]) -> bool:
        return state["automations"].pop(automation_id, None) is not None
    if not security_store.transact(_delete):
        raise _not_found("automation not found")
    return {"ok": True}


class AutomationTestBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    event_id: str | None = Field(default=None, pattern=r"^[A-Za-z0-9_-]{1,128}$")


@router.post("/automations/{automation_id}/test")
async def test_automation(
    automation_id: str,
    body: AutomationTestBody | None = None,
    _username: str = Depends(require_role("owner")),
) -> dict[str, Any]:
    row = security_store.read()["automations"].get(automation_id)
    if not isinstance(row, dict):
        raise _not_found("automation not found")
    if body is not None and body.event_id:
        event = await asyncio.to_thread(_event, body.event_id)
    else:
        latest = await asyncio.to_thread(events_db.recent, settings.events_db_path, 1)
        if not latest:
            raise HTTPException(status_code=409, detail="no event is available for test")
        event = latest[0]
    plan = dry_run(row, event)
    return {
        "ok": True,
        "automation_id": automation_id,
        "matched": plan["matched"],
        "dry_run": True,
        "results": plan["results"],
    }


# -- Outages, packages, identity and deterrence -------------------------------


@router.get("/outages")
async def outages() -> dict[str, Any]:
    return public_outages()


@router.get("/packages/current")
async def current_packages() -> dict[str, Any]:
    now = time.time()
    items: list[dict[str, Any]] = []
    for package in security_store.read()["packages"].values():
        if not isinstance(package, dict) or package.get("state") not in {"present", "possible_theft"}:
            continue
        delivered_at = float(package.get("delivered_at", package.get("last_seen_at", now)))
        event_id = package.get("event_id")
        event_rows = (
            events_db.get_by_ids(settings.events_db_path, [str(event_id)])
            if event_id else []
        )
        event = event_rows[0] if event_rows else {}
        item = {
            "correlation_id": package.get("correlation_id"),
            "state": package.get("state"),
            "camera_id": package.get("camera_id"),
            "first_seen_ts": delivered_at,
            "updated_ts": float(package.get("last_seen_at", delivered_at)),
            "event_id": event_id,
            "thumb_url": event.get("thumb_url"),
        }
        item["overdue_at"] = delivered_at + PACKAGE_OVERDUE_S
        item["overdue"] = now >= item["overdue_at"]
        items.append(item)
    items.sort(key=lambda row: (float(row.get("first_seen_ts", 0.0)), str(row.get("correlation_id"))))
    return {"v": 1, "items": items, "total": len(items)}


class IdentityFeedbackBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    verdict: Literal["correct", "incorrect"]
    correct_name: str | None = Field(default=None, min_length=1, max_length=64)

    @field_validator("correct_name")
    @classmethod
    def _safe_correct_name(cls, value: str | None) -> str | None:
        if value is None:
            return None
        cleaned = value.strip()
        if _NAME_RE.fullmatch(cleaned) is None or cleaned == "__unknown__":
            raise ValueError("correct_name must be a safe enrolled face name")
        return cleaned


def _move_event_captures(event_id: str, target_name: str) -> int:
    moved = 0
    for root in (settings.face_captures_dir, settings.person_captures_dir):
        if not root.is_dir():
            continue
        target = (root / target_name).resolve()
        try:
            target.relative_to(root.resolve())
        except ValueError:
            raise ValueError("capture target escapes root")
        target.mkdir(parents=True, exist_ok=True, mode=0o700)
        for path in root.glob("*/"):  # direct name buckets only
            if not path.is_dir() or path == target:
                continue
            for child in path.glob("*_{}.jpg".format(event_id)):
                destination = target / child.name
                if destination.exists():
                    destination = target / "{}_{}".format(uuid.uuid4().hex[:8], child.name)
                os.replace(child, destination)
                destination.chmod(0o600)
                sidecar = child.with_suffix(".json")
                if sidecar.is_file():
                    sidecar_dest = destination.with_suffix(".json")
                    os.replace(sidecar, sidecar_dest)
                    sidecar_dest.chmod(0o600)
                    _annotate_sidecar(sidecar_dest, corrected_name=target_name)
                moved += 1
    return moved


def _annotate_sidecar(path: Path, **patch: Any) -> None:
    temp: Path | None = None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            return
        data.update(patch)
        temp = path.with_suffix(path.suffix + ".tmp")
        payload = json.dumps(data, sort_keys=True, separators=(",", ":")).encode("utf-8")
        fd = os.open(str(temp), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        try:
            view = memoryview(payload)
            written = 0
            while written < len(view):
                count = os.write(fd, view[written:])
                if count <= 0:
                    raise OSError("short sidecar write")
                written += count
            os.fsync(fd)
        finally:
            os.close(fd)
        os.replace(temp, path)
    except (OSError, ValueError):
        try:
            if temp is not None:
                temp.unlink(missing_ok=True)
        except OSError:
            pass


@router.post("/events/{event_id}/identity-feedback")
@identity_router.post("/events/{event_id}/identity-feedback")
async def identity_feedback(
    event_id: str,
    body: IdentityFeedbackBody,
    _username: str = Depends(require_role("owner")),
) -> dict[str, Any]:
    event = await asyncio.to_thread(_event, event_id)
    if body.verdict == "correct":
        person_name = event.get("person_name")
        if not person_name:
            raise HTTPException(status_code=409, detail="event has no identity to confirm")
    else:
        person_name = body.correct_name
    changed = await asyncio.to_thread(
        events_db.update_identity, settings.events_db_path, event_id, person_name
    )
    if not changed:
        raise _not_found("event not found")
    bucket = person_name or "__unknown__"
    moved = await asyncio.to_thread(_move_event_captures, event_id, bucket)
    updated = await asyncio.to_thread(_event, event_id)
    return {"ok": True, "event": updated, "captures_moved": moved}


class FaceMergeBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    source_name: str = Field(pattern=r"^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$")
    target_name: str = Field(pattern=r"^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$")

    @model_validator(mode="after")
    def _different(self) -> "FaceMergeBody":
        if self.source_name == self.target_name:
            raise ValueError("source and target must differ")
        return self


def _merge_face_dirs(source_name: str, target_name: str) -> int:
    moved = 0
    for root in (settings.face_captures_dir, settings.person_captures_dir):
        source = (root / source_name).resolve()
        target = (root / target_name).resolve()
        try:
            source.relative_to(root.resolve())
            target.relative_to(root.resolve())
        except ValueError:
            continue
        if not source.is_dir():
            continue
        target.mkdir(parents=True, exist_ok=True, mode=0o700)
        # Move JPEG + sidecar as one logical capture. A shared collision
        # prefix preserves their basename relationship.
        for child in list(source.glob("*.jpg")):
            if not child.is_file():
                continue
            sidecar = child.with_suffix(".json")
            stem = child.stem
            if (target / child.name).exists() or (target / sidecar.name).exists():
                stem = "{}_{}".format(uuid.uuid4().hex[:8], stem)
            destination = target / "{}.jpg".format(stem)
            sidecar_destination = target / "{}.json".format(stem)
            os.replace(child, destination)
            destination.chmod(0o600)
            moved += 1
            if sidecar.is_file():
                os.replace(sidecar, sidecar_destination)
                sidecar_destination.chmod(0o600)
                _annotate_sidecar(sidecar_destination, merged_into=target_name)
                moved += 1
        # Preserve any orphan metadata/auxiliary file without letting it
        # overwrite target data.
        for child in list(source.iterdir()):
            if not child.is_file():
                continue
            destination = target / child.name
            if destination.exists():
                destination = target / "{}_{}".format(uuid.uuid4().hex[:8], child.name)
            os.replace(child, destination)
            destination.chmod(0o600)
            if destination.suffix == ".json":
                _annotate_sidecar(destination, merged_into=target_name)
            moved += 1
        try:
            source.rmdir()
        except OSError:
            pass
    return moved


@router.post("/face/merge")
@identity_router.post("/face/merge")
async def merge_faces(
    body: FaceMergeBody,
    _username: str = Depends(require_role("owner")),
) -> dict[str, Any]:
    moved = await asyncio.to_thread(
        _merge_face_dirs, body.source_name, body.target_name
    )
    events_updated = await asyncio.to_thread(
        events_db.merge_identity,
        settings.events_db_path,
        body.source_name,
        body.target_name,
    )
    def _merge_preference(state: dict[str, Any]) -> None:
        prefs = state["face_preferences"]
        source_pref = prefs.pop(body.source_name, None)
        if source_pref is not None and body.target_name not in prefs:
            prefs[body.target_name] = source_pref

    security_store.transact(_merge_preference)
    return {
        "ok": True,
        "source_name": body.source_name,
        "target_name": body.target_name,
        "files_moved": moved,
        "moved": moved,
        "events_updated": events_updated,
        "retrain_required": moved > 0,
    }


class FacePreferenceBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    notification: Literal["all", "smart", "none"] | None = None
    alerts_enabled: bool | None = None

    @model_validator(mode="after")
    def _at_least_one(self) -> "FacePreferenceBody":
        if self.notification is None and self.alerts_enabled is None:
            raise ValueError("notification or alerts_enabled is required")
        return self


@router.get("/face/preferences")
@identity_router.get("/face/preferences")
async def face_preferences() -> dict[str, Any]:
    prefs = security_store.read()["face_preferences"]
    items = []
    for name, raw in sorted(prefs.items(), key=lambda row: row[0].casefold()):
        if isinstance(raw, dict):
            notification = raw.get("notification", "smart")
            alerts_enabled = bool(raw.get("alerts_enabled", notification != "none"))
        else:
            notification = raw
            alerts_enabled = raw != "none"
        items.append({
            "name": name,
            "notification": notification,
            "alerts_enabled": alerts_enabled,
        })
    return {"v": 1, "items": items, "total": len(items)}


@router.put("/face/preferences/{name}")
@identity_router.put("/face/preferences/{name}")
async def update_face_preference(
    name: str,
    body: FacePreferenceBody,
    _username: str = Depends(require_role("owner")),
) -> dict[str, Any]:
    if _NAME_RE.fullmatch(name) is None:
        raise HTTPException(status_code=422, detail="invalid face name")

    def _update(state: dict[str, Any]) -> dict[str, Any]:
        old = state["face_preferences"].get(name, {})
        if not isinstance(old, dict):
            old = {"notification": old, "alerts_enabled": old != "none"}
        notification = body.notification or old.get("notification", "smart")
        alerts_enabled = (
            body.alerts_enabled
            if body.alerts_enabled is not None
            else notification != "none"
        )
        value = {
            "notification": notification,
            "alerts_enabled": alerts_enabled,
        }
        state["face_preferences"][name] = value
        return {"name": name, **value}
    return security_store.transact(_update)


class DeterrenceBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    action: Literal["light", "warning", "siren"]
    duration_s: float = Field(ge=1.0, le=60.0)
    confirm: bool
    event_id: str | None = Field(default=None, pattern=r"^[A-Za-z0-9_-]{1,128}$")


@router.get("/deterrence/capabilities")
async def get_deterrence_capabilities(
    _username: str = Depends(require_role("owner")),
) -> dict[str, Any]:
    config = detection_config.get()
    return {
        "v": 1,
        **deterrence_capabilities(),
        "armed": config.deterrence_enabled,
        "privacy_blocked": config.operating_mode == "privacy",
        "supported_actions": ["light", "warning", "siren"],
    }


@router.post("/deterrence")
async def deterrence(
    body: DeterrenceBody,
    username: str = Depends(require_role("owner")),
) -> dict[str, Any]:
    if body.event_id is not None:
        await asyncio.to_thread(_event, body.event_id)
    return await asyncio.to_thread(
        manual_deterrence,
        body.action,
        body.duration_s,
        confirm=body.confirm,
        username=username,
        event_id=body.event_id,
    )
