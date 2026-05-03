"""Internal endpoints used by host-side helpers (the detection worker today).

Mounted under /api/_internal/*. There is no auth — same single-host LAN-trusted
model as the rest of the server. If you ever expose the server to the internet,
front this prefix with a firewall rule or middleware that rejects external IPs.
"""
from __future__ import annotations

import asyncio
import json
import logging
import math

from fastapi import APIRouter, Request
from pydantic import BaseModel, ConfigDict, Field, model_validator

from dataclasses import asdict

from ..services.detection import detection_service
from ..services.detection_config import detection_config
from ..services.event_bus import event_bus, make_detection_event
from ..services.health import worker_health
from ..services.push_service import push_service

router = APIRouter(prefix="/_internal", tags=["internal"])
log = logging.getLogger(__name__)

# iter-176: strong-reference set for fire-and-forget asyncio tasks.
# `asyncio.create_task` returns a Task that the event loop only weakly
# references — Python's GC can collect a pending Task before it
# finishes, raising "Task was destroyed but it is pending!" and
# silently dropping the work. The push fanout below is the only
# create_task site in `_internal.py`, but the pattern generalises: any
# fire-and-forget task should be added to this set and discarded via
# done_callback when complete. CPython issue #44665.
_BACKGROUND_TASKS: set[asyncio.Task] = set()

# iter-288 (security-auditor F1): cache the iter-276 unread_count
# refresh between detection events. Pre-iter-288 every detection
# emit (worst case ~1/s under burst, ~5/s under multi-camera +
# reduced cooldown) hit SQLite via asyncio.to_thread for the count.
# Sub-ms today, but burst-storm risk on the FastAPI thread pool +
# SQLite WAL contention with iter-218 write-through. A 1-second
# TTL is invisible to the user (the badge fires from the SAME push
# the count comes from — staleness here is bounded by the
# next emit, not by the cache TTL) and bounds the cost at 1
# count/s regardless of emit rate.
_UNREAD_CACHE: dict = {"value": 0, "ts": 0.0}
_UNREAD_CACHE_TTL_S = 1.0

# Whitelist of metrics fields the worker may send. Anything else is dropped
# so a buggy/malicious worker can't fill `worker_metrics` with arbitrary
# JSON that downstream code (or the client) doesn't expect.
_ALLOWED_METRIC_FIELDS = frozenset(
    {
        "fps",
        "infer_per_s",
        "gear",
        "frames",
        "inferences",
        "emitted",
        "dropped",
        "infer_ms_recent",
        "infer_ms_p95",
        "mediamtx_restarts",
        # iter-187 (Feature #9 observability): wall-clock ms for the
        # most recent worker save_thumb() call. Operator uses this to
        # decide whether the NVENC encode swap is worth doing — if
        # PIL+jetson_utils stays under ~20 ms steady-state, no need.
        "thumb_ms_recent",
        "uptime_s",
        "face_recog_names",
        # iter-302 (user "make sure all issues that broke the live
        # feed will never happen again"): the iter-300 silent-stall
        # signature (worker alive + heartbeating, but no frames
        # arriving from RTSP) had no observable signal until the
        # user noticed video was frozen. last_frame_ts is the
        # unix-epoch timestamp of the most recent successful
        # Capture(); /api/status derives `seconds_since_last_frame`
        # from it. Counts argus_restarts so the UI can show "X
        # heavy-hammer recoveries today" — non-zero means the
        # nvargus-daemon escalation path was needed.
        "last_frame_ts",
        "argus_restarts",
    }
)

# Numeric fields — every metric except `gear` (string) and
# `face_recog_names` (list[str]). A worker bug that serialises one of
# these as a string would silently leak garbage to the UI; this lets
# us drop non-numeric values per-field rather than poisoning the
# whole snapshot.
_NUMERIC_METRIC_FIELDS = _ALLOWED_METRIC_FIELDS - {"gear", "face_recog_names"}

