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

import time
from typing import Any


class WorkerHealth:
    def __init__(self, alive_window_s: float = 30.0) -> None:
        self.last_heartbeat: float = 0.0
        self.last_metrics: dict[str, Any] | None = None
        self.alive_window_s = alive_window_s

    def heartbeat(self, metrics: dict[str, Any] | None = None) -> None:
        self.last_heartbeat = time.time()
        if metrics is not None:
            self.last_metrics = metrics

    def is_alive(self) -> bool:
        if self.last_heartbeat == 0.0:
            return False
        return (time.time() - self.last_heartbeat) < self.alive_window_s

    def last_seen_s(self) -> float | None:
        if self.last_heartbeat == 0.0:
            return None
        return time.time() - self.last_heartbeat

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

        Pass `now` explicitly to allow caller-side timing control (mostly
        for tests). Default reads `time.time()` once.
        """
        if now is None:
            now = time.time()
        if self.last_heartbeat == 0.0:
            return (False, None, None)
        elapsed = now - self.last_heartbeat
        alive = elapsed < self.alive_window_s
        last_seen = elapsed
        metrics = self.last_metrics if alive else None
        return (alive, last_seen, metrics)


worker_health = WorkerHealth()
