from __future__ import annotations

import asyncio
import hashlib
import logging
import time
from dataclasses import asdict
from uuid import uuid4
from typing import Annotated

from fastapi import APIRouter, Body, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field

from pathlib import Path

from ..auth.dependencies import get_current_user, require_role
from ..config import settings
from ..services.camera import camera_service
from ..services.detection import detection_service
from ..services.detection_config import (
    ABSENCE_FINALIZE_MAX,
    ABSENCE_FINALIZE_MIN,
    CLASS_NAME_MAX,
    CLIP_POST_ROLL_MAX,
    CLIP_POST_ROLL_MIN,
    CLIP_PRE_ROLL_MAX,
    CLIP_PRE_ROLL_MIN,
    COOLDOWN_MAX,
    COOLDOWN_MIN,
    FACE_CAPTURE_RETENTION_MAX,
    FACE_CAPTURE_RETENTION_MIN,
    MAX_VISIT_MAX,
    MAX_VISIT_MIN,
    HHMM_PATTERN,
    THRESHOLD_MAX,
    THRESHOLD_MIN,
    ZONE_VERTICES_MAX,
    ZONE_VERTICES_MIN,
    ZONES_MAX,
    detection_config,
)
from ..services import ota_orchestrator as ota_orchestrator_module
from ..services import ota_rollback as ota_rollback_module
from ..services import audit_db, host_bridge
from ..services.backup_orchestrator import (
    BackupOrchestratorRequest,
    orchestrate_backup,
)
from ..services.backup_restore import (
    MaintenanceLock,
    RestoreOrchestratorRequest,
    restore_api_response_from_orchestrator,
)
from ..services.ota_ledger import append_event
from ..services.ota_manifest import read_local_manifest
from ..services.ota_orchestrator import OtaApplyRequest, orchestrate_ota_apply
from ..services.health import worker_health

router = APIRouter()
log = logging.getLogger(__name__)
_BACKUP_RESTORE_LOCK = MaintenanceLock()


_ClassName = Annotated[str, Field(min_length=1, max_length=CLASS_NAME_MAX)]

# iter-191 (Feature #5): polygon mask types. A polygon is a list of
# [x, y] points with normalized coords. Pydantic v2 nests Annotated
# constraints so each layer enforces its own bound — the route
# returns a structured 422 instead of dropping silently. The service
# layer (`_valid_zones`) is the second line of defense for disk-load
# (manually-edited `detection_config.json`).
_Coord = Annotated[float, Field(ge=0.0, le=1.0)]
_Point = Annotated[list[_Coord], Field(min_length=2, max_length=2)]
_Polygon = Annotated[
    list[_Point],
    Field(min_length=ZONE_VERTICES_MIN, max_length=ZONE_VERTICES_MAX),
]


class DetectionConfigPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")
    threshold: float | None = Field(default=None, ge=THRESHOLD_MIN, le=THRESHOLD_MAX)
    cooldown_s: float | None = Field(default=None, ge=COOLDOWN_MIN, le=COOLDOWN_MAX)
    enabled: bool | None = None
    schedule_off_start: str | None = Field(default=None, pattern=HHMM_PATTERN)
    schedule_off_end: str | None = Field(default=None, pattern=HHMM_PATTERN)
    # Per-element bound caps individual class names (longest real COCO
    # label is "kitchen scissors" at 16 chars; 64 is generous defense).
    # Without it, `classes: list[str]` only bounds the LIST length —
    # `["x" * 1_000_000]` would still pass.
    classes: list[_ClassName] | None = Field(default=None, max_length=30)
    zones: list[_Polygon] | None = Field(default=None, max_length=ZONES_MAX)
    # iter-254: per-event clip duration. Post-roll is live-tunable
    # via the iter-244 unauth config-poll the worker reads.
    # iter-257: bound here is the absolute ceiling (week preset's
    # 30 min). The active per-preset cap is enforced server-side in
    # `DetectionConfigStore.update()` — that's where the cap actually
    # binds, since the user is allowed to switch presets before
    # picking the duration.
    clip_post_roll_s: float | None = Field(
        default=None, ge=CLIP_POST_ROLL_MIN, le=CLIP_POST_ROLL_MAX
    )
    clip_pre_roll_s: float | None = Field(
        default=None, ge=CLIP_PRE_ROLL_MIN, le=CLIP_PRE_ROLL_MAX
    )
    # iter-257: retention/clip-cap preset. Three discrete tiers —
    # "week" / "month" / "year_5". The store's update() path
    # clamps clip_post_roll_s and clip_pre_roll_s to the new
    # preset's caps in the same patch.
    clip_retention_preset: str | None = Field(default=None, pattern=r"^(week|month|year_5)$")
    # iter-305 (user "How do I know which cam is which? Right now,
    # I only have 1 camera, but it is not labeled at all"): friendly
    # display name for the camera. min_length=1 rejects whitespace-
    # only / empty (the service also fall-backs to default in that
    # case as defense in depth).
    camera_label: str | None = Field(default=None, min_length=1, max_length=32)
    # iter-308: two-way audio gating. Owner-only flip; UI affordances
    # stay disabled with "Soon" caption until this is true.
    audio_enabled: bool | None = None
    # iter-356.62 slice 3 (privacy controls): operator opt-out for
    # the face/person capture write-path. The worker reads this via
    # /api/_internal/detection/config and skips the JPEG + sidecar
    # write entirely when false.
    face_capture_enabled: bool | None = None
    face_capture_retention_days: int | None = Field(
        default=None,
        ge=FACE_CAPTURE_RETENTION_MIN,
        le=FACE_CAPTURE_RETENTION_MAX,
    )
    # Continuous-capture (visit) feature — Slice 5. The worker reads
    # these off the unauth config-poll. Feature defaults OFF.
    continuous_capture: bool | None = None
    # Hard cap on a single visit's duration (s).
    max_visit_s: float | None = Field(
        default=None, ge=MAX_VISIT_MIN, le=MAX_VISIT_MAX
    )
    # Post-roll grace after the subject leaves before finalize. NEW
    # field (plan R3) — distinct from the deprecated clip_post_roll_s.
    absence_finalize_s: float | None = Field(
        default=None, ge=ABSENCE_FINALIZE_MIN, le=ABSENCE_FINALIZE_MAX
    )


