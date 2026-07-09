from __future__ import annotations

import logging
import time
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field

from ..auth.dependencies import get_current_user, require_role
from ..config import settings
from ..services import audit_db


router = APIRouter(tags=["telemetry"])
log = logging.getLogger(__name__)

_TELEMETRY_WINDOW_S = 10.0
_TELEMETRY_MAX_PER_WINDOW = 50
_telemetry_bucket: dict[str, float | int] = {"ts": 0.0, "count": 0}


class ViewIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    v: Literal[1]
    kind: Literal["page", "event"]
    name: str = Field(min_length=1, max_length=128)
    dwell_ms: int = Field(ge=0, le=86_400_000)
    ts: float


def _rate_limited() -> bool:
    now = time.monotonic()
    if now - float(_telemetry_bucket["ts"]) >= _TELEMETRY_WINDOW_S:
        _telemetry_bucket["ts"] = now
        _telemetry_bucket["count"] = 0
    _telemetry_bucket["count"] = int(_telemetry_bucket["count"]) + 1
    if int(_telemetry_bucket["count"]) > _TELEMETRY_MAX_PER_WINDOW:
        if int(_telemetry_bucket["count"]) == _TELEMETRY_MAX_PER_WINDOW + 1:
            log.warning(
                "telemetry view rate cap hit (%d/%.0fs) — dropping further "
                "view telemetry this window",
                _TELEMETRY_MAX_PER_WINDOW,
                _TELEMETRY_WINDOW_S,
            )
        return True
    return False


@router.post("/telemetry/view")
async def view(body: ViewIn, username: str = Depends(get_current_user)) -> dict:
    if _rate_limited():
        return {"ok": False, "dropped": "rate"}
    audit_db.insert_view_event(
        settings.audit_db_path,
        ts=body.ts,
        username=username,
        kind=body.kind,
        name=body.name,
        dwell_ms=body.dwell_ms,
    )
    return {"ok": True}


def _summary(
    auth_events: list[audit_db.AuthEvent],
    view_events: list[audit_db.ViewEvent],
) -> dict:
    by_user: dict[str, dict] = {}
    top_totals: dict[str, dict[str, int]] = {}

    def user_row(username: str) -> dict:
        if username not in by_user:
            by_user[username] = {
                "logins": 0,
                "page_dwell_ms": 0,
                "event_views": 0,
                "top": [],
            }
        return by_user[username]

    for event in auth_events:
        row = user_row(event["username"])
        if event["action"] == "login_ok":
            row["logins"] += 1

    for event in view_events:
        row = user_row(event["username"])
        if event["kind"] == "page":
            row["page_dwell_ms"] += event["dwell_ms"]
            top_totals.setdefault(event["username"], {})
            top_totals[event["username"]][event["name"]] = (
                top_totals[event["username"]].get(event["name"], 0)
                + event["dwell_ms"]
            )
        else:
            row["event_views"] += 1

    for username, totals in top_totals.items():
        by_user[username]["top"] = sorted(
            totals.items(),
            key=lambda item: (-item[1], item[0]),
        )[:10]
    return {"by_user": by_user}


@router.get("/admin/audit")
async def admin_audit(
    since: float | None = Query(default=None),
    until: float | None = Query(default=None),
    username: str = Depends(require_role("owner")),
) -> dict:
    # This route is the operator surveillance view, not a general owner
    # capability. Keep it pinned to the literal break-glass account so
    # delegated owner users cannot inspect household browsing behavior.
    if username != "admin":
        raise HTTPException(status_code=403, detail="admin audit account required")
    now = time.time()
    end = until if until is not None else now
    start = since if since is not None else end - 7 * 24 * 60 * 60
    logins = audit_db.auth_events_between(
        settings.audit_db_path,
        since=start,
        until=end,
        limit=5000,
    )
    views = audit_db.view_events_between(
        settings.audit_db_path,
        since=start,
        until=end,
        limit=5000,
    )
    return {
        "v": 1,
        "logins": logins,
        "views": views,
        "summary": _summary(logins, views),
    }
