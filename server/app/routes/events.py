from __future__ import annotations

import asyncio
import logging
import time
from urllib.parse import urlparse

import hashlib
import json

from fastapi import APIRouter, Depends, Query, Request, Response, WebSocket, WebSocketDisconnect

from ..auth import tokens, users_db
from ..auth.dependencies import get_current_user, require_role
from ..config import settings
from ..log import auth_rejected
from ..services.event_bus import SubscriberCapReached, event_bus
from ..sessions import revocation, sessions_db

router = APIRouter()
log = logging.getLogger(__name__)


def _origin_matches_host(origin: str | None, host: str | None) -> bool:
    """Same-origin check for the WS handshake (iter-168).

    The PWA always serves from the same origin as the API (single FastAPI
    process serves both `/api/*` and the static SPA bundle). A legitimate
    browser-issued WS handshake therefore has `Origin` == request's
    `Host` (modulo scheme). A malicious LAN page at `http://attacker
    .lan/` would carry `Origin: http://attacker.lan` and not match the
    server's `Host` header — that's the case we want to reject.

    Returns False when either header is missing. Browsers always send
    Origin on WS upgrades, and the WS endpoint has no non-browser
    consumer (the worker uses the REST `/api/_internal/*` endpoints,
    not the WS), so missing Origin is treated as suspicious.
    """
    if not origin or not host:
        return False
    try:
        netloc = urlparse(origin).netloc
    except (ValueError, TypeError):
        return False
    return bool(netloc) and netloc == host


@router.get("/events")
async def list_events(
    # Pydantic Query bounds: 1..1000 inclusive — preserves the
    # CLAUDE.md sharp edge `[1, 1000]`. Pydantic returns 422 for
    # both type errors (`?limit=abc`) and range errors
    # (`?limit=0`, `?limit=10000`) before the handler runs.
    limit: int = Query(default=100, ge=1, le=1000),
    # iter-184 (Auth Plan Phase 5): per-route gate so the WS
    # sibling `/events/ws` stays ungated until Phase 6 / iter-185.
    _user: str = Depends(get_current_user),
) -> list[dict]:
    # iter-316 (perf-auditor #4): wrap the sync sqlite-backed
    # `event_bus.recent` in asyncio.to_thread so it runs on the
    # FastAPI thread pool instead of blocking the asyncio event
    # loop. The other events_db routes (search, count_by_day,
    # mark_seen, etc.) were wrapped in iter-273 + iter-299; this
    # closes the last gap. Empirical benchmarks (iter-315) showed
    # p99 spikes on `/api/_internal/event` (72 ms) suggestive of
    # event-loop contention under concurrent reads.
    return await asyncio.to_thread(event_bus.recent, limit)