# Bounds for the `gear` string. Today's documented values are
# {active, idle, off, scheduled-off, low-memory, thermal-throttled} —
# the longest is 17 chars. 32 leaves headroom for future additions
# without admitting unbounded payloads. The lower bound (1 after
# strip) rejects empty / whitespace-only strings that would render
# as a blank pill in the UI.
_GEAR_MAX = 32

# Bounds for the `face_recog_names` list. Realistic encodings.pkl
# files have 1-10 entries with names like "israel" / "sheenal"
# (~5-15 chars), so 50 names × 64 chars is generous defense — a
# malformed/malicious worker can't pump megabytes of names into
# `worker_metrics`. The UI's chip rendering also only shows the
# first 4 + count, so values past the cap wouldn't be visible
# anyway — this keeps the snapshot size bounded.
_FACE_RECOG_NAMES_MAX = 50
_FACE_RECOG_NAME_LEN_MAX = 64


def _coerce_metric(key: str, value):
    """Return `value` if it's the right type for `key`, else None.
    Numeric fields: booleans excluded (Python's `isinstance(True,
    int)` quirk), NaN / ±Inf rejected (`json.loads` accepts them by
    default but the browser's `JSON.parse` on `/api/status` would
    throw, and they'd render as `"NaN"` in the UI). `gear` is
    stripped of whitespace and bounded to `_GEAR_MAX` chars
    (iter-117). `face_recog_names` requires a `list[str]` with
    ≤`_FACE_RECOG_NAMES_MAX` entries each ≤`_FACE_RECOG_NAME_LEN_MAX`
    chars; any non-conforming list drops the whole field (iter-118
    all-or-nothing — mixed-type lists would confuse the UI's chip
    rendering)."""
    if key in _NUMERIC_METRIC_FIELDS:
        if isinstance(value, bool):
            return None
        if isinstance(value, (int, float)):
            if not math.isfinite(value):
                return None
            return value
        return None
    if key == "gear":
        if not isinstance(value, str):
            return None
        # Reject empty / whitespace-only / oversized values. Without
        # the strip-then-len check, a worker emitting `gear=""` would
        # render as a blank worker-pill on the UI; a `gear="x"*1MB`
        # would inflate `worker_metrics` past the body cap on the
        # next /api/status response.
        stripped = value.strip()
        if not stripped or len(stripped) > _GEAR_MAX:
            return None
        return stripped
    if key == "face_recog_names":
        if not isinstance(value, list):
            return None
        # All-or-nothing on type (mixed types would confuse the UI's
        # chip rendering). Length bounds are inclusive: list ≤ 50,
        # each name ≤ 64 chars.
        if len(value) > _FACE_RECOG_NAMES_MAX:
            return None
        for x in value:
            if not isinstance(x, str) or not x or len(x) > _FACE_RECOG_NAME_LEN_MAX:
                return None
        return value
    return None


class Box(BaseModel):
    model_config = ConfigDict(extra="forbid")
    x: float = Field(ge=0, le=1)
    y: float = Field(ge=0, le=1)
    w: float = Field(ge=0, le=1)
    h: float = Field(ge=0, le=1)
    label: str = Field(min_length=1, max_length=64)
    score: float = Field(ge=0, le=1)

    @model_validator(mode="after")
    def _box_within_frame(self) -> "Box":
        # Per-field bounds let `{x: 0.9, w: 0.5}` slip through — a box
        # that walks off the right edge. The client canvas would then
        # draw bbox geometry past the visible <video>. Tolerance is
        # 1e-3 — about 1.3 px at 720p (1 px there is 1/1280 ≈ 7.8e-4).
        # Generous on purpose: detection/detect.py clamps each coord
        # independently to [0,1], and if jetson-inference ever returns
        # Right slightly past frame width, x + w can land at
        # 1 + sub-pixel without being a real off-screen box.
        eps = 1e-3
        if self.x + self.w > 1 + eps:
            raise ValueError("box extends past right edge: x + w > 1")
        if self.y + self.h > 1 + eps:
            raise ValueError("box extends past bottom edge: y + h > 1")
        return self


class DetectionPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")
    label: str = Field(min_length=1, max_length=64)
    score: float = Field(ge=0, le=1)
    boxes: list[Box] = Field(min_length=1, max_length=32)
    camera_id: str = Field(default="cam1", min_length=1, max_length=64)
    # iter-193 (iter-169 Minor S3 closure): regex-validate the thumb
    # URL. The worker (detect.py:114) emits `/snapshots/thumb_<ts>.jpg`
    # only — pin that format strictly. Pre-iter-193 a buggy or
    # malicious worker could emit `https://attacker.lan/track.gif` or
    # `/snapshots/../etc/passwd`; the URL would flow unchallenged to
    # WebSocket subscribers (`EventList.tsx <img src={evt.thumb_url}>`)
    # AND to Web Push payloads as the iter-188 hero `image` field —
    # both surfaces would load the attacker's URL. The strict regex
    # blocks both vectors. If iter-201's NVENC swap changes the
    # filename or extension, this test fires and forces an explicit
    # regex update.
    thumb_url: str | None = Field(
        default=None,
        max_length=512,
        pattern=r"^/snapshots/thumb_[0-9]+\.jpg$",
    )
    # iter-204 (Feature #1 slice 4): per-event MP4 clip URL. Same
    # strict-regex defense as `thumb_url` — only the canonical
    # iter-201 route format passes (`/api/events/<event_id>/clip`
    # with the same `[A-Za-z0-9_-]+` charset the route enforces).
    # Worker emits null when no clip exists / hasn't been recorded
    # yet. Client `<ClipModal>` hard-codes the URL today; this
    # field's value will let a future iter skip the video-fetch on
    # known-no-clip events.
    clip_url: str | None = Field(
        default=None,
        max_length=512,
        pattern=r"^/api/events/[A-Za-z0-9_-]+/clip$",
    )
    # iter-247 (Feature #1 slice 2b): worker-supplied event id. The
    # worker generates a uuid before the emit so it can pre-create
    # the clip file at `recordings/<id>.mp4` AND post the event with
    # `clip_url=/api/events/<id>/clip` in one shot — the alternative
    # is a server roundtrip per event which doubles emit latency.
    # Strict charset matches `recording_service._VALID_EVENT_ID`
    # AND the iter-201 route regex on `/api/events/{event_id}/clip`.
    # Optional: when null, server falls back to its own uuid (legacy
    # behavior; events from a pre-iter-247 worker keep working).
    id: str | None = Field(
        default=None,
        min_length=1,
        max_length=64,
        pattern=r"^[A-Za-z0-9_-]+$",
    )
    # Optional face-recognition match. The detection worker only sets this
    # when the person bbox contains a face that matches a known encoding
    # within tolerance — otherwise it stays null and the UI just shows the
    # generic label. Trimmed and length-capped to keep label rendering sane.
    person_name: str | None = Field(default=None, min_length=1, max_length=64)


@router.get("/detection/config")
async def worker_detection_config() -> dict[str, object]:
    """Worker-side mirror of GET /api/detection/config (iter-244).

    The user-facing /api/detection/config sits in `control.py`, which
    is router-wide gated by iter-184's `Depends(get_current_user)`.
    The detection worker has no cookies — it lives on the Jetson host
    outside the auth surface and only speaks to /api/_internal/* (the
    loopback-trusted carve-out). Pre-iter-244 the worker's config
    poll 401'd silently; the worker fell through to compiled-in
    defaults and never picked up user-driven threshold / enabled
    changes.

    This route returns the SAME `asdict(detection_config.get())`
    payload as the user-facing GET. Read-only — the worker never
    PATCHes config; it polls. The user-facing route remains the only
    write path and stays auth-gated.

    No body validation: detection_config is canonical state on disk
    (iter-99 _safe_float-defended) and asdict() always returns the
    same shape.
    """
    return asdict(detection_config.get())


