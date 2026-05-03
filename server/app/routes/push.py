from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from ..auth.dependencies import get_current_user, require_role
from ..services.push_service import push_service

router = APIRouter()

# Field length caps. Real Web-Push subscription values are well under
# these bounds — the caps exist so a malformed/malicious payload can't
# fill `secrets/push_subs.json` with megabytes of garbage per
# subscription. Iter-75 already caps the request body at 1 MB total;
# this caps individual fields so even a single subscription stays
# proportionate.
#
# Real-world sizes (for reference):
#   endpoint  Mozilla up to ~800, FCM ~600, APNs ~200 — 2048 is generous.
#   p256dh    fixed-length base64-encoded P-256 EC pubkey, ~88 chars.
#   auth      fixed-length base64-encoded 16-byte secret, ~24 chars.
_ENDPOINT_MAX = 2048
_P256DH_MAX = 200
_AUTH_MAX = 100


class PushKeys(BaseModel):
    model_config = ConfigDict(extra="forbid")
    p256dh: str = Field(min_length=1, max_length=_P256DH_MAX)
    auth: str = Field(min_length=1, max_length=_AUTH_MAX)


# iter-205 (Feature #4 slice 1): push notification filters. The
# client sends these on subscribe; slice 2's `send_matching`
# evaluates them per event before fanning out. Empty/null filters
# = match all (preserves pre-iter-205 "every sub gets every push"
# behavior). Bounds keep the persisted file size proportionate.
_FilterStr = Annotated[str, Field(min_length=1, max_length=64)]
# iter-209 (Feature #4 slice 4): schedule_window filter — HH:MM
# bounds for time-of-day push gating. Re-uses the existing pattern
# from `services/detection_config.py::HHMM_PATTERN` so the wire
# contract is consistent with the detection schedule_off fields.
_HHMM_PATTERN = r"^([01]\d|2[0-3]):[0-5]\d$"


class _ScheduleWindow(BaseModel):
    model_config = ConfigDict(extra="forbid")
    start: str = Field(pattern=_HHMM_PATTERN)
    end: str = Field(pattern=_HHMM_PATTERN)


class PushFilters(BaseModel):
    model_config = ConfigDict(extra="forbid")
    # When set, only events with `camera_id` in this list fire push
    # to the sub. Today single-camera deploys ship `camera_id="cam1"`
    # so a filter of `["cam1"]` matches everything; multi-cam (MC
    # Phase 1+) makes the field meaningful.
    cameras: list[_FilterStr] | None = Field(default=None, max_length=16)
    # When set, only events with `person_name` in this list fire push.
    # Useful for "notify me only when Israel is detected." A filter of
    # `[]` (empty list) means "no events match" — distinct from null
    # (match all).
    person_names: list[_FilterStr] | None = Field(default=None, max_length=16)
    # iter-209: HH:MM-HH:MM time-of-day window for push delivery,
    # interpreted in SERVER LOCAL TIME (matches the detection
    # `schedule_off_*` semantics — see `detection_config.py`).
    # When set, only events whose timestamp falls inside [start, end)
    # (with overnight wraparound when start > end) fire push.
    # null = no time gating (legacy: every event fires regardless of
    # time-of-day). start == end is interpreted as "no gating" (a
    # zero-length window matches nothing, but the use case is
    # accidental — operators will mean "no schedule").
    schedule_window: _ScheduleWindow | None = None


class Subscription(BaseModel):
    model_config = ConfigDict(extra="forbid")
    endpoint: str = Field(min_length=1, max_length=_ENDPOINT_MAX)
    expirationTime: float | None = None
    keys: PushKeys
    # iter-205: client-provided filters. Server stamps `user_id`
    # from auth context (NOT a request field — security; clients
    # can't impersonate other users' subscriptions).
    filters: PushFilters | None = None


class Unsubscribe(BaseModel):
    model_config = ConfigDict(extra="forbid")
    endpoint: str = Field(min_length=1, max_length=_ENDPOINT_MAX)


@router.get("/push/vapid-public-key")
async def vapid_key() -> dict[str, str]:
    if not push_service.public_key_b64:
        raise HTTPException(
            status_code=500,
            detail="VAPID keys not generated; run `python -m app.scripts.gen_vapid`",
        )
    return {"key": push_service.public_key_b64}


@router.post("/push/subscribe")
async def subscribe(
    sub: Subscription,
    user: str = Depends(get_current_user),
) -> dict[str, bool]:
    # iter-205 (Feature #4 slice 1): server stamps `user_id` from
    # the auth context. Ignores any client-provided value (Pydantic
    # `Subscription` doesn't expose `user_id` as a field — clients
    # can't impersonate other users' subs).
    sub_dict = sub.model_dump()
    sub_dict["user_id"] = user
    push_service.add(sub_dict)
    return {"ok": True}


@router.post("/push/unsubscribe")
async def unsubscribe(payload: Unsubscribe) -> dict[str, bool]:
    return {"ok": push_service.remove(payload.endpoint)}


