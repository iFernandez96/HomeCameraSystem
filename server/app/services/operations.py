"""Durable operator workflows built on the private security store.

This module deliberately consumes existing event, detection, recording and
assurance state. It does not open the camera, run an AI model, or create a
second retention/automation engine.
"""
from __future__ import annotations

import asyncio
import hashlib
import ipaddress
import json
import logging
import os
import shutil
import time
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from ..config import settings
from ..log import RateLimitedLog
from . import events_db, recording_assurance, recording_jobs, recording_service
from .detection_config import detection_config
from .health import worker_health
from .security_store import security_store


PROFILE_TO_MODE = {
    "home": "home",
    "away": "away",
    "sleep": "night",
    "vacation": "away",
    "privacy": "privacy",
}
MODE_TO_PROFILE = {
    "home": "home",
    "away": "away",
    "night": "sleep",
    "privacy": "privacy",
}
_MAX_NOTIFICATIONS = 300
_MAX_SAVED_SEARCHES_PER_USER = 20
_MAX_HEALTH_SAMPLES = 7 * 24 * 4  # seven days at fifteen-minute cadence
_SEARCH_WINDOWS: dict[str, list[float]] = {}
log = logging.getLogger(__name__)
_failure_gate = RateLimitedLog(300.0)


def _ops(state: dict[str, Any]) -> dict[str, Any]:
    value = state.get("operations")
    if not isinstance(value, dict):
        value = {}
        state["operations"] = value
    defaults = {
        "active_profile": "home",
        "mode_schedules": [],
        "last_mode_schedule_key": None,
        "notifications": [],
        "snoozes": {},
        "saved_searches": {},
        "health_history": [],
        "archive": {},
        "semantic_companion": {},
    }
    for key, default in defaults.items():
        if key not in value or not isinstance(value[key], type(default)):
            value[key] = default
    archive_defaults = {
        "enabled": False, "last_sync_ts": None, "last_status": "not_configured",
        "last_error": None, "files_verified": 0, "bytes_verified": 0,
    }
    companion_defaults = {
        "enabled": False, "base_url": "", "api_token": "",
        "last_check_ts": None, "last_status": "not_configured",
    }
    for key, default in archive_defaults.items():
        value["archive"].setdefault(key, default)
    for key, default in companion_defaults.items():
        value["semantic_companion"].setdefault(key, default)
    return value


def public_state(username: str) -> dict[str, Any]:
    state = security_store.read()
    ops = _ops(state)
    companion = ops["semantic_companion"]
    archive = dict(ops["archive"])
    archive.update(archive_capability())
    effective_mode = detection_config.get().operating_mode
    active_profile = ops["active_profile"]
    if PROFILE_TO_MODE.get(active_profile) != effective_mode:
        active_profile = MODE_TO_PROFILE.get(effective_mode, "home")
    return {
        "v": 1,
        "active_profile": active_profile,
        "effective_mode": effective_mode,
        "mode_schedules": list(ops["mode_schedules"]),
        "archive": archive,
        "semantic_companion": {
            "enabled": companion.get("enabled") is True,
            "base_url": companion.get("base_url") or "",
            "token_set": bool(companion.get("api_token")),
            "last_check_ts": companion.get("last_check_ts"),
            "last_status": companion.get("last_status") or "not_configured",
        },
        "saved_searches": list_saved_searches(username),
    }


def apply_profile(profile: str, actor: str, now: float | None = None) -> dict[str, Any]:
    if profile not in PROFILE_TO_MODE:
        raise ValueError("unsupported profile")
    now = time.time() if now is None else now
    previous_mode = detection_config.get().operating_mode
    detection_config.update(operating_mode=PROFILE_TO_MODE[profile])

    def _apply(state: dict[str, Any]) -> dict[str, Any]:
        ops = _ops(state)
        ops["active_profile"] = profile
        ops["profile_changed_at"] = now
        ops["profile_changed_by"] = actor
        return {
            "active_profile": profile,
            "effective_mode": PROFILE_TO_MODE[profile],
            "changed_at": now,
        }

    try:
        return security_store.transact(_apply)
    except Exception:
        # Keep the two durable stores coherent if the private-state write
        # fails after the detection config was updated.
        detection_config.update(operating_mode=previous_mode)
        raise