class _ConfirmBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    confirm: bool


class _RecoverBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    action: str = Field(pattern=r"^(mediamtx|nvargus|reboot)$")
    confirm: bool


_LOG_UNITS = ("homecam-detect", "mediamtx", "nvargus-daemon", "homecam-server")


def _require_confirm(confirm: bool) -> None:
    if not confirm:
        raise HTTPException(status_code=400, detail="confirm must be true")


def _audit_host_action_requested(action: str, request_id: str, username: str) -> None:
    try:
        audit_db.insert_host_action_event(
            settings.audit_db_path,
            ts=time.time(),
            username=username,
            action=action,
            request_id=request_id,
            phase="requested",
            status=None,
            detail=None,
        )
    except Exception:
        log.warning(
            "host_action request audit failed for action=%s id=%s",
            action,
            request_id,
            exc_info=True,
        )


def _audit_log_request(request_id: str, username: str, unit: str) -> None:
    try:
        audit_db.insert_host_action_event(
            settings.audit_db_path,
            ts=time.time(),
            username=username,
            action="logs",
            request_id=request_id,
            phase="requested",
            status=None,
            detail="unit={}".format(unit),
        )
    except Exception:
        log.warning(
            "host log request audit failed for unit=%s id=%s",
            unit,
            request_id,
            exc_info=True,
        )


def _recover_note(action: str, alive: bool) -> str:
    labels = {
        "mediamtx": "Camera feed restart",
        "nvargus": "Camera daemon reset",
        "reboot": "Reboot",
    }
    label = labels.get(action, "Recovery action")
    if alive:
        if action == "reboot":
            return "Reboot queued. The Jetson will go down shortly."
        return "{} queued.".format(label)
    return (
        "{} queued, but the detection worker is offline; it will run when "
        "the worker reconnects or expire in 2 minutes."
    ).format(label)


def _recover_response(rec: dict, action: str) -> dict[str, object]:
    alive = worker_health.is_alive()
    return {
        "ok": True,
        "request_id": rec["id"],
        "status": rec["status"],
        "worker_online": alive,
        "note": _recover_note(action, alive),
    }


@router.post("/capture")
async def capture() -> dict[str, str]:
    snap = await camera_service.capture()
    if snap is None:
        raise HTTPException(status_code=503, detail="camera not ready")
    return {"url": f"/snapshots/{snap.name}"}


@router.post("/detection/toggle")
async def toggle_detection() -> dict[str, bool]:
    await detection_service.toggle()
    return {"active": detection_service.active}


@router.get("/detection/config")
async def get_detection_config() -> dict[str, object]:
    # Returning `dict[str, float]` (the previous shape) made FastAPI coerce
    # the new `enabled: bool` field to 1.0 / 0.0 in the response. Use
    # `dict[str, object]` so bool stays bool over the wire.
    return asdict(detection_config.get())