@router.get("/events/search")
async def search_events(
    # iter-219 (Feature #6 slice 4): cursor-paginated search.
    # All filters optional; the (camera_id, ts) and (person_name,
    # ts) iter-216 indexes back the common single-filter shapes.
    camera_id: str | None = Query(default=None, max_length=64),
    # docs/multicam_contract.md (2026-07-07): `camera=<id>` is the
    # contract-blessed spelling of the camera filter (what the client
    # sends). `camera_id` above predates the contract and stays for
    # back-compat; when both are sent, `camera` wins. Strict equality
    # against the stored camera_id — an unknown id simply matches
    # zero rows.
    camera: str | None = Query(default=None, max_length=64),
    person_name: str | None = Query(default=None, max_length=64),
    label: str | None = Query(default=None, max_length=64),
    since_ts: float | None = Query(default=None, ge=0),
    until_ts: float | None = Query(default=None, ge=0),
    # `before_ts` is the cursor passed back from the previous page's
    # `next_cursor`. Distinct from `until_ts` so pagination doesn't
    # collapse the user's selected time window between pages. Strict
    # `<` semantics (matches `events_db.recent`).
    before_ts: float | None = Query(default=None, ge=0),
    limit: int = Query(default=50, ge=1, le=1000),
    # iter-227 (Feature #6 polish): closes the iter-221 `__unknown__`
    # chip server-side gap. true → `person_name IS NULL` (no face
    # match); false → `person_name IS NOT NULL`; absent → no filter.
    # FastAPI converts `?face_unrecognized=true|false` to a bool
    # automatically; non-bool values 422 at parse time.
    face_unrecognized: bool | None = Query(default=None),
    # Owner / family / viewer all readable — events listing is
    # non-destructive (mirrors the existing /api/events gate).
    _user: str = Depends(get_current_user),
) -> dict:
    # Lazy import to dodge circular concerns at module import (same
    # shape as event_bus.recent's lazy import). Settings is import-
    # cheap; events_db only needs to be reached when a search hits.
    from ..services import events_db

    # Contract alias resolution — see the `camera` Query param above.
    effective_camera_id = camera if camera is not None else camera_id

    # iter-273 (perf-auditor #1 / Eli H#3): wrap the sync sqlite
    # call in asyncio.to_thread so it runs on the FastAPI thread
    # pool instead of blocking the asyncio event loop. SQLite read
    # is sub-ms on the Jetson eMMC (PRIMARY KEY + iter-216 indexes)
    # but every concurrent WS subscriber + heatmap refetch + unread
    # poll sums up — under load the loop serializes. Wrapping is a
    # one-line fix; the helpers stay sync (no aiosqlite migration
    # — flagged as anti-recommendation by the auditor because it
    # would re-introduce a connection-pool sharp edge).
    try:
        items = await asyncio.to_thread(
            events_db.search,
            settings.events_db_path,
            camera_id=effective_camera_id,
            person_name=person_name,
            label=label,
            since_ts=since_ts,
            until_ts=until_ts,
            before_ts=before_ts,
            limit=limit,
            face_unrecognized=face_unrecognized,
        )
    except Exception:
        # iter-logging: a swallowed DB read here surfaces to the client
        # as a bare 500 with no journal trail. Log the operation + every
        # filter param at exception level (with the stack) so a locked /
        # corrupt events.db is diagnosable, then re-raise so the route
        # still 500s (behaviour unchanged). NEVER log token/cookie bytes.
        log.exception(
            "events_db.search failed on %s: "
            "camera_id=%r person_name=%r label=%r since_ts=%r "
            "until_ts=%r before_ts=%r limit=%r face_unrecognized=%r",
            settings.events_db_path,
            effective_camera_id,
            person_name,
            label,
            since_ts,
            until_ts,
            before_ts,
            limit,
            face_unrecognized,
        )
        raise
    # next_cursor convention: only set when this page is full
    # (len == limit) so the client can stop paginating cleanly on
    # the last page. Cursor value = oldest item's ts on this page,
    # to be passed as `before_ts` for the next page.
    next_cursor: float | None = None
    if len(items) == limit and items:
        next_cursor = items[-1]["ts"]
    return {"items": items, "next_cursor": next_cursor}


@router.get("/events/count_by_day")
async def events_count_by_day(
    request: Request,
    response: Response,
    # iter-222 (Feature #6 slice 7b-server): per-day event counts
    # for the iter-223 client calendar heatmap. Same filter set
    # + same auth gate as `/api/events/search`.
    camera_id: str | None = Query(default=None, max_length=64),
    person_name: str | None = Query(default=None, max_length=64),
    label: str | None = Query(default=None, max_length=64),
    since_ts: float | None = Query(default=None, ge=0),
    until_ts: float | None = Query(default=None, ge=0),
    # iter-227: same `face_unrecognized` flag as /events/search.
    face_unrecognized: bool | None = Query(default=None),
    _user: str = Depends(get_current_user),
):
    # iter-240 (Feature #6 polish, iter-235 Section 5 lever): ETag/304
    # caching. Hash the response body; echo as ETag header. Browser
    # HTTP cache automatically sends If-None-Match on next request to
    # the same URL — server returns 304 (no body) when nothing
    # changed. Saves the JSON parse on the client side, which is
    # noticeable on the iter-223 heatmap when iter-226's visibility-
    # resume refetches a tab that's been idle for hours but the
    # underlying counts didn't shift.
    #
    # Implementation note: the 5-tuple ETag input (filter params +
    # response body hash) doesn't double-hash anything — the body
    # itself is a function of the filter params + events_db state,
    # so hashing the body alone is sufficient. md5 chosen for speed
    # (not security); collision probability over the small response
    # space is negligible.
    from ..services import events_db

    # iter-273: same to_thread wrap as /events/search above. Heatmap
    # refetches on visibility-resume can re-issue this 30 d×N query
    # on every tab focus — keep it off the asyncio loop.
    try:
        counts = await asyncio.to_thread(
            events_db.count_by_day,
            settings.events_db_path,
            camera_id=camera_id,
            person_name=person_name,
            label=label,
            since_ts=since_ts,
            until_ts=until_ts,
            face_unrecognized=face_unrecognized,
        )
    except Exception:
        # iter-logging: same DB-read wrap as /events/search — log op +
        # filter params + stack, then re-raise (route still 500s).
        log.exception(
            "events_db.count_by_day failed on %s: "
            "camera_id=%r person_name=%r label=%r since_ts=%r "
            "until_ts=%r face_unrecognized=%r",
            settings.events_db_path,
            camera_id,
            person_name,
            label,
            since_ts,
            until_ts,
            face_unrecognized,
        )
        raise
    body = {"counts": counts}
    body_json = json.dumps(body, sort_keys=True, separators=(",", ":"))
    etag = '"' + hashlib.md5(body_json.encode("utf-8")).hexdigest() + '"'

    if request.headers.get("if-none-match") == etag:
        # Bandwidth + parse-time win: empty body, server still
        # echoes the ETag for clarity (some clients refresh their
        # cached entry on 304).
        return Response(status_code=304, headers={"ETag": etag})
    response.headers["ETag"] = etag
    return body


