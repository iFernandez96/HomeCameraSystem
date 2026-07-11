"""Best-effort in-process outage transitions and package reminders."""
from __future__ import annotations

import asyncio
import time
from typing import Any

from .health import seconds_since_last_frame, worker_health
from .push_service import push_service
from .security_store import security_store

PACKAGE_OVERDUE_S = 3 * 3600.0


def capabilities() -> dict[str, Any]:
    return {
        "self_outage_detection": False,
        "power_source": False,
        "network_probe": False,
        "limitation": (
            "This server can record worker and stale-frame failures only while it is "
            "running. It cannot report its own power-off or total network loss without "
            "an independent powered monitor."
        ),
    }


def _samples(now: float) -> list[dict[str, Any]]:
    alive = worker_health.is_alive()
    frame_age = seconds_since_last_frame(worker_health.metrics(), now=now)
    return [
        {
            "component": "detection_worker",
            "state": "healthy" if alive else "unavailable",
            "reason": None if alive else "worker heartbeat is stale or missing",
        },
        {
            "component": "camera_frames",
            "state": (
                "healthy" if alive and frame_age is not None and frame_age <= 60.0
                else "unavailable"
            ),
            "reason": (
                None if alive and frame_age is not None and frame_age <= 60.0
                else "fresh camera frames are not confirmed"
            ),
        },
    ]


def record_transitions(now: float | None = None) -> list[dict[str, Any]]:
    now = time.time() if now is None else now
    samples = _samples(now)
    transitions: list[dict[str, Any]] = []

    snapshot = security_store.read()["outages"]
    previous_current = snapshot.get("current", {})
    changed_components = [
        sample["component"]
        for sample in samples
        if not isinstance(previous_current.get(sample["component"]), dict)
        or previous_current[sample["component"]].get("state") != sample["state"]
    ]
    if not changed_components:
        # Avoid a whole-document fsync every 30 seconds on the Jetson SD card.
        return []

    def _update(state: dict[str, Any]) -> None:
        current = state["outages"].setdefault("current", {})
        history = state["outages"].setdefault("history", [])
        for sample in samples:
            component = sample["component"]
            previous = current.get(component)
            changed = component in changed_components
            since_ts = now if changed else float(previous.get("since_ts", now))
            row = {
                **sample,
                "since_ts": since_ts,
                "last_checked_ts": now,
            }
            current[component] = row
            if changed and sample["state"] != "healthy":
                history.append({
                    "id": "{}-{}".format(component, int(now * 1000)),
                    "kind": component,
                    "start_ts": now,
                    "end_ts": None,
                    "reason": sample["reason"],
                    "recovered": False,
                    "inferred": False,
                })
            elif changed and sample["state"] == "healthy":
                for incident in reversed(history):
                    if (
                        isinstance(incident, dict)
                        and incident.get("kind") == component
                        and incident.get("end_ts") is None
                    ):
                        incident["end_ts"] = now
                        incident["recovered"] = True
                        break
            if changed and isinstance(previous, dict):
                transition = {
                    "id": "{}-{}".format(component, int(now * 1000)),
                    "component": component,
                    "from_state": previous.get("state"),
                    "to_state": sample["state"],
                    "reason": sample["reason"],
                    "ts": now,
                }
                history.append(transition)
                transitions.append(transition)
        del history[:-1000]

    security_store.transact(_update)
    return transitions


def public_outages() -> dict[str, Any]:
    outages = security_store.read()["outages"]
    rows = [
        row for row in outages.get("history", [])
        if isinstance(row, dict) and "kind" in row
    ]
    return {
        "v": 1,
        "capabilities": capabilities(),
        "items": list(reversed(rows))[:200],
    }


async def _notify_transition(row: dict[str, Any]) -> None:
    recovered = row.get("to_state") == "healthy"
    await push_service.send_all({
        "title": "Camera system recovered" if recovered else "Camera system needs attention",
        "body": str(row.get("component", "component")).replace("_", " ").title(),
        "tag": "outage:{}".format(row.get("component")),
        "url": "/settings",
        "importance": "normal" if recovered else "high",
        "notification_kind": "outage_recovery" if recovered else "outage",
        "actions": ["view"],
    })


async def check_package_reminders(now: float | None = None) -> int:
    now = time.time() if now is None else now
    due: list[dict[str, Any]] = []
    snapshot = security_store.read()["packages"]
    due_keys = {
        key
        for key, package in snapshot.items()
        if (
            isinstance(package, dict)
            and package.get("state") == "present"
            and not package.get("overdue_notified")
            and now - float(package.get("delivered_at", now)) >= PACKAGE_OVERDUE_S
        )
    }
    if not due_keys:
        return 0

    def _mark(state: dict[str, Any]) -> None:
        for key in due_keys:
            package = state["packages"].get(key)
            if (
                isinstance(package, dict)
                and package.get("state") == "present"
                and not package.get("overdue_notified")
                and now - float(package.get("delivered_at", now)) >= PACKAGE_OVERDUE_S
            ):
                package["overdue_notified"] = True
                package["overdue_notified_at"] = now
                due.append(dict(package))

    security_store.transact(_mark)
    for package in due:
        await push_service.send_all({
            "title": "Package still at the door",
            "body": "Delivered more than 3 hours ago",
            "tag": "package:{}".format(package.get("correlation_id")),
            "url": "/events",
            "event_id": package.get("event_id"),
            "importance": "normal",
            "notification_kind": "package_overdue",
            "actions": ["view", "mark_seen"],
        })
    return len(due)


async def run(stop: asyncio.Event) -> None:
    # Give host services one normal heartbeat window before declaring an
    # initial condition. Initial state is not pushed; only transitions are.
    try:
        await asyncio.wait_for(stop.wait(), timeout=45.0)
        return
    except asyncio.TimeoutError:
        pass
    record_transitions()
    iterations = 0
    while not stop.is_set():
        try:
            await asyncio.wait_for(stop.wait(), timeout=30.0)
            break
        except asyncio.TimeoutError:
            pass
        for transition in record_transitions():
            await _notify_transition(transition)
        await check_package_reminders()
        iterations += 1
        if iterations % 20 == 0:
            from .security_timeline import prune_export_jobs

            await asyncio.to_thread(prune_export_jobs)
