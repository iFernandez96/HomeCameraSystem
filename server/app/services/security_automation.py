"""Local automation matching, package lifecycle and action adapters."""
from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

from ..config import settings
from .detection_config import detection_config
from .push_service import push_service
from .security_deterrence import automatic as automatic_deterrence
from .security_deterrence import capabilities as deterrence_capabilities
from .security_store import security_store


def masked_target(url: str) -> str:
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise ValueError("webhook URL must be http or https")
    if parsed.username is not None or parsed.password is not None:
        raise ValueError("webhook URL must not contain user information")
    port = ":{}".format(parsed.port) if parsed.port else ""
    return "{}://{}{}{}".format(
        parsed.scheme, parsed.hostname, port, parsed.path or "/"
    )


def mask_automation(row: dict[str, Any]) -> dict[str, Any]:
    actions: list[dict[str, Any]] = []
    for raw in row.get("actions", []):
        if not isinstance(raw, dict):
            continue
        if raw.get("kind") == "webhook":
            try:
                target = masked_target(str(raw.get("url", "")))
            except ValueError:
                target = "invalid webhook"
            actions.append({
                "kind": "webhook",
                "target": target,
                "secret_set": bool(raw.get("secret")),
            })
        else:
            actions.append({k: v for k, v in raw.items() if k != "secret"})
    return {
        "id": row.get("id"),
        "name": row.get("name"),
        "enabled": bool(row.get("enabled")),
        "triggers": row.get("triggers", {}),
        "conditions": row.get("conditions", {}),
        "actions": actions,
        "created_ts": row.get("created_ts"),
        "updated_ts": row.get("updated_ts"),
    }


def _matches(rule: dict[str, Any], event: dict[str, Any]) -> bool:
    triggers = rule.get("triggers") if isinstance(rule.get("triggers"), dict) else {}
    conditions = rule.get("conditions") if isinstance(rule.get("conditions"), dict) else {}
    checks = {
        "labels": event.get("label"),
        "sources": event.get("source") or "vision",
        "camera_ids": event.get("camera_id"),
        "rule_ids": event.get("rule_id"),
    }
    for key, actual in checks.items():
        accepted = triggers.get(key, [])
        if isinstance(accepted, list) and accepted and actual not in accepted:
            return False
    modes = conditions.get("operating_modes", [])
    if modes and detection_config.get().operating_mode not in modes:
        return False
    person = conditions.get("person", "any")
    if person == "known" and not event.get("person_name"):
        return False
    if person == "unknown" and event.get("person_name"):
        return False
    if float(event.get("score") or 0.0) < float(conditions.get("min_score", 0.0)):
        return False
    return True


def dry_run(rule: dict[str, Any], event: dict[str, Any]) -> dict[str, Any]:
    matched = _matches(rule, event)
    planned: list[dict[str, Any]] = []
    for action in rule.get("actions", []):
        kind = action.get("kind") if isinstance(action, dict) else "invalid"
        item = {"kind": kind, "status": "planned" if matched else "not_matched"}
        if kind in {"light", "warning", "siren"}:
            item["capability"] = deterrence_capabilities()
        planned.append(item)
    return {"matched": matched, "results": planned}


