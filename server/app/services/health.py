"""Liveness signal for the host-side detection worker.

The detection worker runs in a separate process from the FastAPI server
(it lives on the Jetson host, not in the Docker container). The server
otherwise has no way to know whether the worker is up. We track the last
time the worker called /api/_internal/heartbeat and expose `worker_alive`
on /api/status. The worker also includes a metrics snapshot on each
heartbeat — fps, infer_per_s, gear (active|idle) — surfaced through
`worker_metrics` so the Live stats bar can report current detection rate.

Single-process FastAPI under uvicorn — no lock needed, attribute writes
are atomic under the GIL and there is only one event loop.
"""
from __future__ import annotations

import logging
import time
from collections.abc import Callable
from typing import Any

from ..log import RateLimitedLog


log = logging.getLogger(__name__)
_FUTURE_LAST_FRAME_GRACE_S = 60.0
_future_last_frame_warn_gate = RateLimitedLog(300.0)


def _clamped_age_s(now: float, timestamp: float) -> float:
    return max(0.0, now - timestamp)


def _drop_implausible_future_last_frame(
    metrics: dict[str, Any],
    *,
    now: float,
) -> dict[str, Any]:
    last_frame_ts = metrics.get("last_frame_ts")
    if (
        isinstance(last_frame_ts, (int, float))
        and not isinstance(last_frame_ts, bool)
        and last_frame_ts > now + _FUTURE_LAST_FRAME_GRACE_S
    ):
        if _future_last_frame_warn_gate.should_log():
            log.warning(
                "heartbeat discarded implausible future last_frame_ts=%s "
                "now=%s grace_s=%s",
                last_frame_ts,
                now,
                _FUTURE_LAST_FRAME_GRACE_S,
            )
        metrics = dict(metrics)
        metrics.pop("last_frame_ts", None)
    return metrics


def seconds_since_last_frame(
    worker_metrics: dict[str, Any] | None,
    *,
    now: float | None = None,
) -> float | None:
    if not worker_metrics:
        return None
    last_frame_ts = worker_metrics.get("last_frame_ts", 0.0)
    if not isinstance(last_frame_ts, (int, float)) or isinstance(last_frame_ts, bool):
        return None
    if last_frame_ts <= 0.0:
        return None
    if now is None:
        now = time.time()
    if last_frame_ts > now + _FUTURE_LAST_FRAME_GRACE_S:
        if _future_last_frame_warn_gate.should_log():
            log.warning(
                "status discarded implausible future last_frame_ts=%s "
                "now=%s grace_s=%s",
                last_frame_ts,
                now,
                _FUTURE_LAST_FRAME_GRACE_S,
            )
        return None
    return round(_clamped_age_s(now, last_frame_ts), 1)


class WorkerHealth:
    def __init__(
        self,
        alive_window_s: float = 30.0,
        *,
        clock: Callable[[], float] = time.time,
        monotonic_clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.last_heartbeat: float = 0.0
        self.last_heartbeat_monotonic: float = 0.0
        self.last_metrics: dict[str, Any] | None = None
        self.alive_window_s = alive_window_s
        self._clock = clock
        self._monotonic_clock = monotonic_clock

    def heartbeat(self, metrics: dict[str, Any] | None = None) -> None:
        now = self._clock()
        self.last_heartbeat = now
        self.last_heartbeat_monotonic = self._monotonic_clock()
        if metrics is not None:
            self.last_metrics = _drop_implausible_future_last_frame(metrics, now=now)

    def _elapsed_since_heartbeat(self) -> float:
        if self.last_heartbeat_monotonic > 0.0:
            return _clamped_age_s(self._monotonic_clock(), self.last_heartbeat_monotonic)
        return _clamped_age_s(self._clock(), self.last_heartbeat)

    def is_alive(self) -> bool:
        if self.last_heartbeat == 0.0:
            return False
        return self._elapsed_since_heartbeat() < self.alive_window_s

    def last_seen_s(self) -> float | None:
        if self.last_heartbeat == 0.0:
            return None
        return self._elapsed_since_heartbeat()

    def metrics(self) -> dict[str, Any] | None:
        """Return the most recent metrics snapshot — but only if the worker
        is currently alive. Stale metrics from a dead worker would mislead
        the UI."""
        if not self.is_alive():
            return None
        return self.last_metrics

    def snapshot(self, now: float | None = None) -> tuple[bool, float | None, dict[str, Any] | None]:
        """iter-176: read `(alive, last_seen_s, metrics)` against a single
        `now` timestamp so the three derived values are mutually consistent.

        Pre-iter-176 `/api/status` called `is_alive()`, `last_seen_s()`, and
        `metrics()` independently — each read `time.time()` separately. In
        the rare boundary case where the elapsed time straddles
        `alive_window_s` between two calls, the response could carry
        `worker_alive: True` with `worker_last_seen_s: 30.001` (or vice
        versa) — internally inconsistent, may render the wrong UI gear.

        Pass `now` explicitly to allow caller-side wall-clock timing control
        (mostly for tests). Default uses the heartbeat receipt's monotonic
        timestamp for elapsed-time derivation so wall-clock jumps cannot make
        the worker look dead or produce a negative age.
        """
        if now is None:
            elapsed = self._elapsed_since_heartbeat()
        else:
            elapsed = _clamped_age_s(now, self.last_heartbeat)
        if self.last_heartbeat == 0.0:
            return (False, None, None)
        alive = elapsed < self.alive_window_s
        last_seen = elapsed
        metrics = self.last_metrics if alive else None
        return (alive, last_seen, metrics)


worker_health = WorkerHealth()
