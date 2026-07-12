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
import time
from typing import Literal

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator

from dataclasses import asdict

from ..services.camera_registry import camera_registry
from ..services.detection import detection_service
from ..services.detection_config import detection_config
from ..services.event_bus import event_bus, make_detection_event
from ..services.health import worker_health
from ..services import audit_db, host_bridge
from ..services import push_assurance, recording_assurance
from ..config import settings
from ..services.push_service import push_service
from ..services.alert_policy import decide_alert
from ..services import mediamtx_auth
from ..log import RateLimitedLog
from ..services.camera_exposure import CameraExposureConfig, camera_exposure

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
        # logging-plan (docs/logging_plan.md §1.2): failure-rate counters
        # so the operator sees RATES over time, not just one-off journal
        # lines. The worker increments these monotonically and surfaces
        # them on the heartbeat; /api/status exposes the snapshot. Each is
        # a plain numeric counter (goes through the _NUMERIC_METRIC_FIELDS
        # path below). Unregistered metrics are silently dropped, so these
        # MUST be listed here or the heartbeat slice discards them.
        "clips_dropped_capacity",
        "clip_start_failures",
        "face_recog_failures",
        "event_post_failures",
        "thumb_save_failures",
        # Continuous-capture observability (plan S6, feat/continuous-capture).
        # Only non-zero when the worker runs with DETECT_CONTINUOUS_CAPTURE=1.
        # visits_finalized counts completed one-clip-per-visit recordings;
        # clips_dropped_disk_floor counts opens refused by the worker disk
        # floor (S4.5/B2). Both go through the numeric path below.
        "visits_finalized",
        "clips_dropped_disk_floor",
        # Watchdog escalation + wedge diagnostics. Flat metric keys keep the
        # worker/server/client heartbeat contract explicit and preserve the
        # existing numeric-hardening path. watchdog_last_action is the lone
        # human-readable rung string; empty string means no action yet.
        "watchdog_level",
        "watchdog_last_action",
        "watchdog_last_action_at",
        "watchdog_last_reboot_at",
        "watchdog_action_count",
        "wedge_diag_at",
        "wedge_diag_nvargus_rss_kb",
        "wedge_diag_gpu_temp_c",
        "wedge_diag_mem_avail_mb",
        "wedge_diag_argus_pending",
        "power_sensor_status",
        "power_volts",
        "power_amps",
        "power_watts",
        "power_sample_ts",
        "power_read_failures",
        "camera_quality_status",
        "camera_luma",
        "camera_sharpness",
        "camera_frame_delta",
    }
)

# Numeric fields — every metric except `gear` (string) and
# `face_recog_names` (list[str]). A worker bug that serialises one of
# these as a string would silently leak garbage to the UI; this lets
# us drop non-numeric values per-field rather than poisoning the
# whole snapshot.
_NUMERIC_METRIC_FIELDS = _ALLOWED_METRIC_FIELDS - {
    "gear",
    "face_recog_names",
    "watchdog_last_action",
}

# Bounds for the `gear` string. Today's documented values are
# {active, idle, off, scheduled-off, low-memory, thermal-throttled} —
# the longest is 17 chars. 32 leaves headroom for future additions
# without admitting unbounded payloads. The lower bound (1 after
# strip) rejects empty / whitespace-only strings that would render
# as a blank pill in the UI.
_GEAR_MAX = 32
_WATCHDOG_ACTION_MAX = 24

# Bounds for the `face_recog_names` list. Realistic encodings.pkl
# files have 1-10 entries with names like "israel" / "sheenal"
# (~5-15 chars), so 50 names × 64 chars is generous defense — a
# malformed/malicious worker can't pump megabytes of names into
# `worker_metrics`. The UI's chip rendering also only shows the
# first 4 + count, so values past the cap wouldn't be visible
# anyway — this keeps the snapshot size bounded.
_FACE_RECOG_NAMES_MAX = 50
_FACE_RECOG_NAME_LEN_MAX = 64

# logging-plan (docs/logging_plan.md §2 detection/events): heartbeat
# metric-coercion drops are silent today — a worker that starts emitting
# a metric with the wrong type (or a key not on the whitelist) loses that
# field every 10 s with zero signal. We log it at DEBUG (the heartbeat is
# a 10 s hot path — CLAUDE.md `_SuppressNoisyAccess` discipline) and gate
# it behind a once-flag so a persistently-misbehaving worker writes one
# line, not one every 10 s forever. The flag re-arms only on process
# restart — a single line is enough to point the operator at the worker.
_heartbeat_drop_warned = False

# logging-plan (docs/logging_plan.md §1.3): server sink for client-side
# logs. The PWA's `lib/log.ts` ships error+warn lines here so a failure
# on a phone the operator can't physically inspect lands in the same
# journald stream as the server. Mounted under the unauthenticated
# `_internal` router (CLAUDE.md pin: `_internal` is never auth-gated) so
# it works on the anon login screen too. App-level rate cap (NOT a
# middleware — CLAUDE.md anti-rec stands) so a looping client can't
# flood the journal / SD card.
_CLIENT_LOG_WINDOW_S = 10.0
_CLIENT_LOG_MAX_PER_WINDOW = 50
_client_log_bucket = {"ts": 0.0, "count": 0}
_CLIENT_LOG_LEVELS = {
    "error": logging.ERROR,
    "warn": logging.WARNING,
    "info": logging.INFO,
    "debug": logging.DEBUG,
}
_MEDIAMTX_AUTH_LOG_GATES = {
    category: RateLimitedLog(60.0)
    for category in ("untrusted_peer", "malformed", "denied", "internal_error")
}