@router.get("/events/unread_count")
async def events_unread_count(
    # iter-248: powers the home-screen app-icon badge and the
    # eventual ongoing-notification badge. Cheap query backed by the
    # `events_unseen_ts` partial index — sub-ms on millions of rows.
    # Auth-gated like the rest of /api/events; the client polls on
    # mount + after each WS event arrival.
    _user: str = Depends(get_current_user),
) -> dict:
    from ..services import events_db

    # iter-273: to_thread wrap. The client polls this on mount AND
    # after every WS event arrival, so it runs MORE frequently than
    # search/count_by_day. Cheap query (partial-indexed COUNT) but
    # keep the loop free regardless.
    count = await asyncio.to_thread(
        events_db.unread_count, settings.events_db_path
    )
    return {"count": count}


# iter-248: per-event mark-seen path parameter accepts the same
# strict charset as the iter-201 clip route (`[A-Za-z0-9_-]+`).
# Keeps malformed ids out at parameter parsing time (FastAPI 422).
_EVENT_ID_PATTERN = r"^[A-Za-z0-9_-]+$"


@router.post("/events/{event_id}/seen")
async def events_mark_seen(
    event_id: str,
    _user: str = Depends(get_current_user),
) -> dict:
    import re

    if not re.match(_EVENT_ID_PATTERN, event_id):
        from fastapi import HTTPException

        # iter-logging: a malformed event id on mark-seen means the
        # client (or worker) minted an id outside the shared charset —
        # an id-drift bug worth a WARNING, not a silent 422. Log the
        # rejected id so the drift source is greppable.
        log.warning(
            "events_mark_seen 422: malformed event_id=%r (client/worker "
            "id drift)",
            event_id,
        )
        raise HTTPException(status_code=422, detail="invalid event id")
    from ..services import events_db

    # iter-273: to_thread wrap on the sqlite UPDATE.
    flipped = await asyncio.to_thread(
        events_db.mark_seen, settings.events_db_path, event_id
    )
    return {"flipped": flipped}


@router.post("/events/seen_all")
async def events_mark_all_seen(
    _user: str = Depends(get_current_user),
) -> dict:
    from ..services import events_db

    # iter-273: to_thread wrap on the sqlite-wide UPDATE. This is
    # the most expensive of the events_db helpers (touches every
    # unseen row), so it benefits the most from being off-loop.
    n = await asyncio.to_thread(
        events_db.mark_all_seen, settings.events_db_path
    )
    return {"flipped": n}


_DAY_PATTERN = r"^[0-9]{4}-[01][0-9]-[0-3][0-9]$"


