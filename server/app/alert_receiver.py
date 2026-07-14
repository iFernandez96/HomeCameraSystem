"""Internal Alertmanager webhook that delivers operational alerts by Web Push.

This process is intentionally separate from ``app.main``.  A FastAPI restart
or structural server failure therefore cannot take the degraded-but-online
notification receiver down with the application it monitors.
"""
from __future__ import annotations

import logging
import re
from typing import Literal

from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field, field_validator

from .config import settings
from .services.push_service import PushService


log = logging.getLogger(__name__)
app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
_MAX_BODY_BYTES = 64 * 1024
_ALERT_NAME = re.compile(r"^[A-Za-z][A-Za-z0-9_]{0,95}$")


class _Alert(BaseModel):
    model_config = ConfigDict(extra="forbid")

    status: Literal["firing", "resolved"]
    labels: dict[str, str]
    annotations: dict[str, str]
    startsAt: str = Field(max_length=64)
    endsAt: str = Field(max_length=64)
    generatorURL: str = Field(default="", max_length=2048)
    fingerprint: str = Field(default="", max_length=128)

    @field_validator("labels", "annotations")
    @classmethod
    def bounded_map(cls, value: dict[str, str]) -> dict[str, str]:
        if len(value) > 32:
            raise ValueError("too many fields")
        if any(len(key) > 96 or len(item) > 512 for key, item in value.items()):
            raise ValueError("field is too long")
        return value


class _Webhook(BaseModel):
    model_config = ConfigDict(extra="forbid")

    version: Literal["4"]
    groupKey: str = Field(max_length=512)
    truncatedAlerts: int = Field(default=0, ge=0)
    status: Literal["firing", "resolved"]
    receiver: str = Field(max_length=128)
    groupLabels: dict[str, str]
    commonLabels: dict[str, str]
    commonAnnotations: dict[str, str]
    externalURL: str = Field(default="", max_length=2048)
    notification_reason: str | None = Field(default=None, max_length=64)
    alerts: list[_Alert] = Field(min_length=1, max_length=1)

    @field_validator("groupLabels", "commonLabels", "commonAnnotations")
    @classmethod
    def bounded_map(cls, value: dict[str, str]) -> dict[str, str]:
        return _Alert.bounded_map(value)


@app.get("/healthz")
async def healthz() -> dict[str, bool]:
    return {"ok": True}


@app.post("/alerts")
async def receive_alert(request: Request) -> dict[str, object]:
    length = request.headers.get("content-length")
    if length is not None:
        try:
            if int(length) > _MAX_BODY_BYTES:
                raise HTTPException(status_code=413, detail="payload too large")
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="invalid content length") from exc
    body = await request.body()
    if len(body) > _MAX_BODY_BYTES:
        raise HTTPException(status_code=413, detail="payload too large")
    try:
        webhook = _Webhook.model_validate_json(body)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail="invalid alert payload") from exc

    alert = webhook.alerts[0]
    alert_name = alert.labels.get("alertname", "")
    if not _ALERT_NAME.fullmatch(alert_name):
        raise HTTPException(status_code=422, detail="invalid alert name")
    summary = alert.annotations.get("summary", "Camera system condition")[:160]
    description = alert.annotations.get("description", "")[:320]
    resolved = webhook.status == "resolved"
    title_prefix = "HomeCam recovered" if resolved else "HomeCam alert"
    payload = {
        "title": "{}: {}".format(title_prefix, summary),
        "body": description or summary,
        "tag": "homecam-system-{}".format(alert_name.lower()),
        "url": "/settings",
        "importance": "normal" if resolved else "critical",
        "require_interaction": not resolved,
        "silent": False,
    }

    # Reload subscriptions and keys for every Alertmanager retry. An operator
    # can provision a receiver after an alert starts firing without restarting
    # this process, and the shared registry remains read-only here.
    sender = PushService(persist_path=settings.push_subs_path)
    sender.load_keys()
    sent = await sender.send_all_readonly(payload)
    if sent < 1:
        log.warning(
            "operational alert delivery deferred status=%s alertname=%s sent=0",
            webhook.status,
            alert_name,
        )
        raise HTTPException(status_code=503, detail="no off-box delivery")
    log.info(
        "operational alert delivered status=%s alertname=%s recipients=%d",
        webhook.status,
        alert_name,
        sent,
    )
    return {"ok": True, "sent": sent, "status": webhook.status}