def _mediamtx_auth_rejected(peer: str, category: str, error_type: str = "-") -> None:
    gate = _MEDIAMTX_AUTH_LOG_GATES[category]
    if gate.should_log():
        # Never log the callback body, exception message, client IP field, or
        # any credentials. Category + source peer + exception class are enough
        # to distinguish deployment drift from a denied media grant.
        log.warning(
            "MediaMTX auth rejected: peer=%s category=%s error_type=%s",
            peer,
            category,
            error_type,
        )


class _MediaMtxAuthPayload(BaseModel):
    """Exact bounded shape emitted by MediaMTX v1.18 authMethod=http."""

    model_config = ConfigDict(extra="forbid", strict=True)
    user: str = Field(max_length=128)
    password: str = Field(max_length=256)
    token: str = Field(max_length=256)
    ip: str = Field(min_length=2, max_length=64)
    action: Literal["publish", "read", "playback", "api", "metrics", "pprof"]
    path: str = Field(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9_-]+$")
    protocol: str = Field(min_length=1, max_length=32, pattern=r"^[a-z0-9]+$")
    id: str | None = Field(default=None, max_length=128)
    query: str = Field(max_length=2048)


async def _bounded_auth_json(request: Request) -> object:
    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > 8192:
            raise ValueError("auth callback payload too large")
    return json.loads(body.decode("utf-8"))


@router.post("/mediamtx-auth")
async def mediamtx_http_auth(request: Request) -> Response:
    """Authorize MediaMTX without ever reflecting credentials in errors."""
    peer = request.client.host if request.client is not None else ""
    if not mediamtx_auth.trusted_callback_host(peer):
        _mediamtx_auth_rejected(peer, "untrusted_peer")
        return Response(status_code=403)
    try:
        raw = await _bounded_auth_json(request)
        payload = _MediaMtxAuthPayload.model_validate(raw).model_dump()
        allowed = mediamtx_auth.authorize(payload)
    except (ValidationError, ValueError, TypeError, UnicodeError) as exc:
        _mediamtx_auth_rejected(peer, "malformed", type(exc).__name__)
        return Response(status_code=401)
    except Exception as exc:
        # Fail closed without logging the body or an exception whose message
        # could contain user/password/token input.
        _mediamtx_auth_rejected(peer, "internal_error", type(exc).__name__)
        return Response(status_code=401)
    if not allowed:
        _mediamtx_auth_rejected(peer, "denied")
    return Response(status_code=204 if allowed else 401)


class ClientLog(BaseModel):
    model_config = ConfigDict(extra="forbid")
    level: str = Field(pattern=r"^(error|warn|info|debug)$")
    event: str = Field(min_length=1, max_length=120)
    fields: dict | None = Field(default=None)
    online: bool | None = None
    ua: str | None = Field(default=None, max_length=256)

    @model_validator(mode="after")
    def _bound_fields(self) -> "ClientLog":
        # Cap the serialized field payload so a buggy/malicious client
        # can't pump megabytes into the journal. The client already
        # bounds this; this is the server-side belt.
        if self.fields is not None:
            try:
                if len(json.dumps(self.fields)) > 2048:
                    object.__setattr__(self, "fields", {"_truncated": True})
            except (TypeError, ValueError):
                object.__setattr__(self, "fields", {"_unserializable": True})
        return self


class RecordingStoragePayload(BaseModel):
    model_config = ConfigDict(extra="forbid")
    writable: bool
    filesystem: str | None = Field(default=None, max_length=32)
    read_only: bool | None = None
    smart_status: Literal["healthy", "failed", "unavailable"]
    free_bytes: int | None = Field(default=None, ge=0)
    write_probe_ms: float | None = Field(default=None, ge=0, le=60_000)


class EventClipAssurancePayload(BaseModel):
    model_config = ConfigDict(extra="forbid")
    state: Literal["none", "playable", "failed"]
    event_id: str | None = Field(default=None, pattern=r"^[A-Za-z0-9_-]+$", max_length=128)
    checked_at: float = Field(gt=0)
    sample_bytes: int | None = Field(default=None, ge=0, le=10_000_000_000)
    elapsed_ms: float | None = Field(default=None, ge=0, le=180_000)
    reason: Literal[
        "no_event_clip",
        "event_playable",
        "event_decode_timeout",
        "event_decode_failed",
    ]

    @model_validator(mode="after")
    def _coherent(self) -> "EventClipAssurancePayload":
        if not math.isfinite(self.checked_at) or abs(time.time() - self.checked_at) > 300:
            raise ValueError("event clip checked_at must be within 5 minutes")
        if self.state == "none":
            if self.event_id is not None or self.reason != "no_event_clip":
                raise ValueError("empty event check must not claim an event")
        elif self.event_id is None or self.sample_bytes is None or self.sample_bytes <= 0:
            raise ValueError("checked event clip requires an id and non-empty file")
        if self.state == "playable" and self.reason != "event_playable":
            raise ValueError("playable event clip requires event_playable reason")
        if self.state == "failed" and self.reason not in (
            "event_decode_timeout", "event_decode_failed"
        ):
            raise ValueError("failed event clip requires a decode failure reason")
        return self