@router.patch(
    "/detection/config",
    dependencies=[Depends(require_role("owner"))],
)
async def patch_detection_config(payload: DetectionConfigPatch) -> dict[str, object]:
    # iter-197 (Feature #3 slice 3): owner-only. Detection settings
    # (threshold / cooldown / classes / zones / schedule) affect the
    # whole household — family/viewer users see the feed but don't
    # change config. Legacy `admin` users pass the gate via the
    # iter-197 transitional carve-out in `require_role`.
    # exclude_unset preserves the "not provided" vs "explicit null"
    # distinction — schedule fields can be cleared by sending `null`.
    patch = payload.model_dump(exclude_unset=True)
    if not patch:
        raise HTTPException(
            status_code=422, detail="at least one field must be provided"
        )
    # Audit which config knobs an owner changed. Log the KEY SET only —
    # never the values (zones carry coordinate geometry, classes/labels
    # are operator PII-adjacent). Sorted for stable grep.
    log.info("detection config patch: keys=%s", sorted(patch.keys()))
    try:
        new = detection_config.update(**patch)
    except Exception:
        # The store may warn-and-return internally on a persist failure,
        # but a hard exception here means the patch was rejected/lost.
        # Surface WHY before re-raising so the 500 isn't opaque.
        log.exception(
            "detection config update failed: keys=%s", sorted(patch.keys())
        )
        raise
    return asdict(new)


@router.post(
    "/system/reboot",
    dependencies=[Depends(require_role("owner"))],
)
async def system_reboot(
    body: _ConfirmBody,
    user: str = Depends(get_current_user),
) -> dict[str, object]:
    # iter-197 (Feature #3 slice 3): owner-only — Charter-most-
    # destructive operation. A stray family-account user shouldn't
    # be able to reboot the Jetson via the Settings button.
    _require_confirm(body.confirm)
    rec = host_bridge.enqueue("reboot", {}, requested_by=user, now=time.time())
    _audit_host_action_requested(rec["kind"], rec["id"], user)
    log.warning("reboot queued through host bridge request_id=%s", rec["id"])
    return _recover_response(rec, rec["kind"])


@router.post(
    "/system/recover",
    dependencies=[Depends(require_role("owner"))],
)
async def system_recover(
    body: _RecoverBody,
    user: str = Depends(get_current_user),
) -> dict[str, object]:
    _require_confirm(body.confirm)
    rec = host_bridge.enqueue(body.action, {}, requested_by=user, now=time.time())
    _audit_host_action_requested(rec["kind"], rec["id"], user)
    log.warning(
        "host recovery queued action=%s request_id=%s", rec["kind"], rec["id"]
    )
    return _recover_response(rec, rec["kind"])


@router.get(
    "/system/recover/status",
    dependencies=[Depends(require_role("owner"))],
)
async def system_recover_status(
    request_id: str | None = Query(default=None, min_length=1, max_length=128),
) -> dict[str, object]:
    rec = host_bridge.get(request_id) if request_id else host_bridge.latest()
    if rec is None:
        return {"status": "none", "worker_online": worker_health.is_alive()}
    return {
        "request_id": rec["id"],
        "action": rec["kind"],
        "status": rec["status"],
        "detail": rec.get("detail"),
        "requested_by": rec.get("requested_by"),
        "requested_at": rec.get("requested_at"),
        "result_at": rec.get("result_at"),
        "worker_online": worker_health.is_alive(),
    }


@router.get(
    "/system/logs",
    dependencies=[Depends(require_role("owner"))],
)
async def system_logs(
    unit: Annotated[
        str,
        Query(pattern=r"^(homecam-detect|mediamtx|nvargus-daemon|homecam-server)$"),
    ],
    since: Annotated[str | None, Query(max_length=64)] = None,
    lines: int = 200,
    user: str = Depends(get_current_user),
) -> dict[str, object]:
    # The worker scrubs secrets before returning lines. The route still keeps
    # request args bounded so logs cannot become a bulk data exfil path.
    if unit not in _LOG_UNITS:
        raise HTTPException(status_code=422, detail="unsupported log unit")
    bounded_lines = max(1, min(int(lines or 200), 1000))
    rec = host_bridge.enqueue(
        "logs",
        {"unit": unit, "since": since, "lines": bounded_lines},
        requested_by=user,
        now=time.time(),
    )
    _audit_log_request(rec["id"], user, unit)
    return {
        "request_id": rec["id"],
        "status": rec["status"],
        "worker_online": worker_health.is_alive(),
    }


@router.get(
    "/system/logs/result",
    dependencies=[Depends(require_role("owner"))],
)
async def system_logs_result(
    request_id: Annotated[str, Query(min_length=1, max_length=128)],
) -> dict[str, object]:
    rec = host_bridge.get(request_id)
    if rec is None or rec.get("kind") != "logs":
        raise HTTPException(status_code=404, detail="log request not found")
    result = rec.get("result") if isinstance(rec.get("result"), dict) else None
    args = rec.get("args") if isinstance(rec.get("args"), dict) else {}
    lines = result.get("lines") if result and isinstance(result.get("lines"), list) else None
    return {
        "request_id": rec["id"],
        "unit": args.get("unit"),
        "status": rec["status"],
        "lines": lines,
        "detail": rec.get("detail"),
    }


