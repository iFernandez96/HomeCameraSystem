"""Operator control-center, notification inbox, and saved-search APIs."""
from __future__ import annotations

import asyncio
import re
import urllib.error
from datetime import date
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, ConfigDict, Field, field_validator

from ..auth.dependencies import get_current_user, require_role
from ..config import settings
from ..services import events_db, operations, recording_service


router = APIRouter(prefix="/security", tags=["operations"])
_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,128}$")


class ProfileBody(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    profile: Literal["home", "away", "sleep", "vacation", "privacy"]


class ModeSchedule(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    id: str = Field(pattern=r"^[a-z0-9_]{1,32}$")
    profile: Literal["home", "away", "sleep", "vacation", "privacy"]
    time: str = Field(pattern=r"^(?:[01][0-9]|2[0-3]):[0-5][0-9]$")
    days: list[int] = Field(min_length=1, max_length=7)
    enabled: bool

    @field_validator("days")
    @classmethod
    def _days(cls, value: list[int]) -> list[int]:
        if len(set(value)) != len(value) or any(day < 0 or day > 6 for day in value):
            raise ValueError("days must be unique weekday indexes 0 through 6")
        return value


class ModeSchedulesBody(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    items: list[ModeSchedule] = Field(max_length=16)


class SnoozeBody(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    duration_s: int = Field(ge=60, le=7 * 86400)


class SavedSearchBody(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    name: str = Field(min_length=1, max_length=80)
    query: str = Field(min_length=1, max_length=200)
    semantic: bool = False

    @field_validator("name", "query")
    @classmethod
    def _strip(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("value must not be blank")
        return value


class RetentionBody(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    retention_class: Literal["ordinary", "important", "incident", "permanent"]


class ArchiveBody(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    enabled: bool


class CompanionBody(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    enabled: bool
    base_url: str = Field(default="", max_length=256)
    api_token: str | None = Field(default=None, max_length=512)


class SemanticSearchBody(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    query: str = Field(min_length=1, max_length=200)
    limit: int = Field(default=20, ge=1, le=50)


@router.get("/operations", dependencies=[Depends(require_role("owner"))])
async def operations_state(username: str = Depends(get_current_user)) -> dict[str, Any]:
    state, retention = await asyncio.gather(
        asyncio.to_thread(operations.public_state, username),
        asyncio.to_thread(recording_service.retention_preview),
    )
    state["retention"] = retention
    return state


@router.put("/operations/profile", dependencies=[Depends(require_role("owner"))])
async def set_profile(body: ProfileBody, actor: str = Depends(get_current_user)) -> dict[str, Any]:
    return await asyncio.to_thread(operations.apply_profile, body.profile, actor)


@router.put("/operations/mode-schedules", dependencies=[Depends(require_role("owner"))])
async def set_mode_schedules(body: ModeSchedulesBody) -> dict[str, Any]:
    saved = await asyncio.to_thread(
        operations.replace_mode_schedules,
        [item.model_dump() for item in body.items],
    )
    return {"v": 1, "items": saved}


@router.get("/notifications")
async def notification_inbox(
    limit: Annotated[int, Query(ge=1, le=200)] = 100,
    username: str = Depends(get_current_user),
) -> dict[str, Any]:
    items = await asyncio.to_thread(operations.list_notifications, username, limit)
    return {"v": 1, "items": items, "unread": sum(not row["seen"] for row in items)}


@router.post("/notifications/{notification_id}/seen")
async def notification_seen(notification_id: str, username: str = Depends(get_current_user)) -> dict[str, bool]:
    if _ID_RE.fullmatch(notification_id) is None:
        raise HTTPException(status_code=404, detail="notification not found")
    if not await asyncio.to_thread(operations.mark_notification_seen, username, notification_id):
        raise HTTPException(status_code=404, detail="notification not found")
    return {"seen": True}


@router.post("/notifications/{notification_id}/snooze")
async def notification_snooze(
    notification_id: str, body: SnoozeBody, username: str = Depends(get_current_user)
) -> dict[str, Any]:
    row = next(
        (item for item in operations.list_notifications(username, 200) if item["id"] == notification_id),
        None,
    )
    if row is None:
        raise HTTPException(status_code=404, detail="notification not found")
    until = await asyncio.to_thread(
        operations.snooze, username, str(row["kind"]), body.duration_s
    )
    return {"kind": row["kind"], "snoozed_until": until}


@router.put(
    "/notifications/{notification_id}/retention",
    dependencies=[Depends(require_role("owner"))],
)
async def retain_notification_event(
    notification_id: str,
    body: RetentionBody,
    username: str = Depends(get_current_user),
) -> dict[str, Any]:
    row = next(
        (item for item in operations.list_notifications(username, 200) if item["id"] == notification_id),
        None,
    )
    event_id = row.get("event_id") if isinstance(row, dict) else None
    if not isinstance(event_id, str):
        raise HTTPException(status_code=409, detail="notification has no event")
    found = await asyncio.to_thread(
        events_db.set_retention_class, settings.events_db_path, event_id, body.retention_class
    )
    if not found:
        raise HTTPException(status_code=404, detail="event not found")
    return {"event_id": event_id, "retention_class": body.retention_class}


@router.get("/saved-searches")
async def saved_searches(username: str = Depends(get_current_user)) -> dict[str, Any]:
    return {"v": 1, "items": await asyncio.to_thread(operations.list_saved_searches, username)}


@router.post("/saved-searches", status_code=status.HTTP_201_CREATED)
async def create_saved_search(body: SavedSearchBody, username: str = Depends(get_current_user)) -> dict[str, Any]:
    try:
        return await asyncio.to_thread(
            operations.save_search, username, body.name, body.query, body.semantic
        )
    except OverflowError:
        raise HTTPException(status_code=409, detail="saved-search limit reached")


@router.delete("/saved-searches/{search_id}")
async def delete_saved_search(search_id: str, username: str = Depends(get_current_user)) -> dict[str, bool]:
    if not await asyncio.to_thread(operations.delete_saved_search, username, search_id):
        raise HTTPException(status_code=404, detail="saved search not found")
    return {"deleted": True}


@router.get("/briefing")
async def briefing(
    day: Annotated[str, Query(pattern=r"^[0-9]{4}-[01][0-9]-[0-3][0-9]$")] = date.today().isoformat(),
) -> dict[str, Any]:
    return await asyncio.to_thread(operations.build_briefing, day)


@router.get("/health-history", dependencies=[Depends(require_role("owner"))])
async def health_history(hours: Annotated[int, Query(ge=1, le=168)] = 24) -> dict[str, Any]:
    return {"v": 1, "items": await asyncio.to_thread(operations.health_history, hours)}


@router.get("/retention", dependencies=[Depends(require_role("owner"))])
async def retention() -> dict[str, Any]:
    return await asyncio.to_thread(recording_service.retention_preview)


@router.put("/events/{event_id}/retention", dependencies=[Depends(require_role("owner"))])
async def set_event_retention(event_id: str, body: RetentionBody) -> dict[str, Any]:
    if _ID_RE.fullmatch(event_id) is None:
        raise HTTPException(status_code=404, detail="event not found")
    found = await asyncio.to_thread(
        events_db.set_retention_class, settings.events_db_path, event_id, body.retention_class
    )
    if not found:
        raise HTTPException(status_code=404, detail="event not found")
    return {"event_id": event_id, "retention_class": body.retention_class}


@router.put("/operations/archive", dependencies=[Depends(require_role("owner"))])
async def configure_archive(body: ArchiveBody) -> dict[str, Any]:
    row = await asyncio.to_thread(operations.set_archive_enabled, body.enabled)
    return {**row, **operations.archive_capability()}


@router.post("/operations/archive/sync", dependencies=[Depends(require_role("owner"))])
async def sync_archive() -> dict[str, Any]:
    try:
        return await asyncio.to_thread(operations.sync_archive)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=409, detail=str(exc))


@router.put("/operations/semantic-companion", dependencies=[Depends(require_role("owner"))])
async def configure_companion(body: CompanionBody) -> dict[str, Any]:
    try:
        return await asyncio.to_thread(
            operations.configure_companion, body.enabled, body.base_url, body.api_token
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))


@router.post("/semantic/search")
async def semantic_search(body: SemanticSearchBody, username: str = Depends(get_current_user)) -> dict[str, Any]:
    try:
        items = await asyncio.to_thread(
            operations.companion_search, username, body.query.strip(), body.limit
        )
    except OverflowError:
        raise HTTPException(status_code=429, detail="semantic-search rate limit reached")
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    except (OSError, ValueError, urllib.error.URLError):
        raise HTTPException(status_code=502, detail="semantic companion unavailable")
    return {"v": 1, "items": items, "mode": "companion"}