class RecordingAssurancePayload(BaseModel):
    model_config = ConfigDict(extra="forbid")
    v: Literal[1]
    status: Literal["ok", "failed"]
    checked_at: float = Field(gt=0)
    stage: Literal["storage", "capture", "decode", "cleanup", "event_decode", "complete"]
    reason: Literal[
        "storage_unavailable",
        "storage_read_only",
        "storage_not_writable",
        "capture_timeout",
        "capture_failed",
        "capture_empty",
        "decode_timeout",
        "decode_failed",
        "cleanup_failed",
        "event_decode_timeout",
        "event_decode_failed",
        "playable",
    ]
    sample_bytes: int | None = Field(default=None, ge=0, le=1_000_000_000)
    # Includes the bounded synthetic capture/decode plus a full decode of the
    # newest real event, so the legitimate worst case exceeds two minutes.
    elapsed_ms: float | None = Field(default=None, ge=0, le=240_000)
    storage: RecordingStoragePayload | None = None
    event_clip: EventClipAssurancePayload | None = None

    @model_validator(mode="after")
    def _coherent(self) -> "RecordingAssurancePayload":
        if not math.isfinite(self.checked_at) or abs(time.time() - self.checked_at) > 300:
            raise ValueError("checked_at must be within 5 minutes")
        if self.status == "ok" and (self.reason != "playable" or self.stage != "complete"):
            raise ValueError("ok status requires complete playable result")
        if self.status == "failed" and self.reason == "playable":
            raise ValueError("failed status cannot be playable")
        reason_stage = {
            "storage_unavailable": "storage",
            "storage_read_only": "storage",
            "storage_not_writable": "storage",
            "capture_timeout": "capture",
            "capture_failed": "capture",
            "capture_empty": "capture",
            "decode_timeout": "decode",
            "decode_failed": "decode",
            "cleanup_failed": "cleanup",
            "event_decode_timeout": "event_decode",
            "event_decode_failed": "event_decode",
        }
        if self.status == "failed" and reason_stage.get(self.reason) != self.stage:
            raise ValueError("failure reason does not match stage")
        if self.status == "ok":
            if self.sample_bytes is None or self.sample_bytes < 1024:
                raise ValueError("playable result requires a non-empty sample")
            if (
                self.storage is None
                or not self.storage.writable
                or self.storage.read_only is True
            ):
                raise ValueError("playable result requires writable storage")
        if self.stage == "event_decode":
            if self.event_clip is None or self.event_clip.state != "failed":
                raise ValueError("event decode failure requires a failed event clip result")
        return self


class PushReceiptPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")
    receipt_id: str = Field(min_length=24, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")
    shown: bool


class _ClaimBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str = Field(min_length=1, max_length=128)


class _ResultBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str = Field(min_length=1, max_length=128)
    status: str = Field(pattern=r"^(done|failed)$")
    detail: str | None = Field(default=None, max_length=512)
    result: dict | None = None

    @model_validator(mode="after")
    def _bound_result(self) -> "_ResultBody":
        if self.result is not None:
            try:
                if len(json.dumps(self.result)) > 64_000:
                    raise ValueError("result payload too large")
            except (TypeError, ValueError) as exc:
                raise ValueError("result payload too large") from exc
        return self


def _previous_exposure_config(record: dict) -> CameraExposureConfig:
    args = record.get("args") if isinstance(record.get("args"), dict) else {}
    previous = args.get("_previous_config")
    if not isinstance(previous, dict):
        raise ValueError("missing previous exposure configuration")
    return CameraExposureConfig(**previous)


def _restore_exposure_config(record: dict) -> CameraExposureConfig | None:
    try:
        previous = _previous_exposure_config(record)
        camera_exposure.save(previous)
        return previous
    except Exception:
        # Exposure coordinates are household geometry. Log only the stable
        # request id and exception type/trace, never args or request bodies.
        log.error(
            "host_action exposure rollback persistence failed id=%s",
            record.get("id"),
            exc_info=True,
        )
        return None


def _reconcile_expired_exposure(record: dict) -> dict | None:
    """Return a new rollback action for an unconfirmed expired apply."""
    if record.get("kind") != "exposure_apply" or record.get("status") != "expired":
        return None
    previous = _restore_exposure_config(record)
    if previous is None:
        return None
    args = {**asdict(previous), "_previous_config": asdict(previous)}
    replacement = host_bridge.enqueue(
        "exposure_apply",
        args,
        requested_by=str(record.get("requested_by") or "exposure-reconcile"),
        now=time.time(),
    )
    log.warning(
        "expired exposure apply queued fail-closed rollback old_id=%s new_id=%s",
        record.get("id"),
        replacement.get("id"),
    )
    return replacement


@router.get("/host_action")
async def host_action_poll() -> dict[str, object]:
    rec = host_bridge.peek(time.time(), max_pending_age_s=120.0)
    if rec is None:
        latest = host_bridge.latest()
        if isinstance(latest, dict):
            rec = _reconcile_expired_exposure(latest)
    if rec is None:
        return {"action": None}
    return {
        "action": {
            "id": rec["id"],
            "kind": rec["kind"],
            "args": rec.get("args") or {},
            "requested_at": rec["requested_at"],
        }
    }


@router.post("/host_action/claim")
async def host_action_claim(body: _ClaimBody) -> dict[str, str]:
    return {"result": host_bridge.claim(body.id, time.time())}


@router.post("/host_action/result")
async def host_action_result(body: _ResultBody) -> dict[str, bool]:
    now = time.time()
    rec = host_bridge.get(body.id)
    ok = host_bridge.record_result(
        body.id,
        body.status,
        body.detail,
        body.result,
        now=now,
    )
    # Apply rollback only after host_bridge accepted the active terminal
    # transition. Duplicate/replayed callbacks return ok=False and must never
    # overwrite a newer exposure configuration.
    if (
        ok
        and isinstance(rec, dict)
        and rec.get("kind") == "exposure_apply"
        and body.status == "failed"
    ):
        _restore_exposure_config(rec)
    if ok:
        action = (rec or host_bridge.get(body.id) or {}).get("kind", "")
        audit_action = (
            "mediamtx"
            if action in ("focus_start", "focus_stop", "exposure_apply")
            else action
        )
        username = (rec or host_bridge.get(body.id) or {}).get("requested_by", "worker")
        try:
            audit_db.insert_host_action_event(
                settings.audit_db_path,
                ts=now,
                username=username,
                action=audit_action,
                request_id=body.id,
                phase="result",
                status=body.status,
                detail=body.detail,
            )
        except Exception:
            log.warning(
                "host_action result audit failed for id=%s status=%s",
                body.id,
                body.status,
                exc_info=True,
            )
    return {"ok": ok}


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
    if key == "watchdog_last_action":
        if not isinstance(value, str):
            return None
        stripped = value.strip()
        if len(stripped) > _WATCHDOG_ACTION_MAX:
            stripped = stripped[:_WATCHDOG_ACTION_MAX]
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
    # docs/multicam_contract.md (2026-07-07): camera dimension. The
    # worker sets this from DETECT_CAMERA_ID; a pre-multicam worker
    # omits it and gets the default. Regex mirrors the registry pin
    # (`camera_registry.CAMERA_ID_RE`) — the pattern also enforces the
    # 1..32 length bound.
    camera_id: str = Field(default="front_door", pattern=r"^[a-z0-9_]{1,32}$")
    # Continuous-capture cap-splits (2026-07-07): segment_index > 0 visit
    # opens are the SAME physical presence rolling into its next
    # max_visit_s window. The row is real (it owns a real clip) but a
    # fresh push notification per window is spam — `continuation: true`
    # keeps the insert + WS broadcast and suppresses ONLY the push fanout.
    continuation: bool = False
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
    # iter-357 (multi-person face-recog): list of every recognized
    # face in the frame, in detection-confidence order. Worker fans
    # out the face-recog pass over up to `HOMECAM_MAX_PERSONS_FACE_RECOG`
    # (default 4) person bboxes and aggregates the matches. The
    # legacy `person_name` above remains the FIRST match (or null
    # when the list is empty) so old clients/tests + the iter-216
    # SQLite `events.person_name` indexed column don't change shape.
    # Cap at 16 names (matches the worker-side ceiling) × 64 chars
    # per name — same per-name bounds as `person_name`.
    person_names: list[str] | None = Field(
        default=None, max_length=16,
    )
    source: Literal["vision"] = "vision"
    rule_id: str | None = Field(
        default=None, pattern=r"^[a-z0-9_]{1,32}$"
    )
    rule_name: str | None = Field(default=None, min_length=1, max_length=64)
    correlation_id: str | None = Field(
        default=None, pattern=r"^[A-Za-z0-9_-]{1,128}$"
    )
    related_event_id: str | None = Field(
        default=None, pattern=r"^[A-Za-z0-9_-]{1,128}$"
    )
    visit_id: str | None = Field(
        default=None, pattern=r"^[A-Za-z0-9_-]{1,128}$"
    )
    start_ts: float | None = Field(default=None, gt=0)
    end_ts: float | None = Field(default=None, gt=0)
    package_state: Literal["delivered", "collected"] | None = None

    @model_validator(mode="after")
    def _normalize_person_fields(self) -> "DetectionPayload":
        """Pin three invariants on the person_name / person_names pair:

        1. Every entry in `person_names` must satisfy the same
           per-name bounds as `person_name` (1..64 chars, non-empty).
           Pydantic's `max_length=16` only caps the LIST length;
           per-item validation is done here so a malformed worker
           can't inject zero-length / oversized strings via the
           list path.

        2. If both `person_name` and `person_names` are set, the
           legacy field must equal `person_names[0]` (worker
           convention: first match = legacy name). Mismatched values
           reject as 422 — the alternative is silently picking one
           which would mask a worker bug.

        3. If only `person_names` is set, derive
           `person_name = person_names[0]` so the iter-216 SQLite
           write path + every search-by-name code path keeps working
           without each consumer needing to also read `person_names`.

        4. If only `person_name` is set, leave `person_names = None`
           — old workers shouldn't get a synthetic single-element
           list inserted into their events. The UI normalizes via
           `event.person_names ?? (event.person_name ? [event.person_name] : null)`.
        """
        if self.person_names is not None:
            for name in self.person_names:
                if not isinstance(name, str) or not name:
                    raise ValueError(
                        "person_names entries must be non-empty strings",
                    )
                if len(name) > 64:
                    raise ValueError(
                        "person_names entries must be <= 64 chars",
                    )
            if self.person_name is None and self.person_names:
                # Bypass model_config frozen-ness via __dict__ assignment;
                # post-validation mutation is the standard Pydantic v2
                # idiom inside model_validator(mode="after").
                object.__setattr__(self, "person_name", self.person_names[0])
            elif (
                self.person_name is not None
                and self.person_names
                and self.person_names[0] != self.person_name
            ):
                raise ValueError(
                    "person_name must equal person_names[0] when both are set",
                )
        if self.start_ts is not None and self.end_ts is not None:
            if self.end_ts < self.start_ts:
                raise ValueError("end_ts must be greater than or equal to start_ts")
        return self


class VisitFinalizedPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")
    event_id: str = Field(pattern=r"^[A-Za-z0-9_-]+$", max_length=128)
    duration_s: float = Field(ge=0.0, le=3600.0)
    start_ts: float | None = Field(default=None, gt=0)
    end_ts: float | None = Field(default=None, gt=0)


class SignalPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str = Field(pattern=r"^[A-Za-z0-9_-]{1,128}$")
    source: Literal["audio", "doorbell", "tamper", "system"]
    label: str = Field(pattern=r"^[a-z0-9_]{1,64}$")
    score: float = Field(ge=0.0, le=1.0)
    camera_id: str = Field(default="front_door", pattern=r"^[a-z0-9_]{1,32}$")
    observed_at: float = Field(gt=0)
    duration_s: float = Field(default=0.0, ge=0.0, le=60.0)
    correlation_id: str = Field(pattern=r"^[A-Za-z0-9_-]{1,128}$")

    @model_validator(mode="after")
    def _known_label(self) -> "SignalPayload":
        audio = {
            "audio_smoke_alarm", "audio_glass_break",
            "audio_scream", "audio_dog_bark",
        }
        by_source = {
            "audio": audio,
            "doorbell": {"doorbell"},
            "tamper": {
                "camera_covered", "camera_moved", "camera_blurred", "camera_frozen"
            },
            "system": {"power_loss", "network_outage", "camera_offline", "tamper"},
        }
        allowed = by_source[self.source]
        if self.label not in allowed:
            raise ValueError("label is not valid for source")
        if not math.isfinite(self.observed_at):
            raise ValueError("observed_at must be finite")
        if abs(time.time() - self.observed_at) > 300.0:
            raise ValueError("observed_at must be within 5 minutes of server time")
        return self


class LiveDetectionPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")
    boxes: list[Box] = Field(default_factory=list, max_length=32)
    camera_id: str = Field(default="front_door", pattern=r"^[a-z0-9_]{1,32}$")


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
            dropped_unknown: list = []
            dropped_coerce: list = []
            for k, v in data.items():
                if k not in _ALLOWED_METRIC_FIELDS:
                    dropped_unknown.append(k)
                    continue
                coerced = _coerce_metric(k, v)
                if coerced is not None:
                    picked[k] = coerced
                else:
                    dropped_coerce.append(k)
            if dropped_unknown or dropped_coerce:
                # logging-plan §2: surface metric drops once per process
                # so a worker emitting an off-whitelist or wrong-typed
                # field is diagnosable. DEBUG + once-flag — this is a
                # 10 s hot path (CLAUDE.md `_SuppressNoisyAccess`).
                global _heartbeat_drop_warned
                if not _heartbeat_drop_warned:
                    _heartbeat_drop_warned = True
                    log.debug(
                        "heartbeat dropped metric fields: "
                        "unknown=%s wrong-type/out-of-bounds=%s "
                        "(further drops suppressed)",
                        dropped_unknown or None,
                        dropped_coerce or None,
                    )
            if picked:
                metrics = picked
    worker_health.heartbeat(metrics)
    return {"ok": True}


@router.post("/client_log")
async def client_log(entry: ClientLog) -> dict:
    """Sink for PWA-side logs (docs/logging_plan.md §1.3).

    The browser logger (`client/src/lib/log.ts`) POSTs error+warn lines
    here so device-side failures the operator can't physically inspect
    land in the Jetson journald stream with a `client_log:` prefix.

    Unauthenticated by design (mounted on `_internal`) so it works on
    the anon login screen. App-level rate cap drops past
    `_CLIENT_LOG_MAX_PER_WINDOW` lines per `_CLIENT_LOG_WINDOW_S` so a
    looping client can't flood the journal — the cap-hit itself is
    logged once per window so the throttling is visible.
    """
    import time as _t

    now = _t.monotonic()
    if now - _client_log_bucket["ts"] >= _CLIENT_LOG_WINDOW_S:
        _client_log_bucket["ts"] = now
        _client_log_bucket["count"] = 0
    _client_log_bucket["count"] += 1
    if _client_log_bucket["count"] > _CLIENT_LOG_MAX_PER_WINDOW:
        if _client_log_bucket["count"] == _CLIENT_LOG_MAX_PER_WINDOW + 1:
            log.warning(
                "client_log rate cap hit (%d/%.0fs) — dropping further "
                "client logs this window",
                _CLIENT_LOG_MAX_PER_WINDOW,
                _CLIENT_LOG_WINDOW_S,
            )
        return {"ok": False, "dropped": "rate"}
    level = _CLIENT_LOG_LEVELS.get(entry.level, logging.INFO)
    log.log(
        level,
        "client_log:%s fields=%s online=%s ua=%s",
        entry.event,
        entry.fields or {},
        entry.online,
        (entry.ua or "")[:120],
    )
    return {"ok": True}


@router.post("/recording-assurance")
async def recording_assurance_result(payload: RecordingAssurancePayload) -> dict:
    """Persist the host canary result and notify only on state transitions."""
    body = payload.model_dump()
    try:
        transition = await asyncio.to_thread(recording_assurance.record, body)
    except Exception:
        log.exception("recording assurance result persist failed")
        raise HTTPException(status_code=503, detail="could not persist recording check")

    if transition is not None:
        if transition == "failed":
            notification = {
                "title": "Recording check failed",
                "body": _assurance_reason_copy(payload.reason),
                "tag": "recording-assurance",
                "url": "/settings?tab=system",
                "importance": "high",
            }
        else:
            notification = {
                "title": "Recording recovered",
                "body": "A fresh camera sample recorded, decoded, and cleaned successfully.",
                "tag": "recording-assurance",
                "url": "/settings?tab=system",
                "silent": True,
            }
        task = asyncio.create_task(push_service.send_all(notification))
        _BACKGROUND_TASKS.add(task)
        task.add_done_callback(_make_push_done_callback("recording-assurance"))
    log_method = log.info if payload.status == "ok" else log.warning
    log_method(
        "recording assurance result status=%s stage=%s reason=%s bytes=%s",
        payload.status,
        payload.stage,
        payload.reason,
        payload.sample_bytes,
    )
    return {"ok": True, "transition": transition}


@router.post("/push-receipt", status_code=202)
async def push_receipt(payload: PushReceiptPayload) -> dict:
    """Accept a one-use capability after the service worker shows a push.

    Always return the same response so this unauthenticated internal endpoint
    cannot be used as a receipt-token oracle. Invalid, expired, and replayed
    capabilities make no state change.
    """
    try:
        await asyncio.to_thread(
            push_assurance.accept,
            payload.receipt_id,
            payload.shown,
        )
    except Exception:
        log.exception("push receipt persistence failed")
    return {"ok": True}


def _assurance_reason_copy(reason: str) -> str:
    return {
        "storage_unavailable": "Capture storage could not be opened.",
        "storage_read_only": "Capture storage became read-only.",
        "storage_not_writable": "Capture storage rejected a verified write.",
        "capture_timeout": "The camera stream did not produce a sample in time.",
        "capture_failed": "The camera stream could not be recorded.",
        "capture_empty": "The camera produced an empty recording.",
        "decode_timeout": "The test recording could not be decoded in time.",
        "decode_failed": "The test recording was not playable.",
        "cleanup_failed": "A test recording artifact could not be removed.",
        "event_decode_timeout": "A recent event video took too long to verify.",
        "event_decode_failed": "A recent event video is present but not playable.",
    }.get(reason, "The recording pipeline check failed.")


@router.post("/live_detection")
async def publish_live_detection(payload: LiveDetectionPayload) -> dict[str, object]:
    worker_health.heartbeat()
    if not detection_service.active:
        return {"ok": True, "dropped": "detection paused"}
    await event_bus.publish_live(
        {
            "v": 1,
            "type": "live_detection",
            "ts": time.time(),
            "camera_id": payload.camera_id,
            "boxes": [b.model_dump() for b in payload.boxes],
        }
    )
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
        # logging-plan §2: surface the drop at DEBUG. The worker runs
        # continuously and keeps POSTing while the UI "Detect" toggle is
        # off; we drop here rather than fan out. Logging confirms WHY no
        # events reach the bus / push when detection is paused (the
        # "healthy but zero events" footgun). DEBUG, not WARN — this is
        # an intended, operator-driven state, and the route is hit at
        # the worker's emit rate (hot path).
        log.debug(
            "event dropped: detection paused (label=%s camera_id=%s)",
            payload.label, payload.camera_id,
        )
        return {"ok": True, "dropped": "detection paused"}

    evt = make_detection_event(
        label=payload.label,
        score=payload.score,
        boxes=[b.model_dump() for b in payload.boxes],
        camera_id=payload.camera_id,
        thumb_url=payload.thumb_url,
        person_name=payload.person_name,
        person_names=payload.person_names,
        clip_url=payload.clip_url,
        event_id=payload.id,
        source=payload.source,
        rule_id=payload.rule_id,
        rule_name=payload.rule_name,
        correlation_id=payload.correlation_id,
        related_event_id=payload.related_event_id,
        visit_id=payload.visit_id,
        start_ts=payload.start_ts,
        end_ts=payload.end_ts,
        package_state=payload.package_state,
    )
    await event_bus.publish(evt)
    _schedule_security_processing(evt)

    # Fan out to push subscriptions in the background so the worker's POST
    # returns quickly. webpush is synchronous and goes over the network; we
    # don't want detection latency tied to Apple/Google push servers.
    # iter-176: hold a strong reference until the task completes so Python's
    # GC can't collect it mid-flight (CPython issue #44665).
    # Continuation opens (continuous-capture cap-splits) skip the push
    # fanout entirely: the person was already announced when their visit
    # opened; re-notifying every max_visit_s window is spam. Row + WS
    # broadcast above still happen (the clip is real, the timeline shows it).
    if payload.continuation:
        log.info(
            "push suppressed for continuation event %s (camera_id=%s)",
            payload.id, payload.camera_id,
        )
    else:
        task = asyncio.create_task(_send_push(evt))
        _BACKGROUND_TASKS.add(task)
        # logging-plan §2: the done-callback must check `task.exception()`.
        # `_send_push` catches its own send failures, but ANY other escape
        # (a bug, a CancelledError, an exception raised before the inner
        # try) would otherwise be swallowed — asyncio only surfaces it as an
        # unattributed "Task exception was never retrieved" at GC time. The
        # callback retrieves it and logs with the event id so a fanout crash
        # is never silent. Carry the event id via a closure since the
        # callback only receives the Task.
        task.add_done_callback(_make_push_done_callback(evt.get("id")))

    return {"ok": True, "event_id": evt["id"]}


_SIGNAL_RATE: dict[tuple[str, str], list[float]] = {}
_SIGNAL_RATE_LOCK = asyncio.Lock()


@router.post("/signal")
async def publish_signal(payload: SignalPayload) -> dict[str, object]:
    """Ingest an audio/system signal with retry-idempotent fanout."""
    cfg = detection_config.get()
    if not cfg.enabled:
        return {"ok": True, "dropped": "detection paused"}
    if cfg.operating_mode == "privacy":
        return {"ok": True, "dropped": "privacy mode"}
    if camera_registry.get(payload.camera_id) is None:
        raise HTTPException(status_code=422, detail="unknown camera_id")
    if payload.source == "audio":
        if not cfg.audio_event_enabled:
            return {"ok": True, "dropped": "audio events disabled"}
        if payload.label not in cfg.audio_event_labels:
            return {"ok": True, "dropped": "audio label disabled"}

    from ..services import events_db

    duplicate = await asyncio.to_thread(
        events_db.get_by_ids, settings.events_db_path, [payload.id]
    )
    if duplicate:
        return {"ok": True, "event_id": payload.id, "duplicate": True}

    # At most 30 signals per source/camera per minute. Stable retry IDs are
    # deduplicated below and do not consume additional fanout, but the rate
    # bound also protects SQLite from floods of distinct attacker IDs.
    now = time.monotonic()
    key = (payload.source, payload.camera_id)
    async with _SIGNAL_RATE_LOCK:
        recent = [stamp for stamp in _SIGNAL_RATE.get(key, []) if now - stamp < 60.0]
        if len(recent) >= 30:
            raise HTTPException(status_code=429, detail="signal rate limit exceeded")
        recent.append(now)
        _SIGNAL_RATE[key] = recent

    evt = make_detection_event(
        label=payload.label,
        score=payload.score,
        boxes=[],
        camera_id=payload.camera_id,
        event_id=payload.id,
        ts=payload.observed_at,
        source=payload.source,
        correlation_id=payload.correlation_id,
        start_ts=payload.observed_at,
        end_ts=payload.observed_at + payload.duration_s,
    )
    try:
        inserted = await event_bus.publish_once(evt)
    except Exception:
        log.exception("signal persistence failed (id=%s source=%s)", payload.id, payload.source)
        raise HTTPException(status_code=503, detail="signal store unavailable")
    if not inserted:
        return {"ok": True, "event_id": payload.id, "duplicate": True}
    _schedule_security_processing(evt)
    task = asyncio.create_task(_send_push(evt))
    _BACKGROUND_TASKS.add(task)
    task.add_done_callback(_make_push_done_callback(payload.id))
    return {"ok": True, "event_id": payload.id, "duplicate": False}


@router.post("/event/finalized")
async def publish_visit_finalized(payload: VisitFinalizedPayload) -> dict[str, object]:
    """Update the opening visit notification once its clip is playable."""
    from ..services import events_db

    rows = await asyncio.to_thread(
        events_db.get_by_ids, settings.events_db_path, [payload.event_id]
    )
    if not rows:
        return {"ok": True, "dropped": "event missing"}
    event = rows[0]
    start_ts = payload.start_ts or event.get("start_ts") or event.get("ts")
    end_ts = payload.end_ts or (float(start_ts) + payload.duration_s)
    await asyncio.to_thread(
        events_db.update_event_timing,
        settings.events_db_path,
        payload.event_id,
        start_ts=float(start_ts),
        end_ts=float(end_ts),
    )
    minutes, seconds = divmod(int(round(payload.duration_s)), 60)
    duration = "{}:{:02d}".format(minutes, seconds)
    decision = decide_alert(event, detection_config.get().operating_mode)
    push_payload = {
        "title": "Visit recorded",
        "body": "{} clip is ready".format(duration),
        "tag": "visit:{}".format(payload.event_id),
        "url": "/events",
        "event_id": payload.event_id,
        "importance": decision.importance,
        # This updates an alert already delivered; do not make a second sound.
        "silent": True,
        "require_interaction": decision.require_interaction,
        "notification_kind": "visit_ready",
        "actions": ["view", "protect"],
    }
    task = asyncio.create_task(push_service.send_matching(event, push_payload))
    _BACKGROUND_TASKS.add(task)
    task.add_done_callback(_make_push_done_callback(payload.event_id))
    return {
        "ok": True,
        "event_id": payload.event_id,
        "duration_s": payload.duration_s,
        "start_ts": float(start_ts),
        "end_ts": float(end_ts),
    }


def _schedule_security_processing(evt: dict) -> None:
    """Run package tracking and automations after canonical publication."""
    from ..services.security_automation import process_canonical_event

    task = asyncio.create_task(process_canonical_event(evt))
    _BACKGROUND_TASKS.add(task)

    def _done(done: asyncio.Task) -> None:
        _BACKGROUND_TASKS.discard(done)
        if done.cancelled():
            return
        exc = done.exception()
        if exc is not None:
            log.error(
                "security event processing failed (event_id=%s): %s",
                evt.get("id"), exc, exc_info=exc,
            )

    task.add_done_callback(_done)


def _make_push_done_callback(event_id):
    """Build the done-callback for a `_send_push` task (logging-plan §2).

    Discards the task from the strong-ref set (iter-176 invariant) AND
    retrieves `task.exception()` so a fanout crash that escaped
    `_send_push`'s own try/except is logged with the event id instead of
    surfacing as an unattributed asyncio warning at GC time."""

    def _done(task: "asyncio.Task") -> None:
        _BACKGROUND_TASKS.discard(task)
        if task.cancelled():
            log.warning("push fanout task cancelled (event_id=%s)", event_id)
            return
        exc = task.exception()
        if exc is not None:
            log.error(
                "push fanout task crashed (event_id=%s): %s",
                event_id, exc, exc_info=exc,
            )

    return _done


def _notification_actions(evt: dict) -> list[str]:
    """Return the two most useful safe lock-screen action codes."""
    cfg = detection_config.get()
    if (
        (evt.get("source") == "doorbell" or evt.get("label") == "doorbell")
        and cfg.audio_enabled
    ):
        return ["view", "talk"]
    if evt.get("package_state") or str(evt.get("label", "")).startswith("package_"):
        return ["view", "protect"]
    # Physical deterrence is never a lock-screen action: it requires an
    # owner foreground confirmation and a fresh capability check.
    return ["view", "mark_seen"]


async def _send_push(evt: dict) -> None:
    """Build a Web Push notification payload from the event dict +
    fan it out via `send_matching` (iter-206, Feature #4 slice 2).
    Switched from the old `payload: DetectionPayload + send_all`
    signature so subscription-level filters can be evaluated against
    the canonical event fields (`camera_id`, `person_name`)."""
    # When the worker matched a known face, surface the name in the
    # notification title — "Israel detected" reads better than "Person
    # detected" on the lock-screen.
    #
    # iter-357 (multi-person face-recog): when several known faces
    # were matched in the same event, the lock-screen title fans
    # out as "Israel & Sheenal detected" (2 names) or "Israel +2
    # others detected" (3+ names) — preserves the iter-188
    # name-first scanability without overflowing the lock-screen
    # title cap on Android (~65 chars). The legacy single-person
    # path is unchanged when `person_names` is absent or has only
    # one entry.
    person_name = evt.get("person_name")
    person_names = evt.get("person_names") or []
    label = evt.get("label", "")
    score = float(evt.get("score", 0.0))
    if person_name:
        from ..services.security_store import security_store

        preference = security_store.read()["face_preferences"].get(person_name)
        alerts_enabled = not (
            preference == "none"
            or isinstance(preference, dict) and preference.get("alerts_enabled") is False
        )
        if not alerts_enabled:
            log.info("push suppressed by face preference (event_id=%s)", evt.get("id"))
            return
    decision = decide_alert(evt, detection_config.get().operating_mode)
    if decision.importance == "suppressed":
        log.info(
            "push suppressed by alert policy (event_id=%s reason=%s)",
            evt.get("id"), decision.reason,
        )
        return
    if person_names and len(person_names) > 1:
        if len(person_names) == 2:
            who = "{} & {}".format(
                person_names[0].title(), person_names[1].title(),
            )
        else:
            who = "{} +{} others".format(
                person_names[0].title(), len(person_names) - 1,
            )
        title = "{} detected".format(who)
    elif person_name:
        title = "{} detected".format(person_name.title())
    else:
        title = "{} detected".format(label.title())
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
    # docs/multicam_contract.md: with ONE configured camera the body
    # stays byte-identical to the pre-multicam copy ("Front Door ·
    # NN%" — pinned by test_internal.py). With >1 cameras the copy
    # uses the event camera's display name so a lock-screen glance
    # answers WHERE; an event carrying an id the registry doesn't know
    # falls back to the raw id (still more informative than a wrong
    # "Front Door").
    if camera_registry.multi():
        camera_label = (
            camera_registry.name_for(evt.get("camera_id"))
            or str(evt.get("camera_id") or "Front Door")
        )
    else:
        camera_label = "Front Door"
    push_payload: dict[str, object] = {
        "title": title,
        "body": "{} · {}%".format(camera_label, int(score * 100)),
        # Stable visit tag means a later clip-ready/final-summary push updates
        # this notification instead of stacking another alert for one visit.
        "tag": "visit:{}".format(evt.get("id")),
        "url": "/events",
        "importance": decision.importance,
        "reason": decision.reason,
        "require_interaction": decision.require_interaction,
        "silent": decision.silent,
        # iter-276 (widget-usability-auditor C1 server side): include
        # the event id so the SW push handler can use it as the
        # Notification.tag, preventing detection bursts from silently
        # collapsing into one notification on the user's lock screen.
        # Worker generates the id pre-emit (iter-247) so it's always
        # present on the bus payload.
        "event_id": evt.get("id"),
        "notification_kind": (
            "package"
            if evt.get("package_state")
            else "audio_alert"
            if evt.get("source") == "audio"
            else "doorbell"
            if evt.get("source") == "doorbell"
            else "tamper"
            if evt.get("source") == "tamper"
            else "system_alert"
            if evt.get("source") == "system"
            else "detection"
        ),
        "actions": _notification_actions(evt),
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
        # logging-plan §2: include the event id; push delivery still
        # proceeds (the count is a best-effort badge refresh).
        log.warning(
            "unread_count refresh for push payload failed (event_id=%s)",
            evt.get("id"),
            exc_info=True,
        )
    try:
        # iter-206: send_matching evaluates each sub's filters against
        # the event before fanning out. Legacy subs (filters=None)
        # match all events — preserves iter-188 hero flow + iter-141
        # test-push behavior for unfiltered subs.
        await push_service.send_matching(evt, push_payload)
    except Exception:
        # logging-plan §2: include the event id so a push-fanout failure
        # is traceable to the specific detection event.
        log.exception(
            "push send failed in _internal/event (event_id=%s)",
            evt.get("id"),
        )