# iter-210 (Feature #10 slice 1): operator-triggered backup. Owner-
# only, mirrors the iter-197 reboot scaffold pattern (return `note`
# when the host-helper isn't wired so the UI can show "stubbed"
# instead of pretending success). The eventual host-helper will
# rsync push_subs.json + VAPID keys + users.db + detection_config
# .json + zones to a configured target (USB drive, NAS share,
# rsync.net, etc.) — operator action when the stack is deployed.
@router.post(
    "/system/backup",
    dependencies=[Depends(require_role("owner"))],
)
async def system_backup() -> dict[str, object]:
    attempt_id = f"route-{uuid4()}"
    return orchestrate_backup(
        BackupOrchestratorRequest(
            attempt_id=attempt_id,
            target_dir=settings.backup_target_dir,
            ledger_path=settings.backup_ledger_path,
            app_version=settings.version,
            settings_obj=settings,
        ),
        maintenance_lock=_BACKUP_RESTORE_LOCK,
    )


# iter-212 (Feature #10 slice 3): restore from a backup archive.
# Body is `{"backup_path": "<filename>"}`. Two-tier path validation:
#   1. Pydantic regex rejects shell metas, leading slashes, and
#      `..` segments at parse time (422 before service layer).
#   2. Service-layer `Path.resolve().relative_to(target_root)` MUST
#      succeed — same shape as the iter-? SPA traversal-guard in
#      `main.py`. Belt-and-braces: a regex alone could miss exotic
#      payloads (NTFS short names, unicode normalization quirks,
#      symlinks under target_root). The resolve+relative_to pair
#      is the security-critical check; the regex is the friendlier
#      422 for the common typo case.
# The eventual host-helper (slice 4) does the actual file restoration
# under maintenance mode (server stops accepting requests, atomic
# replace, restart). For now: stub-with-note like backup.
_BACKUP_PATH_PATTERN = r"^[A-Za-z0-9_./-]+$"


class _RestoreBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    # `..` substring banned at the Pydantic layer to keep the 422
    # path obvious for the common case. The resolve+relative_to
    # check below is the actual security guarantee.
    backup_path: str = Field(
        min_length=1,
        max_length=255,
        pattern=_BACKUP_PATH_PATTERN,
    )


@router.post(
    "/system/restore",
    dependencies=[Depends(require_role("owner"))],
)
async def system_restore(body: _RestoreBody) -> dict[str, object]:
    # Belt-and-braces tier 2: even with the regex passing, resolve
    # the path against the configured target dir and require it to
    # land UNDER that root. Catches `..` smuggled in via symlinks,
    # absolute paths the regex didn't trip on, etc.
    if ".." in body.backup_path:
        # Security event: an owner-authed caller (or a compromised
        # owner credential on the tailnet) tried to smuggle a parent-dir
        # traversal past the Pydantic regex. Log the rejected raw value
        # (it's just a path fragment, not a secret) so the operator can
        # spot probing in journald.
        log.warning(
            "restore rejected: '..' in backup_path %r", body.backup_path
        )
        raise HTTPException(
            status_code=400,
            detail="backup_path may not contain '..'",
        )
    target_root = settings.backup_target_dir.resolve()
    try:
        candidate = (target_root / body.backup_path).resolve()
        candidate.relative_to(target_root)
    except (ValueError, OSError) as e:
        log.warning(
            "restore rejected: backup_path %r escapes target root: %s",
            body.backup_path, e,
        )
        raise HTTPException(
            status_code=400,
            detail="backup_path must resolve under the configured backup target",
        )
    log.warning("restore requested for %s", candidate)
    attempt_id = f"route-{uuid4()}"
    return restore_api_response_from_orchestrator(
        RestoreOrchestratorRequest(
            filename=str(Path(body.backup_path)),
            backup_target_dir=settings.backup_target_dir,
            current_app_version=settings.version,
            current_schema_version=None,
            restore_roots={
                "users_db": settings.users_db_path.parent,
                "jwt_secret": settings.jwt_secret_path.parent,
                "vapid_private_key": settings.vapid_private_key_path.parent,
                "vapid_public_key": settings.vapid_public_key_path.parent,
                "push_subs": settings.push_subs_path.parent,
                "detection_config": settings.detection_config_path.parent,
            },
            required_roles=[
                "users_db",
                "jwt_secret",
                "vapid_private_key",
                "vapid_public_key",
            ],
            staging_parent=settings.backup_target_dir / ".restore-staging",
            backup_parent=settings.backup_target_dir / ".pre-restore",
            ledger_id=attempt_id,
            restart_command=None,
            ledger_path=settings.backup_ledger_path,
        ),
        maintenance_lock=_BACKUP_RESTORE_LOCK,
    )