@router.delete(
    "/events/{event_id}",
)
async def events_delete_one(
    event_id: str,
    # iter-logging: take the resolved owner so the destructive delete
    # can be audited with an actor. `require_role` returns the username
    # (the `sub` claim) — already in the DB, safe to log.
    actor: str = Depends(require_role("owner")),
) -> dict:
    """iter-299 (user "be able to delete events manually with a
    confirmation"): owner-only single-event delete. Confirm dialog
    is client-side; the server is the destructive boundary.

    Returns `{"deleted": true|false}` so the UI can disambiguate
    "row gone" from "row never existed" without a 404 (which would
    redirect the iter-184 auth-error toast UX).
    """
    import re

    if not re.match(_EVENT_ID_PATTERN, event_id):
        from fastapi import HTTPException

        log.warning(
            "events_delete_one 422: malformed event_id=%r (client/worker "
            "id drift) actor=%r",
            event_id,
            actor,
        )
        raise HTTPException(status_code=422, detail="invalid event id")
    from ..services import events_db

    try:
        deleted = await asyncio.to_thread(
            events_db.delete, settings.events_db_path, event_id
        )
    except Exception:
        # iter-logging: destructive owner-only op with no audit today —
        # a swallowed DB error here loses the operator's delete intent
        # with no trail. Log op + actor + target id + stack, re-raise.
        log.exception(
            "events_db.delete failed on %s: event_id=%r actor=%r",
            settings.events_db_path,
            event_id,
            actor,
        )
        raise
    # iter-logging: INFO audit for the destructive boundary — who
    # deleted what, and whether a row actually went away.
    log.info(
        "event deleted: event_id=%r deleted=%s actor=%r",
        event_id,
        deleted,
        actor,
    )
    return {"deleted": deleted}


@router.delete(
    "/events",
)
async def events_delete_by_day(
    day: str = Query(
        ...,
        pattern=_DAY_PATTERN,
        description="YYYY-MM-DD (server-local-time bucketing)",
    ),
    # iter-logging: resolved owner for the destructive bulk-delete audit.
    actor: str = Depends(require_role("owner")),
) -> dict:
    """iter-299 (user "delete all events for a day"): owner-only
    bulk delete. The `day` Query parameter is required + regex-
    validated. Day bucketing matches `count_by_day` so the UI's
    "Delete all N events for May 2" matches the heatmap count.

    Returns `{"deleted": N}` so the UI can toast "Removed N events".
    """
    from ..services import events_db

    try:
        n = await asyncio.to_thread(
            events_db.delete_by_day, settings.events_db_path, day
        )
    except Exception:
        # iter-logging: destructive owner-only bulk delete with no audit
        # today. Log op + actor + day + stack, re-raise so the route
        # still 500s.
        log.exception(
            "events_db.delete_by_day failed on %s: day=%r actor=%r",
            settings.events_db_path,
            day,
            actor,
        )
        raise
    # iter-logging: INFO audit — actor + day + how many rows were removed.
    log.info(
        "events deleted by day: day=%r deleted=%s actor=%r",
        day,
        n,
        actor,
    )
    return {"deleted": n}


@router.get("/people")
async def list_people(
    request: Request,
    response: Response,
    # iter-328 (R2): limit query param + bounded range. Without this
    # the iter-326 hard-coded 100 silently truncated the list at
    # N=101 enrolled people with no client signal. Mirrors the
    # iter-? `/api/events?limit` Annotated bound (1..1000); this
    # one is tighter (max 500) since the People list is meant for
    # human scanning, not bulk export.
    limit: int = Query(default=100, ge=1, le=500),
    _user: str = Depends(get_current_user),
):
    """iter-326 (missing-feature #5): per-person aggregation page —
    the "Familiar Faces" log Nest pioneered. Counts visits per
    enrolled face, surfaces last-seen + first-seen timestamps + the
    last clip/thumb URL for a one-tap "show their most recent visit"
    affordance.

    Auth-gated like the rest of /api/events. Owner / family / viewer
    all readable — non-destructive aggregation. Returns the same
    `name` strings that show up in event chips, so the client can
    deep-link from a person row to a filtered Events search.

    iter-327 (perf E1): ETag/304 caching mirrors the iter-240
    `count_by_day` pattern. People data only mutates when a NEW
    face is recognized (or an event with person_name is deleted),
    so the cache hit-rate on repeat visits is near 100%. Saves the
    server-side SQLite query + the body transfer + the client JSON
    parse on every visibility-resume / nav-back to /people.

    iter-328 (R2): response now carries `total` (count of distinct
    recognized person_names DB-wide, regardless of `limit`) so the
    client can render "Showing N of M" when an operator has more
    enrolled faces than fit in the page. ETag includes both `items`
    and `total`, so adding a new person OR changing the visible
    page rotates the cache entry.
    """
    from ..services import events_db
    # iter-333b (perf C1): parallelize the two SQLite queries via
    # asyncio.gather so the wall-clock cost is max(T_summary, T_total)
    # instead of T_summary + T_total. On the Nano's class-10 SD card
    # each connection open is ~0.5-1 ms; saves one connect/close
    # cycle per cache-miss request.
    try:
        items, total = await asyncio.gather(
            asyncio.to_thread(
                events_db.people_summary, settings.events_db_path, limit=limit,
            ),
            asyncio.to_thread(
                events_db.people_total, settings.events_db_path,
            ),
        )
    except Exception:
        # iter-logging: people_summary leans on a window function
        # (SQLite >= 3.25) — a silent landmine on an older eMMC build.
        # Log the op + db path + limit at exception level, re-raise so
        # the route still 500s.
        log.exception(
            "events_db.people_summary/people_total failed on %s: limit=%r",
            settings.events_db_path,
            limit,
        )
        raise
    body = {"items": items, "total": total}
    body_json = json.dumps(body, sort_keys=True, separators=(",", ":"))
    etag = '"' + hashlib.md5(body_json.encode("utf-8")).hexdigest() + '"'

    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers={"ETag": etag})
    response.headers["ETag"] = etag
    return body