# --- iter-207 (Feature #4 slice 3a): per-user filter management ----


class FiltersResponse(BaseModel):
    """Returned by GET /api/push/filters. `filters: null` means the
    user has no subs OR their subs match-all (no filters configured)."""
    model_config = ConfigDict(extra="forbid")
    filters: PushFilters | None


class FiltersBody(BaseModel):
    """Body for PUT /api/push/filters. Sending `filters: null`
    resets the user to match-all (legacy / unfiltered behavior)."""
    model_config = ConfigDict(extra="forbid")
    filters: PushFilters | None = None


@router.get("/push/filters", response_model=FiltersResponse)
async def get_my_push_filters(
    user: str = Depends(get_current_user),
) -> dict[str, object]:
    """Return the calling user's current push filters (or null if
    no subs / no filters set). User can only see their own — owner
    role + a future per-user lookup endpoint could let owners audit
    others; iter-207 keeps the surface self-only."""
    return {"filters": push_service.get_user_filters(user)}


@router.put("/push/filters", response_model=FiltersResponse)
async def set_my_push_filters(
    body: FiltersBody,
    user: str = Depends(get_current_user),
) -> dict[str, object]:
    """Update every subscription owned by the calling user with the
    provided filters. Per-user, not per-device — a future iter could
    split if operator demand surfaces. 404 when the user has no subs
    (re-subscribe via POST /push/subscribe first to get a
    PushSubscription endpoint registered)."""
    filters_dict = body.filters.model_dump() if body.filters is not None else None
    updated = push_service.update_user_filters(user, filters_dict)
    if updated == 0:
        raise HTTPException(
            status_code=404,
            detail="no subscriptions for this user; subscribe first",
        )
    return {"filters": filters_dict}


class KnownFilterOptions(BaseModel):
    """iter-303 response shape for the known-options endpoint."""
    model_config = ConfigDict(extra="forbid")
    cameras: list[str]
    person_names: list[str]


@router.get(
    "/push/known_filter_options",
    response_model=KnownFilterOptions,
    dependencies=[Depends(require_role("owner"))],
)
async def get_known_filter_options(
    user: str = Depends(get_current_user),
) -> dict[str, list[str]]:
    """iter-303 (user "instead of free-typing for the notifications,
    have a fuzzy search and a toggle on or off for each option"):
    return distinct camera_ids + person_names from the events table.
    The Notifications panel uses this to render two toggle lists
    (with a search box) instead of two comma-separated text inputs.

    Includes the user's CURRENT filter values too — so if they've
    selected "alice" but no alice events have landed yet, alice
    still shows in the picker (otherwise the next save would lose
    her). Re-loads on every render of the Notifications panel —
    cheap (~ms; SELECT DISTINCT against an indexed column) and
    keeps the picker fresh as new faces show up.

    iter-311 (security-auditor G1): owner-gated. Pre-iter-311 any
    auth'd user (family / viewer roles included) could enumerate
    every face-recognition identity in the household — a stolen
    family-role phone (or an over-the-shoulder peek) leaked the
    full set of enrolled person_names. Restricting to owner closes
    the PII disclosure. Family/viewer users can still RECEIVE
    notifications matching whatever filters their owner set up
    on their behalf via per-user push subscriptions; they just
    can't ENUMERATE the full identity set anymore. Trade: the
    Settings UI's filter picker only renders for owners now.
    """
    import asyncio
    from ..config import settings as _settings
    from ..services import events_db
    db_path = _settings.events_db_path
    # iter-316 (perf-auditor #4): SELECT DISTINCT against the events
    # table can scan the whole table on first call (the iter-216
    # composite indexes don't cover bare-column DISTINCT). Wrap
    # both calls in asyncio.to_thread + run them in parallel via
    # asyncio.gather so we pay one thread-pool round-trip instead
    # of two serial ones.
    cameras_list, persons_list = await asyncio.gather(
        asyncio.to_thread(events_db.distinct_cameras, db_path),
        asyncio.to_thread(events_db.distinct_persons, db_path),
    )
    cameras = set(cameras_list)
    person_names = set(persons_list)
    # Mix in the user's currently-selected filter values so editing
    # an existing filter never silently loses entries. iter-205
    # filters can be `None` (match-all) — guard for that.
    current = push_service.get_user_filters(user) or {}
    if current.get("cameras"):
        cameras.update(current["cameras"])
    if current.get("person_names"):
        person_names.update(current["person_names"])
    return {
        "cameras": sorted(cameras, key=str.casefold),
        "person_names": sorted(person_names, key=str.casefold),
    }


@router.post("/push/test")
async def test_push() -> dict[str, object]:
    sent = await push_service.send_all(
        {
            "title": "Home Camera",
            "body": "Test notification",
            "tag": "test",
            "url": "/settings",
        }
    )
    return {"ok": True, "sent": sent}