# iter-213 (Feature #8 slice 1): daily-timelapse trigger + listing.
# Stub-with-note pattern until the slice 2 host-side ffmpeg helper
# is wired (operator action — see feature_8_state.md). The eventual
# helper will: read all snapshots written that day → re-encode at
# ~30 fps → write `<date>.mp4` to settings.timelapses_dir → which is
# already StaticFiles-mounted at /timelapses by main.py.
_DATE_PATTERN = r"^[0-9]{4}-[01][0-9]-[0-3][0-9]$"


class _TimelapseBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    # YYYY-MM-DD. Strict ISO calendar date — no whitespace, no
    # timezone. Server interprets as local-day (matches detection
    # event timestamp localtime semantics throughout the rest of
    # the stack).
    date: str = Field(min_length=10, max_length=10, pattern=_DATE_PATTERN)


# Timelapse builds run in the BACKGROUND (a busy day = 300+ clips / ~1 GB /
# multiple minutes of ffmpeg on the Nano — awaiting it inline blocked the
# HTTP request until the browser/proxy timed out, so big days "failed" even
# when the build would have succeeded). The POST kicks off the build and
# returns instantly with `building: true`; the client polls
# GET /system/timelapse/status?date=… until ready/error. The service writes
# to a `.tmp` sidecar and atomic-renames, so the GET /api/timelapses route
# never sees a partial.
#
# `_TIMELAPSE_STATUS[date] = {building, ready, error}` is the poll source.
# `_TIMELAPSE_TASKS` holds strong refs so the GC can't collect an in-flight
# build mid-run (CPython #44665, same pattern as _internal._BACKGROUND_TASKS).
_TIMELAPSE_STATUS: dict[str, dict] = {}
_TIMELAPSE_TASKS: set[asyncio.Task] = set()


async def _notify_timelapse_done(
    user: str | None, date: str, ok: bool, reason: str | None
) -> None:
    """Web-Push the user who requested a build when it finishes — success OR
    failure — so they hear about it even if they've closed the app (the
    in-app status poll only fires while the Settings tab is open).

    Best-effort: a push failure (no VAPID key, no registered devices, network)
    must NEVER affect the build outcome or the status the client polls — hence
    the broad catch. Targets ONLY the requester's devices (send_to_user)."""
    if not user:
        return
    if ok:
        payload = {
            "title": "Timelapse ready",
            "body": "Your {0} day video is ready to watch.".format(date),
            "tag": "timelapse:{0}".format(date),
            "url": "/settings",
        }
    else:
        payload = {
            "title": "Timelapse build failed",
            "body": reason or "Couldn't build your {0} day video.".format(date),
            "tag": "timelapse:{0}".format(date),
            "url": "/settings",
        }
    try:
        from ..services.push_service import push_service
        n = await push_service.send_to_user(user, payload)
        log.info("timelapse push for %s → %s: %d device(s)", date, user, n)
    except Exception:
        log.exception(
            "timelapse push notification failed for %s (requester=%s)",
            date, user,
        )


async def _run_timelapse_build(date: str, requested_by: str | None = None) -> None:
    """Background worker: build the day's timelapse, record the outcome in
    `_TIMELAPSE_STATUS` for the status endpoint, and Web-Push the requester
    (`requested_by`) when it finishes."""
    from ..services import timelapse as _timelapse_service
    ok = False
    reason = None  # human-readable failure reason, also the push body on fail
    try:
        result = await _timelapse_service.build_async(date)
        if result.ok:
            log.info("timelapse built for %s: %d clips", date, result.clip_count)
            _TIMELAPSE_STATUS[date] = {"building": False, "ready": True, "error": None}
            ok = True
        elif result.clip_count == 0:
            log.info("timelapse skipped for %s: no clips", date)
            reason = "No recorded events on that day yet — nothing to build."
            _TIMELAPSE_STATUS[date] = {
                "building": False, "ready": False, "error": reason,
            }
        else:
            log.warning("timelapse build failed for %s: %s", date, result.error)
            reason = "Couldn't build timelapse: {0}".format(
                result.error or "unknown error"
            )
            _TIMELAPSE_STATUS[date] = {
                "building": False, "ready": False, "error": reason,
            }
    except Exception:
        log.exception("timelapse background build crashed for %s", date)
        reason = "Timelapse build crashed — see server logs."
        _TIMELAPSE_STATUS[date] = {
            "building": False, "ready": False, "error": reason,
        }
    # Notify the requester last, after status is settled (best-effort).
    await _notify_timelapse_done(requested_by, date, ok, reason)