@router.websocket("/events/ws")
async def events_ws(ws: WebSocket) -> None:
    # Accept first so real browsers can observe policy close codes. With
    # uvicorn, a pre-accept close becomes an HTTP 403 handshake rejection
    # and browser JS only sees abnormal close 1006.
    await ws.accept()
    # iter-168: same-origin gate on the WS handshake. Pre-iter-168 the
    # WS upgrade was the only `/api/*` surface that didn't go through
    # ANY validation — and it streams the most sensitive data on the
    # bus (live person identifications, bbox geometry, thumb URLs). A
    # malicious LAN page (compromised IoT device, guest Wi-Fi co-
    # resident) could `new WebSocket("ws://jetson:8000/api/events/ws")`
    # and skim every detection event in real time. Closing on origin
    # mismatch with code 1008 (Policy Violation) gives the iter-158
    # client reconnect logic a clean failure-mode signal — banner
    # stays "Realtime disconnected", no spurious reconnect storms.
    origin = ws.headers.get("origin")
    host = ws.headers.get("host")
    if not _origin_matches_host(origin, host):
        # iter-logging: split the two distinct rejection causes. A
        # present-but-mismatched Origin is a cross-origin probe (a
        # malicious LAN page) — security-relevant, WARNING. A missing
        # Origin is benign-suspicious (a non-browser tool, or a stripped
        # header) — INFO. Splitting lets an operator tell a real attack
        # apart from a misconfigured proxy at a glance.
        if origin:
            log.warning(
                "ws rejected: origin=%r does not match host=%r "
                "(cross-origin)",
                origin,
                host,
            )
        else:
            log.info(
                "ws rejected: missing Origin header (host=%r)",
                host,
            )
        await ws.close(code=1008, reason="origin mismatch")
        return
    # iter-185 (Auth Plan Phase 6): cookie precondition. Auth failures
    # close with 1008 (Policy Violation, same code as the origin gate)
    # so the iter-182 client side's no-auto-retry treatment applies.
    # The client's AuthProvider listens for `homecam:auth-failed`
    # events dispatched on 1008 close to drop session state.
    # iter-logging: all four auth branches log at WARNING (today they
    # were silent while the origin gate above logged — an asymmetry that
    # hid every WS auth rejection). Tailnet exposure makes auth-rejection
    # a security signal. NEVER log the token / cookie bytes — only the
    # reason token, the `sub` username (where decoded), and a
    # cookie-present bool so "no session" vs "bad session" is clear.
    access_token = ws.cookies.get("homecam_access")
    if not access_token:
        auth_rejected(
            log, "WS", "/api/events/ws", "no cookie", cookie_present=False
        )
        await ws.close(code=1008, reason="auth required")
        return
    try:
        claims = tokens.decode(access_token, kind="access")
    except tokens.InvalidToken:
        # Covers expired / bad-signature / malformed AND the load-bearing
        # kind-mismatch re-check (a refresh token in the access slot).
        auth_rejected(
            log,
            "WS",
            "/api/events/ws",
            "invalid or kind-mismatched token",
            cookie_present=True,
        )
        await ws.close(code=1008, reason="auth required")
        return
    sub = claims.get("sub")
    if not isinstance(sub, str) or not sub:
        auth_rejected(
            log,
            "WS",
            "/api/events/ws",
            "malformed sub claim",
            sub=sub,
            cookie_present=True,
        )
        await ws.close(code=1008, reason="auth required")
        return
    # User-row lookup: refuses to revive a session whose user was
    # deleted while the access token was still TTL-valid. Symmetric
    # with the REST `/api/auth/me` and `/api/auth/refresh` handlers
    # (iter-181). One sqlite query (~0.5 ms on the Jetson eMMC) at
    # connect time — the WS doesn't re-check during stream lifetime,
    # so the upper bound on staleness is the access TTL (15 min).
    user = users_db.get_user(settings.users_db_path, sub)
    if user is None:
        # Token was TTL-valid but the user row is gone (deleted while the
        # access token was still live) — a security-relevant event.
        auth_rejected(
            log,
            "WS",
            "/api/events/ws",
            "user row gone",
            sub=sub,
            cookie_present=True,
        )
        await ws.close(code=1008, reason="auth required")
        return
    jti = claims.get("jti")
    if isinstance(jti, str) and jti:
        now = time.time()
        try:
            session_row = sessions_db.get_session(settings.sessions_db_path, jti)
        except Exception:
            log.warning(
                "ws session lookup failed for sub=%r jti=%r; allowing valid "
                "signed token because only explicit revoked_ts fails closed",
                sub,
                jti,
                exc_info=True,
            )
            session_row = None
        if session_row is not None and revocation.is_revoked(
            jti,
            session_row.get("revoked_ts"),
            now,
        ):
            auth_rejected(
                log,
                "WS",
                "/api/events/ws",
                "session revoked",
                sub=sub,
                cookie_present=True,
            )
            await ws.close(code=1008, reason="session revoked")
            return
        if session_row is not None and revocation.should_write_last_seen(
            float(session_row.get("last_seen_ts", 0.0)),
            now,
            revocation.DEFAULT_LAST_SEEN_THROTTLE_S,
        ):
            try:
                sessions_db.touch_last_seen(settings.sessions_db_path, jti, now)
            except Exception:
                log.warning(
                    "ws last_seen write failed for sub=%r jti=%r; continuing",
                    sub,
                    jti,
                    exc_info=True,
                )
    # iter-263 (security-auditor F1): bus-level subscriber cap. Close
    # code 1013 (Try Again Later) tells the iter-158 client reconnect
    # logic to back off — distinct from the 1008 policy-violation
    # closes that signal a configuration / auth problem.
    # iter-logging: identify the connecting client (the authed `sub` +
    # the request client host) so a capacity rejection / stream crash is
    # attributable. `client` is the (host, port) starlette Address or
    # None behind some proxies.
    client = ws.client.host if ws.client else None
    try:
        queue = event_bus.subscribe(
            jti=jti if isinstance(jti, str) and jti else None,
            username=sub,
        )
    except SubscriberCapReached as exc:
        # iter-logging: name the count/cap (carried in the exception
        # message as "(N/MAX)") + who got turned away so an operator can
        # tell a real subscriber leak from a momentary burst.
        log.warning(
            "ws rejected: bus at capacity (%s) sub=%r client=%s",
            exc,
            sub,
            client,
        )
        await ws.close(code=1013, reason="server at capacity")
        return
    try:
        while True:
            evt = await queue.get()
            await ws.send_json(evt)
    except WebSocketDisconnect:
        pass
    except asyncio.CancelledError:
        # iter-176: explicit re-raise. Since 3.8 `CancelledError`
        # subclasses `BaseException` (not `Exception`), so the broad
        # `except Exception` below already wouldn't catch it — but
        # making the contract explicit defends against (a) a future
        # broad-except-everything refactor, and (b) anyone reading
        # the file wondering "what happens on shutdown?". Charter
        # Section 2 Backend bar: "`except CancelledError: raise;
        # except Exception: log + recover`."
        raise
    except Exception:
        # iter-logging: attribute the crash to a subscriber + client so a
        # repeated stream-loop fault is traceable to one device.
        log.exception(
            "events websocket crashed: sub=%r client=%s", sub, client
        )
    finally:
        event_bus.unsubscribe(queue)
