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
from datetime import datetime
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from ..config import settings
from ..log import RateLimitedLog
from . import events_db, recording_assurance, recording_service
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
    return {
        "v": 1,
        "active_profile": ops["active_profile"],
        "effective_mode": detection_config.get().operating_mode,
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

    return security_store.transact(_apply)


def replace_mode_schedules(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    def _replace(state: dict[str, Any]) -> list[dict[str, Any]]:
        _ops(state)["mode_schedules"] = rows
        return rows
    return security_store.transact(_replace)


def run_mode_schedule(now: float | None = None) -> bool:
    now = time.time() if now is None else now
    local = datetime.fromtimestamp(now)
    hhmm = local.strftime("%H:%M")
    weekday = local.weekday()
    state = security_store.read()
    ops = _ops(state)
    matches = [
        row for row in ops["mode_schedules"]
        if isinstance(row, dict)
        and row.get("enabled") is True
        and row.get("time") == hhmm
        and weekday in row.get("days", [])
        and row.get("profile") in PROFILE_TO_MODE
    ]
    if not matches:
        return False
    row = matches[-1]
    key = "{}:{}".format(local.strftime("%Y-%m-%dT%H:%M"), row.get("id"))
    if ops.get("last_mode_schedule_key") == key:
        return False
    apply_profile(str(row["profile"]), "schedule", now)

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


def prepare_notification(
    payload: dict[str, Any], subs: list[dict[str, Any]], gateway_available: bool
) -> tuple[str, list[dict[str, Any]]]:
    """Create one per-user inbox row and return non-snoozed subscriptions."""
    notification_id = uuid.uuid4().hex
    now = time.time()
    kind = _notification_kind(payload)
    users = sorted({
        str(sub.get("user_id")) for sub in subs
        if isinstance(sub.get("user_id"), str) and sub.get("user_id")
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
                "url": str(payload.get("url") or "/events")[:256],
                "importance": str(payload.get("importance") or "normal")[:16],
                "seen": False,
                "delivery_state": (
                    "snoozed" if snoozed else "queued" if gateway_available else "gateway_unavailable"
                ),
                "displayed_ts": None,
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
    day_outages = []
    for row in outages:
        if not isinstance(row, dict):
            continue
        started = row.get("start_ts")
        if not isinstance(started, (int, float)):
            continue
        if datetime.fromtimestamp(float(started)).strftime("%Y-%m-%d") == day:
            day_outages.append(row)
    protected = events_db.retention_summary(settings.events_db_path)
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


def health_history(hours: int, now: float | None = None) -> list[dict[str, Any]]:
    now = time.time() if now is None else now
    cutoff = now - hours * 3600
    return [
        dict(row) for row in _ops(security_store.read())["health_history"]
        if isinstance(row, dict)
        and isinstance(row.get("ts"), (int, float))
        and float(row["ts"]) >= cutoff
    ]


def archive_capability() -> dict[str, Any]:
    root = settings.external_archive_dir
    marker = root / ".homecam-external-archive"
    return {
        "target": str(root),
        "available": root.is_dir() and marker.is_file() and not marker.is_symlink(),
        "marker_required": ".homecam-external-archive",
    }


def set_archive_enabled(enabled: bool) -> dict[str, Any]:
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
    capability = archive_capability()
    if not capability["available"]:
        raise FileNotFoundError("independent archive target is not mounted and marked")
    root = settings.external_archive_dir / "protected-events"
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    manifest = []
    total = 0
    for event_id in sorted(events_db.protected_event_ids(settings.events_db_path)):
        source = recording_service.clip_path(event_id)
        if source is None or not source.is_file():
            continue
        digest = _hash(source)
        target = root / (event_id + ".mp4")
        if not target.is_file() or _hash(target) != digest:
            temp = target.with_suffix(".mp4.tmp")
            shutil.copy2(source, temp)
            if _hash(temp) != digest:
                temp.unlink(missing_ok=True)
                raise OSError("archive copy checksum mismatch")
            with temp.open("rb") as handle:
                os.fsync(handle.fileno())
            os.replace(temp, target)
            target.chmod(0o600)
        size = target.stat().st_size
        total += size
        manifest.append({"event_id": event_id, "sha256": digest, "bytes": size})
    body = json.dumps({"v": 1, "created_ts": time.time(), "files": manifest}, indent=2, sort_keys=True).encode()
    temp_manifest = root / ".manifest.json.tmp"
    with temp_manifest.open("wb") as handle:
        handle.write(body)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temp_manifest, root / "manifest.json")
    (root / "manifest.json").chmod(0o600)
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
    while not stop.is_set():
        now = time.time()
        try:
            await asyncio.to_thread(run_mode_schedule, now)
            if now - last_health >= 900:
                await asyncio.to_thread(sample_health, now)
                last_health = now
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