@router.post(
    "/system/timelapse",
    dependencies=[Depends(require_role("owner"))],
)
async def system_timelapse(
    body: _TimelapseBody,
    user: str = Depends(get_current_user),
) -> dict[str, object]:
    # `user` (the requester's username) is captured so the background build
    # can Web-Push THIS person when it finishes — the require_role("owner")
    # dependency above gates access; this resolves who to notify.
    expected_url = f"/api/timelapses/{body.date}.mp4"
    existing = _TIMELAPSE_STATUS.get(body.date)
    if existing is not None and existing.get("building"):
        # De-dupe: a build for this day is already running. Don't spawn a
        # second concurrent ffmpeg (they'd race on the same .tmp).
        return {
            "ok": True,
            "building": True,
            "date": body.date,
            "url": expected_url,
            "note": "Already building this day's video — it'll appear shortly.",
        }
    # Mark building SYNCHRONOUSLY (before create_task) so two rapid POSTs
    # can't both pass the guard above.
    _TIMELAPSE_STATUS[body.date] = {"building": True, "ready": False, "error": None}
    task = asyncio.create_task(_run_timelapse_build(body.date, user))
    _TIMELAPSE_TASKS.add(task)
    task.add_done_callback(_TIMELAPSE_TASKS.discard)
    log.info("timelapse build started (background) for %s", body.date)
    return {
        "ok": True,
        "building": True,
        "date": body.date,
        "url": expected_url,
        "note": "Building your day video — it'll appear here in a minute.",
    }


@router.get(
    "/system/timelapse/status",
    dependencies=[Depends(require_role("owner"))],
)
async def system_timelapse_status(
    date: Annotated[str, Query(min_length=10, max_length=10, pattern=_DATE_PATTERN)],
) -> dict[str, object]:
    """Poll target for the client. Reports {building, ready, error, url}.
    Falls back to on-disk existence when there's no in-memory record (server
    restarted mid/after a build, or it was built in a prior session)."""
    expected_url = f"/api/timelapses/{date}.mp4"
    st = _TIMELAPSE_STATUS.get(date)
    if st is None:
        exists = (settings.timelapses_dir / f"{date}.mp4").exists()
        return {
            "date": date,
            "building": False,
            "ready": exists,
            "error": None,
            "url": expected_url if exists else None,
        }
    return {
        "date": date,
        "building": st["building"],
        "ready": st["ready"],
        "error": st["error"],
        "url": expected_url if st["ready"] else None,
    }


class SystemUpdateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    version: str | None = Field(default=None, min_length=1)


def _ota_manifest_id() -> str | None:
    try:
        return hashlib.sha256(settings.ota_manifest_path.read_bytes()).hexdigest()
    except OSError:
        return None


def _ota_enriched_append_event(base_metadata: dict[str, object]):
    def _append(*args, metadata=None, status=None, reason=None, **kwargs):
        enriched = {**base_metadata, **(dict(metadata) if metadata else {})}
        if status == "applied":
            enriched["health_result"] = "restart_deferred"
        elif status == "rolled_back":
            enriched.setdefault("health_result", reason or "rollback")
        else:
            enriched.setdefault("health_result", "not_run")
        return append_event(
            *args,
            metadata=enriched,
            status=status,
            reason=reason,
            **kwargs,
        )

    return _append


def _ota_reject_version_mismatch(
    *,
    attempt_id: str,
    requested_version: str,
    manifest_version: str,
    metadata: dict[str, object],
) -> dict[str, object]:
    append_event(
        settings.ota_ledger_path,
        attempt_id=attempt_id,
        status="requested",
        metadata={**metadata, "requested_version": requested_version},
    )
    append_event(
        settings.ota_ledger_path,
        attempt_id=attempt_id,
        status="rejected",
        reason="requested_version_mismatch",
        metadata={
            **metadata,
            "requested_version": requested_version,
            "phase": "version_select",
            "version": manifest_version,
        },
    )
    return {
        "status": "rejected",
        "applied": False,
        "version": None,
        "ledger_id": None,
        "reason": "requested_version_mismatch",
        "phase": "version_select",
        "restart_required": False,
    }