def note_external_mode(mode: str, actor: str, now: float | None = None) -> None:
    """Reconcile an explicit mode selection made outside Control Center."""
    profile = MODE_TO_PROFILE.get(mode)
    if profile is None:
        return
    now = time.time() if now is None else now
    def _note(state: dict[str, Any]) -> None:
        ops = _ops(state)
        ops["active_profile"] = profile
        ops["profile_changed_at"] = now
        ops["profile_changed_by"] = actor
    security_store.transact(_note)


def replace_mode_schedules(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    def _replace(state: dict[str, Any]) -> list[dict[str, Any]]:
        _ops(state)["mode_schedules"] = rows
        return rows
    return security_store.transact(_replace)


def run_mode_schedule(now: float | None = None) -> bool:
    now = time.time() if now is None else now
    local = datetime.fromtimestamp(now)
    state = security_store.read()
    ops = _ops(state)

    # A mode changed through the older Detection panel is authoritative. Make
    # the profile state converge before evaluating Vacation's sticky guard.
    effective_mode = detection_config.get().operating_mode
    active_profile = ops.get("active_profile")
    if PROFILE_TO_MODE.get(active_profile) != effective_mode:
        active_profile = MODE_TO_PROFILE.get(effective_mode, "home")
        def _reconcile(state_value: dict[str, Any]) -> None:
            current = _ops(state_value)
            current["active_profile"] = active_profile
            current["profile_changed_at"] = now
            current["profile_changed_by"] = "external_mode_change"
        security_store.transact(_reconcile)
        ops = _ops(security_store.read())

    # Vacation is deliberately sticky: ordinary daily schedules resume only
    # after an owner explicitly selects another profile.
    if ops.get("active_profile") == "vacation":
        return False

    candidates: list[tuple[float, int, dict[str, Any]]] = []
    for index, row in enumerate(ops["mode_schedules"]):
        if not isinstance(row, dict) or row.get("enabled") is not True:
            continue
        if row.get("profile") not in PROFILE_TO_MODE:
            continue
        try:
            hour, minute = (int(part) for part in str(row.get("time")).split(":"))
        except (TypeError, ValueError):
            continue
        for days_ago in range(8):
            candidate_day = (local - timedelta(days=days_ago)).date()
            if candidate_day.weekday() not in row.get("days", []):
                continue
            occurrence = datetime.combine(
                candidate_day, datetime.min.time()
            ).replace(hour=hour, minute=minute).timestamp()
            if occurrence <= now:
                candidates.append((occurrence, index, row))
                break
    if not candidates:
        return False
    occurrence, _index, row = max(candidates, key=lambda item: (item[0], item[1]))
    # A manual selection made after the scheduled occurrence wins. This also
    # prevents boot catch-up from undoing a deliberate mode change.
    if float(ops.get("profile_changed_at") or 0.0) >= occurrence:
        return False
    occurrence_local = datetime.fromtimestamp(occurrence)
    key = "{}:{}".format(occurrence_local.strftime("%Y-%m-%dT%H:%M"), row.get("id"))
    if ops.get("last_mode_schedule_key") == key:
        return False
    apply_profile(str(row["profile"]), "schedule", occurrence)

    def _mark(state_value: dict[str, Any]) -> None:
        _ops(state_value)["last_mode_schedule_key"] = key
    security_store.transact(_mark)
    return True


def _notification_kind(payload: dict[str, Any]) -> str:
    value = payload.get("notification_kind") or payload.get("tag") or "event"
    return str(value)[:64]


def _is_snoozed(ops: dict[str, Any], username: str, kind: str, now: float) -> bool:
    user = ops["snoozes"].get(username)
    if not isinstance(user, dict):
        return False
    until = user.get(kind)
    return isinstance(until, (int, float)) and float(until) > now


def _notification_url(value: Any) -> str:
    url = str(value or "/events")[:256]
    if not url.startswith("/") or url.startswith("//"):
        return "/events"
    return url


def prepare_notification(
    payload: dict[str, Any],
    subs: list[dict[str, Any]],
    gateway_available: bool,
    intended_users: list[str] | None = None,
) -> tuple[str, list[dict[str, Any]]]:
    """Create one per-user inbox row and return non-snoozed subscriptions."""
    notification_id = uuid.uuid4().hex
    now = time.time()
    kind = _notification_kind(payload)
    users = sorted({
        str(sub.get("user_id")) for sub in subs
        if isinstance(sub.get("user_id"), str) and sub.get("user_id")
    } | {
        username for username in (intended_users or [])
        if isinstance(username, str) and username
    })
    # Legacy/unit-test subscriptions without an owning user still receive
    # push normally; there is no safe principal under which to file an inbox
    # row, and forcing a private-state write here would invent ownership.
    if not users:
        return notification_id, subs

    def _prepare(state: dict[str, Any]) -> list[str]:
        ops = _ops(state)
        for username in users:
            snoozed = _is_snoozed(ops, username, kind, now)
            ops["notifications"].append({
                "id": notification_id,
                "username": username,
                "created_ts": now,
                "title": str(payload.get("title") or "Home Camera")[:120],
                "body": str(payload.get("body") or "New activity")[:500],
                "kind": kind,
                "event_id": payload.get("event_id") if isinstance(payload.get("event_id"), str) else None,
                "url": _notification_url(payload.get("url")),
                "importance": str(payload.get("importance") or "normal")[:16],
                "seen": False,
                "delivery_state": (
                    "snoozed" if snoozed else "queued"
                    if gateway_available and any(sub.get("user_id") == username for sub in subs)
                    else "gateway_unavailable"
                ),
                "displayed_ts": None,
                "delivery_total": sum(1 for sub in subs if sub.get("user_id") == username),
                "gateway_accepted_count": 0,
                "gateway_failed_count": 0,
                "displayed_count": 0,
                "display_failed_count": 0,
            })
        ops["notifications"] = ops["notifications"][-_MAX_NOTIFICATIONS:]
        return [username for username in users if not _is_snoozed(ops, username, kind, now)]

    deliverable_users = set(security_store.transact(_prepare))
    return notification_id, [
        sub for sub in subs if sub.get("user_id") in deliverable_users
    ]


def mark_gateway(notification_id: str, username: str | None, delivered: bool) -> None:
    if not username:
        return
    def _mark(state: dict[str, Any]) -> None:
        for row in reversed(_ops(state)["notifications"]):
            if row.get("id") == notification_id and row.get("username") == username:
                current = row.get("delivery_state")
                count_key = "gateway_accepted_count" if delivered else "gateway_failed_count"
                row[count_key] = int(row.get(count_key) or 0) + 1
                if current != "displayed" and (
                    delivered or current != "gateway_accepted"
                ):
                    row["delivery_state"] = "gateway_accepted" if delivered else "gateway_failed"
                break
    security_store.transact(_mark)


def mark_displayed(notification_id: str | None, username: str | None, shown: bool, now: float) -> None:
    if not notification_id or not username:
        return
    def _mark(state: dict[str, Any]) -> None:
        for row in reversed(_ops(state)["notifications"]):
            if row.get("id") == notification_id and row.get("username") == username:
                count_key = "displayed_count" if shown else "display_failed_count"
                row[count_key] = int(row.get(count_key) or 0) + 1
                if shown or row.get("delivery_state") != "displayed":
                    row["delivery_state"] = "displayed" if shown else "display_failed"
                    row["displayed_ts"] = now if shown else None
                break
    security_store.transact(_mark)


def list_notifications(username: str, limit: int = 100) -> list[dict[str, Any]]:
    rows = _ops(security_store.read())["notifications"]
    return [dict(row) for row in reversed(rows) if row.get("username") == username][
        :limit
    ]


def mark_notification_seen(username: str, notification_id: str) -> bool:
    def _mark(state: dict[str, Any]) -> bool:
        for row in _ops(state)["notifications"]:
            if row.get("username") == username and row.get("id") == notification_id:
                row["seen"] = True
                return True
        return False
    return security_store.transact(_mark)


def snooze(username: str, kind: str, duration_s: int, now: float | None = None) -> float:
    now = time.time() if now is None else now
    until = now + duration_s
    def _set(state: dict[str, Any]) -> float:
        ops = _ops(state)
        user = ops["snoozes"].setdefault(username, {})
        user[kind] = until
        return until
    return security_store.transact(_set)


def list_saved_searches(username: str) -> list[dict[str, Any]]:
    rows = _ops(security_store.read())["saved_searches"]
    return sorted(
        [dict(row) for row in rows.values() if row.get("username") == username],
        key=lambda row: (str(row.get("name", "")).casefold(), str(row.get("id", ""))),
    )


def save_search(username: str, name: str, query: str, semantic: bool) -> dict[str, Any]:
    now = time.time()
    def _save(state: dict[str, Any]) -> dict[str, Any]:
        rows = _ops(state)["saved_searches"]
        owned = [row for row in rows.values() if row.get("username") == username]
        if len(owned) >= _MAX_SAVED_SEARCHES_PER_USER:
            raise OverflowError
        row = {
            "id": uuid.uuid4().hex,
            "username": username,
            "name": name,
            "query": query,
            "semantic": semantic,
            "created_ts": now,
        }
        rows[row["id"]] = row
        return row
    return security_store.transact(_save)


def delete_saved_search(username: str, search_id: str) -> bool:
    def _delete(state: dict[str, Any]) -> bool:
        rows = _ops(state)["saved_searches"]
        row = rows.get(search_id)
        if not isinstance(row, dict) or row.get("username") != username:
            return False
        del rows[search_id]
        return True
    return security_store.transact(_delete)


def build_briefing(day: str) -> dict[str, Any]:
    digest = events_db.daily_digest(settings.events_db_path, day)
    assurance = recording_assurance.status()
    state = security_store.read()
    outages = state.get("outages", {}).get("history", [])
    day_start = datetime.strptime(day, "%Y-%m-%d").timestamp()
    day_end = (datetime.strptime(day, "%Y-%m-%d") + timedelta(days=1)).timestamp()
    day_outages = []
    for row in outages:
        if not isinstance(row, dict):
            continue
        started = row.get("start_ts")
        if not isinstance(started, (int, float)):
            continue
        ended = row.get("end_ts")
        end_value = float(ended) if isinstance(ended, (int, float)) else time.time()
        if float(started) < day_end and end_value >= day_start:
            day_outages.append(row)
    protected = events_db.retention_summary(settings.events_db_path)
    event_ids = events_db.event_ids_for_day(settings.events_db_path, day)
    video_counts = {name: 0 for name in ("available", "processing", "failed", "unknown")}
    for status in recording_service.clip_statuses(event_ids).values():
        bucket = "processing" if status in {"recording", "finalizing"} else status
        video_counts[bucket if bucket in video_counts else "unknown"] += 1
    headline = "No recorded activity"
    if digest["total"]:
        headline = "{} event{} · {} unknown person sighting{}".format(
            digest["total"], "" if digest["total"] == 1 else "s",
            digest["unknown_people"], "" if digest["unknown_people"] == 1 else "s",
        )
    return {
        **digest,
        "headline": headline,
        "recording_state": assurance["state"],
        "video_counts": video_counts,
        "camera_interruptions": len(day_outages),
        "protected_events": protected["protected_total"],
        "generated_ts": time.time(),
    }


def sample_health(now: float | None = None) -> dict[str, Any]:
    now = time.time() if now is None else now
    alive, last_seen, metrics = worker_health.snapshot()
    try:
        free_bytes = shutil.disk_usage(str(settings.recordings_dir)).free
    except OSError:
        free_bytes = None
    sample = {
        "ts": now,
        "worker_alive": alive,
        "worker_last_seen_s": last_seen,
        "fps": metrics.get("fps") if metrics else None,
        "camera_quality_status": metrics.get("camera_quality_status") if metrics else None,
        "camera_luma": metrics.get("camera_luma") if metrics else None,
        "camera_sharpness": metrics.get("camera_sharpness") if metrics else None,
        "power_watts": metrics.get("power_watts") if metrics else None,
        "disk_free_bytes": free_bytes,
        "recording_state": recording_assurance.status(now=now)["state"],
    }
    def _save(state: dict[str, Any]) -> dict[str, Any]:
        rows = _ops(state)["health_history"]
        rows.append(sample)
        del rows[:-_MAX_HEALTH_SAMPLES]
        return sample
    return security_store.transact(_save)


def storage_guardian() -> dict[str, Any]:
    """Return an honest verdict for the filesystem that owns recordings."""
    proof = recording_assurance.status()
    storage = proof.get("storage") if isinstance(proof.get("storage"), dict) else {}
    reasons = []
    filesystem = storage.get("filesystem")
    mountpoint = storage.get("mountpoint")
    device = storage.get("device")
    if filesystem not in (None, "ext4"):
        reasons.append("recordings are not on the expected ext4 filesystem")
    if mountpoint == "/":
        reasons.append("recordings are on the Jetson root filesystem instead of the USB mount")
    if mountpoint is None:
        reasons.append("the recordings mountpoint has not been independently confirmed")
    if device is None:
        reasons.append("the recordings block device has not been independently confirmed")
    if storage.get("writable") is False:
        reasons.append("the recordings filesystem rejected a write and fsync probe")
    if storage.get("read_only") is True:
        reasons.append("the recordings filesystem is mounted read-only")
    if storage.get("smart_status") == "failed":
        reasons.append("the storage device reported a SMART health failure")
    if proof.get("state") in ("failed", "stale", "unknown"):
        reasons.append("the end-to-end recording proof is not currently healthy")
    try:
        usage = shutil.disk_usage(str(settings.recordings_dir))
        free_bytes = usage.free
        total_bytes = usage.total
    except OSError:
        free_bytes = None
        total_bytes = None
        reasons.append("the recordings path is unavailable")
    return {
        "state": "healthy" if not reasons else "degraded",
        "recordings_path": str(settings.recordings_dir),
        "filesystem": filesystem,
        "mountpoint": mountpoint,
        "device": device,
        "writable": storage.get("writable"),
        "read_only": storage.get("read_only"),
        "smart_status": storage.get("smart_status"),
        "write_probe_ms": storage.get("write_probe_ms"),
        "free_bytes": free_bytes,
        "total_bytes": total_bytes,
        "reasons": reasons,
        "checked_at": proof.get("checked_at"),
    }


def recording_integrity() -> dict[str, Any]:
    recording_jobs.reconcile_recent(validate_limit=3)
    jobs = recording_jobs.summary()
    assurance = recording_assurance.status()
    storage = storage_guardian()
    alerts = []
    if storage["state"] != "healthy":
        alerts.append({
            "id": "recording_storage", "severity": "critical",
            "title": "Recording is not safely writing to USB storage",
            "detail": "; ".join(storage["reasons"]) or "The recordings path is unavailable.",
        })
    if jobs["windows"]["all"]["stuck_jobs"]:
        alerts.append({
            "id": "recording_stuck", "severity": "critical",
            "title": "An event video is stuck",
            "detail": "At least one recording has made no progress for over five minutes.",
        })
    if jobs["invalid_videos"]:
        alerts.append({
            "id": "invalid_video_24h", "severity": "warning",
            "title": "A video failed validation in the last 24 hours",
            "detail": "Open the failed event below for its exact capture and processing reason.",
        })
    if assurance.get("state") in ("failed", "stale", "unknown"):
        alerts.append({
            "id": "recording_assurance", "severity": "warning",
            "title": "The end-to-end camera proof is not current",
            "detail": str(assurance.get("reason") or "Run the end-to-end camera test."),
        })
    if not worker_health.is_alive():
        alerts.append({
            "id": "detection_worker", "severity": "critical",
            "title": "Detection is offline",
            "detail": "Live video may still work, but events and alerts are not being produced.",
        })
    return {
        **jobs,
        "recent_failures": recording_jobs.recent_failures(),
        "storage": storage,
        "assurance": assurance,
        "alerts": alerts,
    }


def health_history(hours: int, now: float | None = None) -> list[dict[str, Any]]:
    now = time.time() if now is None else now
    cutoff = now - hours * 3600
    return [
        dict(row) for row in _ops(security_store.read())["health_history"]
        if isinstance(row, dict)
        and isinstance(row.get("ts"), (int, float))
        and float(row["ts"]) >= cutoff
    ]


def _archive_capability() -> dict[str, Any]:
    root = settings.external_archive_dir
    marker = root / ".homecam-external-archive"
    reason = None
    target_device = None
    try:
        if root.is_symlink() or not root.is_dir():
            reason = "target_not_mounted"
        elif not marker.is_file() or marker.is_symlink():
            reason = "marker_missing"
        else:
            target_device = _filesystem_device(root)
            if target_device == _filesystem_device(settings.recordings_dir):
                reason = "same_filesystem_as_recordings"
    except OSError:
        reason = "target_unavailable"
    return {
        "target": str(root),
        "available": reason is None,
        "unavailable_reason": reason,
        "target_device": target_device,
        "marker_required": ".homecam-external-archive",
    }


def archive_capability() -> dict[str, Any]:
    value = _archive_capability()
    value.pop("target_device", None)
    return value


def _filesystem_device(path: Path) -> int:
    return path.stat().st_dev


def set_archive_enabled(enabled: bool) -> dict[str, Any]:
    if enabled and not _archive_capability()["available"]:
        raise FileNotFoundError("independent archive target is not safely mounted")
    def _set(state: dict[str, Any]) -> dict[str, Any]:
        row = _ops(state)["archive"]
        row["enabled"] = enabled
        return dict(row)
    return security_store.transact(_set)


def _hash(path: Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def sync_archive() -> dict[str, Any]:
    capability = _archive_capability()
    if not capability["available"]:
        raise FileNotFoundError("independent archive target is not mounted and marked")
    expected_device = capability["target_device"]
    root = settings.external_archive_dir / "protected-events"
    temp_manifest = root / ".manifest.json.tmp"
    try:
        root.mkdir(parents=True, exist_ok=True, mode=0o700)
        manifest = []
        total = 0
        for event_id in sorted(events_db.protected_event_ids(settings.events_db_path)):
            current = _archive_capability()
            if not current["available"] or current["target_device"] != expected_device:
                raise OSError("independent archive target changed during sync")
            source = recording_service.clip_path(event_id)
            if source is None or not source.is_file():
                continue
            digest = _hash(source)
            target = root / (event_id + ".mp4")
            if not target.is_file() or _hash(target) != digest:
                temp = target.with_suffix(".mp4.tmp")
                try:
                    shutil.copy2(source, temp)
                    if _hash(temp) != digest:
                        raise OSError("archive copy checksum mismatch")
                    with temp.open("rb") as handle:
                        os.fsync(handle.fileno())
                    current = _archive_capability()
                    if not current["available"] or current["target_device"] != expected_device:
                        raise OSError("independent archive target changed during copy")
                    os.replace(temp, target)
                    target.chmod(0o600)
                finally:
                    temp.unlink(missing_ok=True)
            size = target.stat().st_size
            total += size
            manifest.append({"event_id": event_id, "sha256": digest, "bytes": size})
        body = json.dumps({"v": 1, "created_ts": time.time(), "files": manifest}, indent=2, sort_keys=True).encode()
        with temp_manifest.open("wb") as handle:
            handle.write(body)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_manifest, root / "manifest.json")
        (root / "manifest.json").chmod(0o600)
        directory_fd = os.open(str(root), os.O_RDONLY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    except Exception as exc:
        temp_manifest.unlink(missing_ok=True)
        now = time.time()
        def _failed(state: dict[str, Any]) -> None:
            row = _ops(state)["archive"]
            row.update({"last_sync_ts": now, "last_status": "failed", "last_error": str(exc)[:200]})
        security_store.transact(_failed)
        raise
    now = time.time()
    def _record(state: dict[str, Any]) -> dict[str, Any]:
        row = _ops(state)["archive"]
        row.update({
            "last_sync_ts": now, "last_status": "verified", "last_error": None,
            "files_verified": len(manifest), "bytes_verified": total,
        })
        return dict(row)
    return security_store.transact(_record)


def configure_companion(enabled: bool, base_url: str, api_token: str | None) -> dict[str, Any]:
    normalized = base_url.strip().rstrip("/")
    if enabled:
        parsed = urlparse(normalized)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname:
            raise ValueError("companion URL must be HTTP(S)")
        if parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in {"", "/"}:
            raise ValueError("companion URL must be only a private origin")
        try:
            address = ipaddress.ip_address(parsed.hostname)
        except ValueError as exc:
            raise ValueError("companion must use a private IP literal") from exc
        if not (address.is_private or address.is_loopback):
            raise ValueError("companion must stay on the private network")
    def _set(state: dict[str, Any]) -> dict[str, Any]:
        row = _ops(state)["semantic_companion"]
        row["enabled"] = enabled
        row["base_url"] = normalized
        if api_token is not None:
            row["api_token"] = api_token
        return {
            "enabled": enabled, "base_url": normalized,
            "token_set": bool(row.get("api_token")),
            "last_check_ts": row.get("last_check_ts"),
            "last_status": row.get("last_status") or "not_configured",
        }
    return security_store.transact(_set)


def _consume_search_quota(username: str, now: float) -> None:
    rows = [value for value in _SEARCH_WINDOWS.get(username, []) if now - value < 60]
    if len(rows) >= 10:
        raise OverflowError
    rows.append(now)
    _SEARCH_WINDOWS[username] = rows


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _open_companion(request: urllib.request.Request):
    return urllib.request.build_opener(_NoRedirect).open(request, timeout=10)


def companion_search(username: str, query: str, limit: int) -> list[dict[str, Any]]:
    now = time.time()
    _consume_search_quota(username, now)
    state = security_store.read()
    row = _ops(state)["semantic_companion"]
    if row.get("enabled") is not True or not row.get("base_url"):
        raise RuntimeError("semantic companion is disabled")
    body = json.dumps({"query": query, "limit": limit}).encode()
    headers = {"Content-Type": "application/json", "User-Agent": "HomeCam/1"}
    if row.get("api_token"):
        headers["Authorization"] = "Bearer " + str(row["api_token"])
    request = urllib.request.Request(
        str(row["base_url"]) + "/v1/search", data=body, headers=headers, method="POST"
    )
    with _open_companion(request) as response:
        if response.status < 200 or response.status >= 300:
            raise RuntimeError("companion search failed")
        payload = json.loads(response.read(128 * 1024))
    ids = payload.get("event_ids") if isinstance(payload, dict) else None
    if not isinstance(ids, list):
        raise RuntimeError("companion returned an invalid response")
    safe_ids = [value for value in ids[:limit] if isinstance(value, str) and len(value) <= 128]
    result = events_db.get_by_ids(settings.events_db_path, safe_ids)
    def _healthy(state_value: dict[str, Any]) -> None:
        companion = _ops(state_value)["semantic_companion"]
        companion["last_check_ts"] = time.time()
        companion["last_status"] = "ready"
    security_store.transact(_healthy)
    return result


async def run(stop: asyncio.Event) -> None:
    last_health = 0.0
    last_archive = 0.0
    last_recording_reconcile = 0.0
    while not stop.is_set():
        now = time.time()
        try:
            await asyncio.to_thread(run_mode_schedule, now)
            if now - last_health >= 900:
                await asyncio.to_thread(sample_health, now)
                last_health = now
            if now - last_recording_reconcile >= 30:
                await asyncio.to_thread(
                    recording_jobs.reconcile_recent,
                    validate_limit=1,
                    now=now,
                )
                last_recording_reconcile = now
            archive = _ops(security_store.read())["archive"]
            archive_interval = 6 * 3600 if archive.get("last_status") == "verified" else 900
            if archive.get("enabled") is True and now - last_archive >= archive_interval:
                try:
                    await asyncio.to_thread(sync_archive)
                except Exception as exc:
                    def _failed(state: dict[str, Any]) -> None:
                        row = _ops(state)["archive"]
                        row.update({"last_sync_ts": now, "last_status": "failed", "last_error": str(exc)[:200]})
                    security_store.transact(_failed)
                last_archive = now
        except Exception:
            if _failure_gate.should_log():
                log.exception("operations scheduler failed; retrying on next tick")
        try:
            await asyncio.wait_for(stop.wait(), timeout=30)
        except asyncio.TimeoutError:
            pass
