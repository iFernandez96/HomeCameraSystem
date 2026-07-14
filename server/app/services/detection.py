from __future__ import annotations

import asyncio
import logging
import os
import random

from .event_bus import event_bus, make_detection_event

log = logging.getLogger(__name__)


class DetectionService:
    """Detection on/off gate, backed by `DetectionConfig.enabled`.

    The real detector is the host-side worker in `detection/detect.py`. This
    service is the in-process face of the user's on/off preference:

      - `active` proxies `detection_config.enabled`. Reading is cheap;
        writing persists to disk so the setting survives container restart.
      - The host worker polls /api/detection/config and skips inference
        entirely when `enabled=false` — it doesn't just stop emitting,
        it stops running the model. Big thermal win when you don't want
        detection (away mode, nighttime, debugging).
      - `_internal/event` still gates on `active` as belt-and-braces, in
        case the worker is on an old version that hasn't picked up the
        config yet.

    The fake-event simulator only runs when `HOMECAM_SIMULATOR=1`.
    """

    def __init__(self) -> None:
        self._task: asyncio.Task[None] | None = None
        self._simulator_enabled = os.environ.get("HOMECAM_SIMULATOR") == "1"

    @property
    def active(self) -> bool:
        # Late import: detection_config -> config -> settings -> potential
        # circular if imported at module load.
        from .detection_config import detection_config

        return detection_config.get().enabled

    @active.setter
    def active(self, value: bool) -> None:
        from .detection_config import detection_config

        detection_config.update(enabled=bool(value))

    async def start(self) -> None:
        # Preserve the persisted operator preference across API/container
        # restarts. Startup must never silently resume inference after the
        # owner deliberately paused detection/classification.
        if self._simulator_enabled and self.active and self._task is None:
            self._task = asyncio.create_task(self._simulate())

    async def stop(self) -> None:
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None

    async def toggle(self) -> None:
        self.active = not self.active
        if self._simulator_enabled:
            if self.active and self._task is None:
                self._task = asyncio.create_task(self._simulate())
            elif not self.active and self._task is not None:
                self._task.cancel()
                try:
                    await self._task
                except asyncio.CancelledError:
                    pass
                self._task = None

    async def _simulate(self) -> None:
        """Dev-only fake event emitter. Never runs in production (gated by env)."""
        from .push_service import push_service

        try:
            while self.active:
                await asyncio.sleep(random.uniform(8.0, 14.0))
                if not self.active:
                    break
                box = {
                    "x": random.uniform(0.10, 0.55),
                    "y": random.uniform(0.10, 0.45),
                    "w": random.uniform(0.15, 0.30),
                    "h": random.uniform(0.30, 0.50),
                    "label": "person",
                    "score": random.uniform(0.7, 0.97),
                }
                evt = make_detection_event(
                    label="person",
                    score=box["score"],
                    boxes=[box],
                )
                await event_bus.publish(evt)
                try:
                    await push_service.send_all(
                        {
                            "title": "Person detected",
                            "body": f"Front Door · {int(box['score']*100)}%",
                            "tag": "detection",
                            "url": "/events",
                        }
                    )
                except Exception:
                    log.exception("push send failed")
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("detection simulator crashed")
            self.active = False


detection_service = DetectionService()
