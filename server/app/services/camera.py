from __future__ import annotations

import logging
import shutil
import time
from pathlib import Path

from ..config import settings

log = logging.getLogger(__name__)


class CameraService:
    """Snapshot helper.

    Live frames flow Camera → MediaMTX → WebRTC; the FastAPI process never
    sees raw pixels. To produce a snapshot on demand we lean on the host-
    side detection worker, which already has every decoded frame in CUDA
    memory and writes the most recent one to `<snapshots_dir>/latest.jpg`
    once per second (see `detection/detect.py`).

    `capture()` then atomically copies that file to a timestamped name so
    the user's snapshot survives the next refresh.

    The `active` flag tracks whether we've ever seen a `latest.jpg`. It
    flips to True the first time `capture()` succeeds and stays there;
    `health()` reports `ok` so the existing /api/status field still works.
    """

    LATEST_NAME = "latest.jpg"
    LATEST_MAX_AGE_S = 10.0
    # Cap user-driven snapshots so the directory doesn't grow without
    # bound. The detection worker prunes its own thumb_*.jpg files
    # (DETECT_THUMB_MAX), but snap_*.jpg files from /api/capture had no
    # ceiling — a user hitting "Capture" frequently could fill the
    # Jetson's disk over months. 50 is generous (the UI shows recent
    # snapshots inline; older ones are rarely revisited).
    SNAP_PREFIX = "snap_"
    SNAP_MAX_KEEP = 50

    def __init__(self) -> None:
        self.active = False
        self.fps: float = 0.0

    async def start(self) -> None:
        # Worker drives the actual camera capture; nothing to start here.
        # Mark "ok" so the camera health field on /api/status is truthful
        # as long as the rest of the stack is up — `capture()` returns
        # 503-equivalent if the worker hasn't produced a frame yet.
        self.active = True

    async def stop(self) -> None:
        self.active = False

    def health(self) -> str:
        return "ok" if self.active else "missing"

    async def capture(self) -> Path | None:
        if not self.active:
            return None
        settings.snapshots_dir.mkdir(parents=True, exist_ok=True)
        latest = settings.snapshots_dir / self.LATEST_NAME
        if not latest.exists():
            log.warning(
                "capture: %s missing — detection worker may not be running",
                latest,
            )
            return None
        # If `latest.jpg` is stale, the worker is up but stalled (e.g. RTSP
        # disconnect). Don't lie about a 30 s old frame being a snapshot.
        age = time.time() - latest.stat().st_mtime
        if age > self.LATEST_MAX_AGE_S:
            log.warning("capture: %s is %.1fs old; refusing to serve as snapshot", latest, age)
            return None
        name = f"{self.SNAP_PREFIX}{int(time.time() * 1000)}.jpg"
        target = settings.snapshots_dir / name
        try:
            shutil.copy2(latest, target)
        except OSError as e:
            log.warning("capture: failed to copy %s -> %s: %s", latest, target, e)
            return None
        self._prune_old_snapshots()
        return target

    def _prune_old_snapshots(self) -> None:
        """Drop the oldest `snap_*.jpg` files past `SNAP_MAX_KEEP`. Filename
        format is `snap_<ms>.jpg` so alphabetic sort == chronological. Best
        effort: per-file unlink errors are logged once (so we notice if the
        dir becomes unwritable) but don't propagate — the snapshot just
        succeeded and the user shouldn't see a 500 because of a stale FS."""
        try:
            files = sorted(
                f.name
                for f in settings.snapshots_dir.iterdir()
                if f.name.startswith(self.SNAP_PREFIX) and f.name.endswith(".jpg")
            )
        except OSError as e:
            log.warning("capture: could not list %s for pruning: %s", settings.snapshots_dir, e)
            return
        # Slice handles len <= SNAP_MAX_KEEP cleanly (returns []).
        for old in files[: -self.SNAP_MAX_KEEP]:
            try:
                (settings.snapshots_dir / old).unlink()
            except OSError as e:
                log.warning("capture: prune unlink failed for %s: %s", old, e)


camera_service = CameraService()