def _webhook_sync(action: dict[str, Any], event: dict[str, Any]) -> dict[str, Any]:
    url = str(action.get("url", ""))
    masked_target(url)  # revalidate persisted state before network use
    body = json.dumps(
        {"v": 1, "kind": "homecam.event", "event": event},
        separators=(",", ":"),
    ).encode("utf-8")
    headers = {"Content-Type": "application/json", "User-Agent": "HomeCam/1"}
    secret = action.get("secret")
    if isinstance(secret, str) and secret:
        headers["X-HomeCam-Signature"] = "sha256=" + hmac.new(
            secret.encode("utf-8"), body, hashlib.sha256
        ).hexdigest()
    request = urllib.request.Request(url, data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(
            request, timeout=settings.automation_webhook_timeout_s
        ) as response:
            status = int(response.status)
    except (OSError, urllib.error.URLError):
        return {"kind": "webhook", "status": "failed", "detail": "delivery failed"}
    return {
        "kind": "webhook",
        "status": "sent" if 200 <= status < 300 else "failed",
        "detail": "HTTP {}".format(status),
    }


def _mqtt_sync(action: dict[str, Any], event: dict[str, Any]) -> dict[str, Any]:
    if not settings.mqtt_host:
        return {"kind": "mqtt", "status": "unavailable", "detail": "MQTT is not configured"}
    try:
        from paho.mqtt.publish import single
    except ImportError:
        return {"kind": "mqtt", "status": "unavailable", "detail": "MQTT adapter is not installed"}
    auth = None
    if settings.mqtt_username:
        auth = {"username": settings.mqtt_username, "password": settings.mqtt_password}
    try:
        single(
            str(action.get("topic")),
            payload=json.dumps({"v": 1, "event": event}, separators=(",", ":")),
            hostname=settings.mqtt_host,
            port=settings.mqtt_port,
            auth=auth,
        )
    except Exception:
        return {"kind": "mqtt", "status": "failed", "detail": "publish failed"}
    return {"kind": "mqtt", "status": "sent"}


async def execute_actions(
    rule: dict[str, Any], event: dict[str, Any]
) -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    for action in rule.get("actions", []):
        kind = action.get("kind") if isinstance(action, dict) else None
        if kind == "push":
            payload = {
                "title": action.get("title") or rule.get("name") or "Home security alert",
                "body": "{} · {}%".format(
                    str(event.get("label", "Event")).replace("_", " ").title(),
                    int(float(event.get("score") or 0.0) * 100),
                ),
                "tag": "automation:{}".format(rule.get("id")),
                "url": "/events",
                "event_id": event.get("id"),
                "importance": "high",
                "notification_kind": "automation",
                "actions": ["view", "mark_seen"],
            }
            sent = await push_service.send_matching(event, payload)
            results.append({"kind": "push", "status": "sent", "detail": "{} subscriber(s)".format(sent)})
        elif kind == "webhook":
            results.append(await asyncio.to_thread(_webhook_sync, action, event))
        elif kind == "mqtt":
            results.append(await asyncio.to_thread(_mqtt_sync, action, event))
        elif kind in {"light", "warning", "siren"}:
            # Physical automation must be explicitly tied to a named smart
            # rule. The deterrence policy then independently fails closed on
            # identity uncertainty, privacy, arming, cooldown and capability.
            configured_rule_ids = rule.get("triggers", {}).get("rule_ids", [])
            if not configured_rule_ids or event.get("rule_id") not in configured_rule_ids:
                results.append({"kind": kind, "status": "blocked", "detail": "named smart rule is required"})
            else:
                results.append(await asyncio.to_thread(
                    automatic_deterrence,
                    event,
                    str(kind),
                    float(action.get("duration_s", 10.0)),
                ))
    return results


def note_package_event(event: dict[str, Any]) -> None:
    package_state = event.get("package_state")
    if package_state not in {"delivered", "present", "collected", "possible_theft"}:
        return
    key = str(event.get("correlation_id") or event.get("id"))
    now = float(event.get("ts") or time.time())

    def _update(state: dict[str, Any]) -> None:
        packages = state["packages"]
        current = packages.get(key, {})
        if package_state in {"delivered", "present"}:
            current.update({
                "correlation_id": key,
                "camera_id": event.get("camera_id"),
                "state": "present",
                "delivered_at": current.get("delivered_at", now),
                "last_seen_at": now,
                "event_id": event.get("id"),
                "rule_id": event.get("rule_id"),
                "rule_name": event.get("rule_name"),
                "overdue_notified": bool(current.get("overdue_notified", False)),
            })
        else:
            current.update({
                "correlation_id": key,
                "camera_id": event.get("camera_id"),
                "state": package_state,
                "last_seen_at": now,
                "event_id": event.get("id"),
            })
        packages[key] = current

    security_store.transact(_update)


async def process_canonical_event(event: dict[str, Any]) -> None:
    await asyncio.to_thread(note_package_event, event)
    automations = security_store.read()["automations"]
    for rule in automations.values():
        if isinstance(rule, dict) and rule.get("enabled") and _matches(rule, event):
            await execute_actions(rule, event)
