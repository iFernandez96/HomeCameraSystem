"""Once-per-local-day push digest scheduler."""
from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from pathlib import Path

from ..config import settings
from .detection_config import detection_config
from .events_db import daily_digest
from .operations import build_briefing
from .push_service import push_service
from ..log import RateLimitedLog

log = logging.getLogger(__name__)
_failure_gate = RateLimitedLog(300.0)


def _last_sent(path: Path) -> str | None:
    try:
        value = json.loads(path.read_text())
        return value.get("day") if isinstance(value, dict) else None
    except (OSError, ValueError):
        return None


def _save_sent(path: Path, day: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps({"day": day}))
    os.replace(tmp, path)
    path.chmod(0o600)


async def send_if_due(now: float | None = None) -> bool:
    now = time.time() if now is None else now
    config = detection_config.get()
    if not config.daily_digest_enabled:
        return False
    local = time.localtime(now)
    day = time.strftime("%Y-%m-%d", local)
    hour, minute = (int(part) for part in config.daily_digest_time.split(":"))
    if (local.tm_hour, local.tm_min) < (hour, minute):
        return False
    if _last_sent(settings.digest_state_path) == day:
        return False
    digest = await asyncio.to_thread(daily_digest, settings.events_db_path, day)
    briefing = await asyncio.to_thread(build_briefing, day)
    labels = " · ".join(
        "{} {}".format(count, label)
        for label, count in sorted(digest["by_label"].items())
    ) or "No activity"
    await push_service.send_all({
        "title": "Today's camera digest",
        "body": "{}. Recording {} · {} camera interruption{}".format(
            labels,
            briefing["recording_state"],
            briefing["camera_interruptions"],
            "" if briefing["camera_interruptions"] == 1 else "s",
        ),
        "tag": "daily-digest:{}".format(day),
        "url": "/events?day={}".format(day),
        "silent": True,
    })
    _save_sent(settings.digest_state_path, day)
    return True


async def run(stop: asyncio.Event) -> None:
    while not stop.is_set():
        try:
            await send_if_due()
        except Exception:
            # The lifespan owner logs failures; a transient push/DB error is
            # retried on the next minute because state is written only after send.
            if _failure_gate.should_log():
                log.exception("daily digest send failed; retrying on next scheduler tick")
        try:
            await asyncio.wait_for(stop.wait(), timeout=60.0)
        except asyncio.TimeoutError:
            continue
