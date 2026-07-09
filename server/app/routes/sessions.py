from __future__ import annotations

import logging
import time

from fastapi import APIRouter, Cookie, Depends, HTTPException, Path, Request
from pydantic import BaseModel, ConfigDict

from ..auth import tokens
from ..auth.dependencies import COOKIE_ACCESS, require_role
from ..config import settings
from ..services import audit_db
from ..services.event_bus import event_bus
from ..sessions import sessions_db


log = logging.getLogger(__name__)
router = APIRouter(prefix="/admin/sessions", tags=["sessions"])
WATCHING_WINDOW_S = 30.0


class AdminSessionOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    jti: str
    username: str
    device_label: str
    ip_class: str
    created_ts: float
    last_seen_ts: float
    is_current: bool
    watching_now: bool
    revoked: bool


class AdminSessionsOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    v: int
    sessions: list[AdminSessionOut]


def _ua(request: Request) -> str:
    return (request.headers.get("user-agent") or "")[:256]


def _current_jti(homecam_access: str | None) -> str | None:
    if not homecam_access:
        return None
    try:
        claims = tokens.decode(homecam_access, kind="access")
    except tokens.InvalidToken:
        return None
    jti = claims.get("jti")
    return jti if isinstance(jti, str) and jti else None


@router.get("", response_model=AdminSessionsOut)
async def admin_list_sessions(
    _owner: str = Depends(require_role("owner")),
    homecam_access: str | None = Cookie(default=None),
) -> AdminSessionsOut:
    now = time.time()
    try:
        rows = sessions_db.list_sessions(
            settings.sessions_db_path,
            include_revoked=True,
            now=now,
        )
    except Exception:
        log.error(
            "admin_list_sessions: list_sessions failed on %s",
            settings.sessions_db_path,
            exc_info=True,
        )
        raise
    current_jti = _current_jti(homecam_access)
    watcher_jtis = {
        w["jti"]
        for w in event_bus.active_watchers()
        if isinstance(w.get("jti"), str) and w.get("jti")
    }
    return AdminSessionsOut(
        v=1,
        sessions=[
            AdminSessionOut(
                jti=str(row["jti"]),
                username=str(row["username"]),
                device_label=str(row["device_label"]),
                ip_class=str(row["ip_class"]),
                created_ts=float(row["created_ts"]),
                last_seen_ts=float(row["last_seen_ts"]),
                is_current=row["jti"] == current_jti,
                watching_now=(
                    row["jti"] in watcher_jtis
                    or now - float(row["last_seen_ts"]) < WATCHING_WINDOW_S
                ),
                revoked=row.get("revoked_ts") is not None,
            )
            for row in rows
        ],
    )


@router.post("/{jti}/revoke")
async def admin_revoke_session(
    request: Request,
    jti: str = Path(pattern=r"^[A-Za-z0-9]+$", max_length=64),
    caller: str = Depends(require_role("owner")),
) -> dict:
    now = time.time()
    try:
        target = sessions_db.get_session(settings.sessions_db_path, jti)
        if target is None:
            log.warning(
                "session revoke: caller=%r targeted unknown jti=%r (404)",
                caller,
                jti,
            )
            raise HTTPException(status_code=404, detail="no such session")
        revoked = sessions_db.revoke_by_jti(settings.sessions_db_path, jti, now)
    except HTTPException:
        raise
    except Exception:
        log.error(
            "session revoke: caller=%r failed for jti=%r",
            caller,
            jti,
            exc_info=True,
        )
        raise
    if not revoked:
        raise HTTPException(status_code=404, detail="no such session")
    try:
        audit_db.insert_auth_event(
            settings.audit_db_path,
            ts=now,
            username=str(target["username"]),
            action="logout",
            ua=_ua(request),
        )
    except Exception:
        log.warning(
            "session revoke audit write failed: caller=%r jti=%r user=%r",
            caller,
            jti,
            target["username"],
            exc_info=True,
        )
    log.warning(
        "session revoke: caller=%r revoked jti=%r (user=%r)",
        caller,
        jti,
        target["username"],
    )
    return {"ok": True}
