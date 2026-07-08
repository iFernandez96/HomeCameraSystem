"""OTA post-restart health polling."""
from __future__ import annotations

import logging
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

log = logging.getLogger(__name__)

HealthPoller = Callable[[], object]
Sleeper = Callable[[float], object]


@dataclass(frozen=True)
class HealthPollResult:
    status: str
    attempts: int
    reason: str | None = None

    @property
    def healthy(self) -> bool:
        return self.status == "healthy"


def _response_is_healthy(response: object) -> bool:
    if response is True:
        return True
    if isinstance(response, int):
        return 200 <= response < 300
    status_code = getattr(response, "status_code", None)
    if isinstance(status_code, int):
        return 200 <= status_code < 300
    if isinstance(response, dict):
        ok = response.get("ok")
        if isinstance(ok, bool):
            return ok
        status = response.get("status")
        if isinstance(status, str):
            return status.lower() in {"ok", "healthy", "ready"}
    return False


def poll_post_restart_health(
    poller: HealthPoller,
    *,
    attempts: int = 5,
    delay_s: float = 0.0,
    sleeper: Sleeper = time.sleep,
) -> HealthPollResult:
    """Poll an injected health callable until it reports a healthy response."""
    if attempts < 1:
        log.warning("rejecting OTA health poll reason=%s", "invalid_attempts")
        return HealthPollResult(status="unhealthy", attempts=0, reason="invalid_attempts")

    last_reason = "unhealthy_response"
    for index in range(1, attempts + 1):
        try:
            response: Any = poller()
        except Exception:  # noqa: BLE001 - health failures must trigger rollback.
            log.warning("ota health poll failed attempt=%s", index, exc_info=True)
            last_reason = "poller_exception"
        else:
            if _response_is_healthy(response):
                log.info("ota health poll passed attempt=%s", index)
                return HealthPollResult(status="healthy", attempts=index)
            last_reason = "unhealthy_response"

        if delay_s > 0 and index < attempts:
            sleeper(delay_s)

    log.warning("ota health poll exhausted attempts=%s reason=%s", attempts, last_reason)
    return HealthPollResult(status="unhealthy", attempts=attempts, reason=last_reason)