@router.post("/heartbeat")
async def worker_heartbeat(request: Request) -> dict[str, bool]:
    """Called periodically by the host-side detection worker so the server
    knows it's alive. The /api/status route reports `worker_alive` based
    on the time since the last heartbeat.

    The body is optional — empty body / missing JSON / malformed JSON all
    behave like a bare ping and just bump the timestamp. When the body is
    a JSON object we also capture a whitelisted slice into `worker_metrics`
    (fps, gear, etc.) so the UI can show live detection rate.

    If a heartbeat carries fields but every field fails `_coerce_metric`,
    the resulting `picked` dict is empty and `WorkerHealth.heartbeat`
    only bumps the timestamp — prior metrics are preserved instead of
    being wiped. This is the iter-78 partial-heartbeat semantic: a
    momentary garbage snapshot doesn't erase a known-good one. A
    heartbeat with at least one valid field DOES replace the snapshot
    wholesale (iter-94's "no merge" rule — ghost fields after a worker
    restart would be confusing)."""
    metrics: dict | None = None
    # iter-176: the `await request.body() + json.loads` pattern below
    # is DELIBERATE (NOT a candidate for a Pydantic model). Per CLAUDE.md
    # anti-recommendation list (iter-78 / iter-94): a Pydantic model
    # would 422 on malformed JSON or empty body, surfacing as
    # `urllib.HTTPError 422` in the worker's heartbeat thread and
    # flickering the UI's `worker_alive` to false during what should be
    # a graceful no-op. The handler must always return 200 and bump
    # the heartbeat timestamp; bad payloads degrade silently to "no
    # metrics this round" without affecting liveness.
    raw = await request.body()
    if raw:
        try:
            data = json.loads(raw)
        except (ValueError, json.JSONDecodeError):
            data = None
        if isinstance(data, dict) and data:
            picked: dict = {}
            for k, v in data.items():
                if k not in _ALLOWED_METRIC_FIELDS:
                    continue
                coerced = _coerce_metric(k, v)
                if coerced is not None:
                    picked[k] = coerced
            if picked:
                metrics = picked
    worker_health.heartbeat(metrics)
    return {"ok": True}


@router.post("/event")
async def publish_detection(payload: DetectionPayload) -> dict[str, object]:
    # Pydantic's `Field(min_length=1, max_length=32)` on `boxes` already
    # rejects empty / oversized payloads with 422 before the handler
    # runs. No additional check needed here.
    #
    # Receiving an event also counts as a heartbeat — the worker is alive.
    worker_health.heartbeat()

    # The "Detect" toggle in the UI sets `detection_service.active`. When the
    # user pauses detection we still receive events from the host worker
    # (it runs continuously), but we drop them here instead of forwarding to
    # WebSocket subscribers / Web Push.
    if not detection_service.active:
        return {"ok": True, "dropped": "detection paused"}

    evt = make_detection_event(
        label=payload.label,
        score=payload.score,
        boxes=[b.model_dump() for b in payload.boxes],
        camera_id=payload.camera_id,
        thumb_url=payload.thumb_url,
        person_name=payload.person_name,
        clip_url=payload.clip_url,
        event_id=payload.id,
    )
    await event_bus.publish(evt)

    # Fan out to push subscriptions in the background so the worker's POST
    # returns quickly. webpush is synchronous and goes over the network; we
    # don't want detection latency tied to Apple/Google push servers.
    # iter-176: hold a strong reference until the task completes so Python's
    # GC can't collect it mid-flight (CPython issue #44665).
    task = asyncio.create_task(_send_push(evt))
    _BACKGROUND_TASKS.add(task)
    task.add_done_callback(_BACKGROUND_TASKS.discard)

    return {"ok": True, "event_id": evt["id"]}


