from __future__ import annotations

import logging
import re
import time
from typing import Any, Literal

from fastapi import APIRouter, Cookie, Depends, HTTPException, Query, Request
from pydantic import BaseModel, ConfigDict, Field

from ..auth import tokens
from ..auth.dependencies import COOKIE_ACCESS, get_current_user, require_role
from ..config import settings
from ..services import audit_db, mediamtx_auth, whep_probe_status
from ..sessions import sessions_db


router = APIRouter(tags=["telemetry"])
log = logging.getLogger(__name__)

_TELEMETRY_WINDOW_S = 10.0
_TELEMETRY_MAX_PER_WINDOW = 50
_USAGE_SESSION_GAP_S = 30 * 60
_GOD_VIEW_USERS = {"admin", "israel"}
_telemetry_bucket: dict[str, float | int] = {"ts": 0.0, "count": 0}


class ViewIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    v: Literal[1]
    kind: Literal["page", "event", "action"]
    name: str = Field(min_length=1, max_length=128)
    dwell_ms: int = Field(ge=0, le=86_400_000)
    ts: float


class WhepProbeIn(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    v: Literal[1]
    rung: str = Field(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9_-]+$")
    result: Literal["first_frame", "signaling_failure", "no_media", "transport_failure"]
    network_type: Literal["cellular", "wifi", "ethernet", "unknown"]
    ttff_ms: float = Field(default=0.0, ge=0.0, le=60_000.0)
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


def _stable_session_id(access_cookie: str | None, username: str) -> str | None:
    if not access_cookie:
        return None
    try:
        claims = tokens.decode(access_cookie, kind="access")
    except tokens.InvalidToken:
        return None
    jti = claims.get("jti")
    if not isinstance(jti, str) or not jti:
        return None
    try:
        row = sessions_db.get_session(settings.sessions_db_path, jti)
    except Exception:
        log.warning("telemetry session lookup failed", exc_info=True)
        return None
    if row is None or row.get("username") != username:
        return None
    session_id = row.get("session_id")
    return str(session_id) if session_id else jti


def record_successful_action(request: Request) -> None:
    """Persist a successful user-initiated API mutation without its body.

    This runs after routing/auth has accepted the request. Only method and a
    redacted route shape are stored; credentials, request payloads, share
    tokens and media never enter the audit database.
    """
    method = request.method.upper()
    path = request.url.path
    if method not in {"POST", "PUT", "PATCH", "DELETE"}:
        return
    if path.startswith(
        ("/api/auth/", "/api/telemetry/", "/api/_internal/", "/api/client-log")
    ):
        return
    access_cookie = request.cookies.get(COOKIE_ACCESS)
    if not access_cookie:
        return
    try:
        claims = tokens.decode(access_cookie, kind="access")
    except tokens.InvalidToken:
        return
    username = claims.get("sub")
    if not isinstance(username, str) or not username:
        return
    safe_path = re.sub(r"/[A-Za-z0-9_-]{16,}(?=/|$)", "/:id", path)
    safe_path = re.sub(r"/[0-9]{6,}(?=/|$)", "/:id", safe_path)
    try:
        audit_db.insert_action_event(
            settings.audit_db_path,
            ts=time.time(),
            username=username,
            session_id=_stable_session_id(access_cookie, username),
            name="{} {}".format(method, safe_path)[:128],
        )
    except Exception:
        log.warning("successful action audit write failed", exc_info=True)


@router.post("/telemetry/view")
async def view(
    body: ViewIn,
    username: str = Depends(get_current_user),
    homecam_access: str | None = Cookie(default=None, alias=COOKIE_ACCESS),
) -> dict:
    if _rate_limited():
        return {"ok": False, "dropped": "rate"}
    session_id = _stable_session_id(homecam_access, username)
    if body.kind == "action":
        audit_db.insert_action_event(
            settings.audit_db_path,
            ts=body.ts,
            username=username,
            session_id=session_id,
            name=body.name,
        )
    else:
        audit_db.insert_view_event(
            settings.audit_db_path,
            ts=body.ts,
            username=username,
            session_id=session_id,
            kind=body.kind,
            name=body.name,
            dwell_ms=body.dwell_ms,
        )
    return {"ok": True}


@router.post("/telemetry/whep-probe")
async def whep_probe(
    body: WhepProbeIn,
    _username: str = Depends(get_current_user),
) -> dict:
    if _rate_limited():
        return {"ok": False, "dropped": "rate"}
    if body.rung not in mediamtx_auth.video_paths():
        raise HTTPException(status_code=422, detail="unsupported probe rung")
    # Only a browser that can positively identify a cellular interface is an
    # external cellular observer. Unknown/Wi-Fi reports never affect alerts.
    if body.network_type == "cellular":
        whep_probe_status.record(body.rung, body.result, body.ts, body.ttff_ms)
    return {"ok": True}


def _summary(
    auth_events: list[audit_db.AuthEvent],
    view_events: list[audit_db.ViewEvent],
    action_events: list[audit_db.ActionEvent] | None = None,
) -> dict:
    by_user: dict[str, dict] = {}
    top_totals: dict[str, dict[str, int]] = {}

    def user_row(username: str) -> dict:
        if username not in by_user:
            by_user[username] = {
                "logins": 0,
                "page_dwell_ms": 0,
                "event_views": 0,
                "actions": 0,
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
    for event in action_events or []:
        user_row(event["username"])["actions"] += 1
    return {"by_user": by_user}


def _usage_sessions(
    view_events: list[audit_db.ViewEvent],
    action_events: list[audit_db.ActionEvent],
    session_rows: list[dict],
) -> list[dict[str, Any]]:
    metadata = {
        str(row.get("session_id") or row["jti"]): row for row in session_rows
    }
    grouped: dict[str, dict[str, Any]] = {}
    active_group: dict[str, tuple[str, float]] = {}

    def group(
        username: str,
        session_id: str | None,
        activity_start: float,
        activity_end: float,
    ) -> dict[str, Any]:
        base = session_id or "legacy:{}".format(username.casefold())
        current = active_group.get(base)
        if current is None or activity_start - current[1] > _USAGE_SESSION_GAP_S:
            key = "{}:{}".format(base, int(activity_start))
        else:
            key = current[0]
        active_group[base] = (key, max(activity_end, current[1] if current and current[0] == key else 0.0))
        if key not in grouped:
            meta = metadata.get(base, {})
            grouped[key] = {
                "id": key,
                "username": username,
                "device_label": str(meta.get("device_label") or "Legacy or unknown device"),
                "ip_class": str(meta.get("ip_class") or "other"),
                "started_ts": activity_start,
                "last_activity_ts": activity_end,
                "screen_time_ms": 0,
                "page_view_count": 0,
                "event_view_count": 0,
                "action_count": 0,
                "legacy": session_id is None,
                "pages": {},
                "events": {},
                "actions": {},
                "timeline": [],
            }
        return grouped[key]

    activity = [
        (float(event["ts"]), "view", event) for event in view_events
    ] + [
        (float(event["ts"]), "action", event) for event in action_events
    ]
    for ts, activity_kind, event in sorted(
        activity, key=lambda item: (item[0], item[1], item[2]["name"])
    ):
        dwell = max(0, int(event.get("dwell_ms", 0)))
        activity_start = max(0.0, ts - dwell / 1000.0)
        row = group(
            event["username"], event.get("session_id"), activity_start, ts
        )
        row["started_ts"] = min(row["started_ts"], activity_start)
        row["last_activity_ts"] = max(row["last_activity_ts"], ts)
        if activity_kind == "action":
            bucket = row["actions"].setdefault(
                event["name"], {"name": event["name"], "count": 0}
            )
            bucket["count"] += 1
            row["action_count"] += 1
            timeline_kind = "action"
        else:
            timeline_kind = event["kind"]
            bucket_name = "pages" if event["kind"] == "page" else "events"
            bucket = row[bucket_name].setdefault(
                event["name"],
                {"name": event["name"], "dwell_ms": 0, "views": 0},
            )
            bucket["dwell_ms"] += dwell
            bucket["views"] += 1
            if event["kind"] == "page":
                row["screen_time_ms"] += dwell
                row["page_view_count"] += 1
            else:
                row["event_view_count"] += 1
        row["timeline"].append({
            "ts": ts,
            "kind": timeline_kind,
            "name": event["name"],
            "dwell_ms": dwell,
        })

    result = []
    for row in grouped.values():
        row["pages"] = sorted(
            row["pages"].values(), key=lambda item: (-item["dwell_ms"], item["name"])
        )
        row["events"] = sorted(
            row["events"].values(), key=lambda item: (-item["dwell_ms"], item["name"])
        )
        row["actions"] = sorted(
            row["actions"].values(), key=lambda item: (-item["count"], item["name"])
        )
        row["timeline"] = sorted(
            row["timeline"], key=lambda item: (-item["ts"], item["kind"], item["name"])
        )[:100]
        result.append(row)
    return sorted(result, key=lambda row: (-row["last_activity_ts"], row["id"]))


@router.get("/admin/audit")
async def admin_audit(
    since: float | None = Query(default=None),
    until: float | None = Query(default=None),
    username: str = Depends(require_role("owner")),
) -> dict:
    # God View exposes household-wide app usage. It is deliberately narrower
    # than ordinary owner capabilities: only the two operator accounts named
    # by product policy may read it. The client mirrors this visibility gate,
    # but the server remains authoritative for direct/deep-link requests.
    if username.casefold() not in _GOD_VIEW_USERS:
        raise HTTPException(status_code=403, detail="God View account required")
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
    actions = audit_db.action_events_between(
        settings.audit_db_path,
        since=start,
        until=end,
        limit=5000,
    )
    session_rows = sessions_db.list_sessions(
        settings.sessions_db_path,
        include_revoked=True,
        now=now,
    )
    return {
        "v": 2,
        "logins": logins,
        "views": views,
        "actions": actions,
        "sessions": _usage_sessions(views, actions, session_rows),
        "summary": _summary(logins, views, actions),
    }
