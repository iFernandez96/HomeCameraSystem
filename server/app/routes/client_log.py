"""Bounded anonymous sink for browser and service-worker diagnostics."""
from __future__ import annotations

import json
import logging
import time

from fastapi import APIRouter
from pydantic import BaseModel, ConfigDict, Field, model_validator


router = APIRouter(tags=["client-log"])
log = logging.getLogger(__name__)

_CLIENT_LOG_WINDOW_S = 10.0
_CLIENT_LOG_MAX_PER_WINDOW = 50
_client_log_bucket = {"ts": 0.0, "count": 0}
_CLIENT_LOG_LEVELS = {
    "error": logging.ERROR,
    "warn": logging.WARNING,
    "info": logging.INFO,
    "debug": logging.DEBUG,
}


class ClientLog(BaseModel):
    model_config = ConfigDict(extra="forbid")
    level: str = Field(pattern=r"^(error|warn|info|debug)$")
    event: str = Field(min_length=1, max_length=120)
    fields: dict | None = Field(default=None)
    online: bool | None = None
    ua: str | None = Field(default=None, max_length=256)

    @model_validator(mode="after")
    def _bound_fields(self) -> "ClientLog":
        if self.fields is not None:
            try:
                if len(json.dumps(self.fields)) > 2048:
                    object.__setattr__(self, "fields", {"_truncated": True})
            except (TypeError, ValueError):
                object.__setattr__(self, "fields", {"_unserializable": True})
        return self


@router.post("/client-log")
async def receive_client_log(entry: ClientLog) -> dict:
    now = time.monotonic()
    if now - _client_log_bucket["ts"] >= _CLIENT_LOG_WINDOW_S:
        _client_log_bucket["ts"] = now
        _client_log_bucket["count"] = 0
    _client_log_bucket["count"] += 1
    if _client_log_bucket["count"] > _CLIENT_LOG_MAX_PER_WINDOW:
        if _client_log_bucket["count"] == _CLIENT_LOG_MAX_PER_WINDOW + 1:
            log.warning(
                "client_log rate cap hit (%d/%.0fs) — dropping further client logs this window",
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