async def _send_push(evt: dict) -> None:
    """Build a Web Push notification payload from the event dict +
    fan it out via `send_matching` (iter-206, Feature #4 slice 2).
    Switched from the old `payload: DetectionPayload + send_all`
    signature so subscription-level filters can be evaluated against
    the canonical event fields (`camera_id`, `person_name`)."""
    # When the worker matched a known face, surface the name in the
    # notification title — "Israel detected" reads better than "Person
    # detected" on the lock-screen.
    person_name = evt.get("person_name")
    label = evt.get("label", "")
    score = float(evt.get("score", 0.0))
    title = (
        "{} detected".format(person_name.title())
        if person_name
        else "{} detected".format(label.title())
    )
    # iter-188 (Feature #7): include the detection thumbnail URL as
    # `image` in the push payload so Chrome/Edge/Firefox render it
    # as the notification's hero image. Lets the user decide "is this
    # a person I care about?" without tapping into the app. Worker
    # already saves the thumb (iter-7) and emits the URL on the
    # `/api/_internal/event` body — no new I/O. Skip the field
    # entirely when no thumb is available so the SW's
    # `data.image ?? undefined` lookup keeps the showNotification
    # signature minimal (passing image: undefined vs not passing the
    # key are equivalent at the spec level, but absent-key reads
    # cleaner in DevTools).
    push_payload: dict[str, object] = {
        "title": title,
        "body": "Front Door · {}%".format(int(score * 100)),
        "tag": "detection",
        "url": "/events",
        # iter-276 (widget-usability-auditor C1 server side): include
        # the event id so the SW push handler can use it as the
        # Notification.tag, preventing detection bursts from silently
        # collapsing into one notification on the user's lock screen.
        # Worker generates the id pre-emit (iter-247) so it's always
        # present on the bus payload.
        "event_id": evt.get("id"),
    }
    thumb_url = evt.get("thumb_url")
    if thumb_url:
        push_payload["image"] = thumb_url
    # iter-276 (widget-usability-auditor A1): include the live unread
    # count so the SW can update the home-screen app badge on every
    # push receipt — even when the PWA is closed (the in-app
    # `useUnreadBadge` hook only ticks when the app is running).
    # Pre-iter-276 a closed PWA's badge stayed stale until the next
    # foreground launch. The query is one indexed COUNT off the
    # iter-216 events_unseen_ts partial index — sub-ms on the Jetson
    # eMMC. Wrapped in `asyncio.to_thread` to keep the asyncio loop
    # free (mirror of the iter-273 pattern on the user-facing
    # /api/events/* routes). Failure of the count query is swallowed
    # silently — push delivery MUST NOT block on a count refresh.
    try:
        from ..config import settings as _settings
        from ..services import events_db

        # iter-288 (security-auditor F1): 1-second TTL on the
        # unread_count refresh. Reuses the cached value when within
        # TTL; fetches via asyncio.to_thread otherwise.
        import time as _t

        now_s = _t.monotonic()
        if now_s - _UNREAD_CACHE["ts"] >= _UNREAD_CACHE_TTL_S:
            unread = await asyncio.to_thread(
                events_db.unread_count, _settings.events_db_path
            )
            _UNREAD_CACHE["value"] = unread
            _UNREAD_CACHE["ts"] = now_s
        push_payload["unread_count"] = _UNREAD_CACHE["value"]
    except Exception:
        log.warning("unread_count refresh for push payload failed", exc_info=True)
    try:
        # iter-206: send_matching evaluates each sub's filters against
        # the event before fanning out. Legacy subs (filters=None)
        # match all events — preserves iter-188 hero flow + iter-141
        # test-push behavior for unfiltered subs.
        await push_service.send_matching(evt, push_payload)
    except Exception:
        log.exception("push send failed in _internal/event")