# OTA artifact-bundle apply. Owner-only. Operators rsync the bundle into
# settings.ota_artifacts_dir and the manifest to settings.ota_manifest_path
# (defaults under /app/secrets/dist-ota in the existing persistent volume).
# The default restart runner only records the configured command; the actual
# service restart remains operator-side, so successful responses include
# restart_required=true.
@router.post(
    "/system/update",
    dependencies=[Depends(require_role("owner"))],
)
async def system_update(
    body: Annotated[SystemUpdateRequest | None, Body()] = None,
) -> dict[str, object]:
    attempt_id = f"route-{uuid4()}"
    manifest_result = read_local_manifest(settings.ota_manifest_path)
    manifest = manifest_result.manifest
    artifact_path = (
        settings.ota_artifacts_dir / manifest.artifact.name if manifest else None
    )
    artifact_size = (
        artifact_path.stat().st_size
        if artifact_path and artifact_path.exists()
        else 0
    )
    requested_version = body.version.strip() if body and body.version else None
    metadata: dict[str, object] = {
        "current_version": settings.version,
        "target_version": manifest.version if manifest else requested_version,
        "manifest_id": _ota_manifest_id(),
        "artifact_digest": manifest.artifact.sha256 if manifest else None,
        "strategy": "rsync-artifact",
    }

    if (
        manifest is not None
        and requested_version
        and requested_version != manifest.version
    ):
        return _ota_reject_version_mismatch(
            attempt_id=attempt_id,
            requested_version=requested_version,
            manifest_version=manifest.version,
            metadata=metadata,
        )

    request = OtaApplyRequest(
        attempt_id=attempt_id,
        manifest_path=settings.ota_manifest_path,
        artifacts_dir=settings.ota_artifacts_dir,
        staging_root=settings.ota_staging_root,
        persisted_data_dir=settings.ota_root.parent,
        client_dist_target=settings.ota_client_dist_target,
        active_pointer=settings.ota_active_pointer,
        ledger_path=settings.ota_ledger_path,
        current_version=settings.version,
        expected_artifact_size=artifact_size,
        restart_command=settings.ota_restart_command,
        env=None,
    )

    enriched_append = _ota_enriched_append_event(metadata)
    original_orchestrator_append = ota_orchestrator_module.append_event
    original_rollback_append = ota_rollback_module.append_event
    ota_orchestrator_module.append_event = enriched_append
    ota_rollback_module.append_event = enriched_append
    try:
        result = orchestrate_ota_apply(
            request,
            health_poller=lambda: {"ok": True, "status": "restart_deferred"},
        )
    finally:
        ota_orchestrator_module.append_event = original_orchestrator_append
        ota_rollback_module.append_event = original_rollback_append

    response = asdict(result)
    response["applied_components"] = list(result.applied_components)
    response["host_commands"] = list(result.host_commands)
    response["restart_required"] = bool(result.applied)
    if result.phase == "manifest_gate" and result.reason == "missing":
        response["note"] = "scaffold: update manifest is not present"
    return response


# iter-238 (Feature #10/12 follow-up): list available backup files
# in the configured backup target dir. Mirrors the iter-213
# `/api/system/timelapses` shape. Owner-only (same RBAC profile as
# the iter-210/212 backup/restore routes — listing the dir is a
# light disclosure, but keep it consistent). Used by the iter-239
# client UI to swap the iter-237 free-text Restore filename input
# for a dropdown of real files.
#
# Filename regex permissive — backups don't have a strict naming
# convention yet (operator slice 4 host-helper decides). Reject
# anything with slashes, whitespace, or shell metas; accept the
# common alphanum + dot/dash/underscore set. Subdirs ignored —
# operator drops backups flat in the target.
_BACKUP_FILENAME_PATTERN = r"^[A-Za-z0-9_.-]+$"


@router.get(
    "/system/backups",
    dependencies=[Depends(require_role("owner"))],
)
async def list_backups() -> dict[str, object]:
    import re as _re

    target = settings.backup_target_dir
    items: list[dict[str, object]] = []
    if not target.exists():
        # Empty dropdown here usually means the operator hasn't pointed
        # backup_target_dir at a real mount yet — a misconfig, not an
        # error. INFO so it's visible at default level without alarming.
        log.info("list backups: target dir does not exist: %s", target)
    else:
        try:
            children = list(target.iterdir())
        except OSError as e:
            # Dir exists but is unreadable (perms / unmounted mid-scan).
            # Distinct from "no dir" — this hides real backups behind an
            # empty dropdown, so WARN.
            log.warning("list backups: iterdir failed on %s: %s", target, e)
            children = []
        for child in children:
            if not child.is_file():
                continue
            name = child.name
            if not _re.match(_BACKUP_FILENAME_PATTERN, name):
                continue
            try:
                stat = child.stat()
            except OSError:
                continue
            items.append({
                "filename": name,
                "size_bytes": stat.st_size,
                "mtime_s": stat.st_mtime,
            })
    # Newest first by modification time. The iter-237 client form
    # uses this order to pre-select the most recent backup as the
    # default "rollback target" — matches the natural undo
    # affordance.
    items.sort(key=lambda x: x["mtime_s"], reverse=True)
    return {"items": items}


# iter-232 (Feature #12 OTA slice 3a): expose the server version so
# the iter-233 client UI can display it + the eventual slice 4
# host-helper can compare to a registry tag for "update available?"
# checks. Auth-gated to any authenticated role (informational; not
# destructive — viewer can read this same as `/api/status`).
@router.get("/system/version")
async def system_version(
    _user: str = Depends(get_current_user),
) -> dict[str, str]:
    return {"version": settings.version}


@router.get(
    "/system/timelapses",
    dependencies=[Depends(require_role("owner"))],
)
async def list_timelapses() -> dict[str, object]:
    # Scan settings.timelapses_dir for `<date>.mp4` files and
    # return a sorted list (newest first) for the client to render.
    # Empty list when no helper has run yet — distinguishable from
    # "endpoint missing" by the response shape (always returns
    # `{"items": [...]}`). Filename is the date; URL is the static-
    # file mount path. Server-side `re.match` filters out anything
    # that isn't strict YYYY-MM-DD.mp4 — defense against operator
    # dropping random files into the dir.
    import re as _re

    target = settings.timelapses_dir
    items: list[dict[str, object]] = []
    if not target.exists():
        log.info("list timelapses: target dir does not exist: %s", target)
    else:
        try:
            children = list(target.iterdir())
        except OSError as e:
            # Dir exists but unreadable — hides built timelapses behind an
            # empty list, so WARN (distinct from the benign no-dir case).
            log.warning("list timelapses: iterdir failed on %s: %s", target, e)
            children = []
        for child in children:
            if not child.is_file():
                continue
            name = child.name
            if not name.endswith(".mp4"):
                continue
            stem = name[:-4]
            if not _re.match(_DATE_PATTERN, stem):
                continue
            try:
                size = child.stat().st_size
            except OSError:
                continue
            # iter (timelapse de-overlap + timestamp overlay): the builder
            # writes a sibling `<date>.json` map of reel-offset → capture time
            # so the client can paint a wall-clock overlay. Expose its URL
            # when present; older reels built before this feature have none,
            # and the client degrades to no overlay.
            sidecar = target / f"{stem}.json"
            items.append({
                "date": stem,
                "url": f"/api/timelapses/{name}",
                "size_bytes": size,
                "manifest_url": (
                    f"/api/timelapses/{stem}.json" if sidecar.exists() else None
                ),
            })
    # Newest first by date — descending lexicographic on YYYY-MM-DD
    # IS chronological because the format sorts naturally.
    items.sort(key=lambda x: x["date"], reverse=True)
    return {"items": items}


@router.delete(
    "/system/timelapse",
    dependencies=[Depends(require_role("owner"))],
)
async def delete_timelapse(
    date: str = Query(
        ...,
        pattern=_DATE_PATTERN,
        description="YYYY-MM-DD — the timelapse file to delete",
    ),
) -> dict[str, object]:
    """iter-309 (user "add the ability to delete timelapsed
    videos"): owner-only single-file delete. Path is built from
    the regex-validated date so there's no traversal surface
    (filename pattern is `<date>.mp4`, settings.timelapses_dir is
    the only base dir).

    Returns `{"deleted": True}` on success, `{"deleted": False}`
    when the file didn't exist (soft 200, mirrors the iter-299
    event-delete contract — the UI can refresh either way).
    """
    target = settings.timelapses_dir / f"{date}.mp4"
    # Belt-and-braces traversal guard mirroring the iter-212
    # backup/restore pattern. Pydantic regex already validated
    # `date`, but resolve+relative_to is the actual security
    # guarantee against any future loosening of the regex.
    try:
        resolved = target.resolve()
        resolved.relative_to(settings.timelapses_dir.resolve())
    except (ValueError, OSError) as e:
        # The Pydantic date regex already validated `date`, so reaching
        # here is anomalous (regex loosening / symlink under the dir) —
        # treat as a security signal, WARN.
        log.warning(
            "timelapse delete rejected: path escape for date %r: %s", date, e
        )
        from fastapi import HTTPException
        raise HTTPException(status_code=400, detail="invalid path")
    if not resolved.exists():
        return {"deleted": False, "date": date}
    try:
        resolved.unlink()
    except OSError as e:
        log.warning("timelapse delete failed for %s: %s", date, e)
        from fastapi import HTTPException
        raise HTTPException(
            status_code=500, detail=f"could not delete: {e!r}",
        )
    # Best-effort: remove the sibling timestamp sidecar so a later rebuild
    # doesn't serve a stale offset→time map. A missing/failed sidecar unlink
    # never fails the delete (the reel — the thing the user asked to delete —
    # is already gone).
    sidecar = settings.timelapses_dir / f"{date}.json"
    try:
        sidecar.unlink()
    except OSError:
        pass
    log.info("timelapse deleted for %s", date)
    return {"deleted": True, "date": date}
