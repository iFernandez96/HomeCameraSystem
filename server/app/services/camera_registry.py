"""Camera registry (docs/multicam_contract.md, 2026-07-07).

Server-owned list of configured cameras. Plumb a camera DIMENSION
through the stack so a second camera is a config entry, not a rewrite.
Ships with ONE camera configured; with a single camera the client
renders exactly as today.

Config: env `HOMECAM_CAMERAS` (surfaced as `settings.cameras_json`) =
JSON array of `{"id": ..., "name": ..., "path": ...}` objects.

- `id`: `^[a-z0-9_]{1,32}$` — flows into event rows, push filters and
  the `/api/events/search?camera=` filter, so the charset is pinned to
  the same conservative shape the worker's `DETECT_CAMERA_ID` uses.
- `name`: display string (what the UI + push copy show).
- `path`: MediaMTX base path; quality rungs derive from it exactly as
  the client's streamQuality composes `cam` / `cam_lq` today.

Fallback semantics (never crash the server on operator config): when
the env var is unset/empty we use the default single-camera registry
silently; when it is set but INVALID in any way (bad JSON, wrong
shape, bad id, duplicate id, ...) we log WHY at WARNING and fall back
to the same default — a typo'd registry must not take the camera
system down.

Pure parse logic (`parse_cameras`) is separated from the settings-
reading singleton so it unit-tests offline (engineering principle #2).
"""
from __future__ import annotations

import json
import logging
import re
from dataclasses import asdict, dataclass

from ..config import settings

log = logging.getLogger(__name__)

# Contract pin: worker DETECT_CAMERA_ID + DetectionPayload.camera_id
# use the same regex. Change all three together (wire-contract-sync).
CAMERA_ID_RE = re.compile(r"^[a-z0-9_]{1,32}$")
_NAME_MAX = 64
# MediaMTX path segment — same conservative charset as the stream
# paths in deploy/mediamtx.yml (`cam`, `cam_lq`, `cam_uq`).
_PATH_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


@dataclass(frozen=True)
class Camera:
    id: str
    name: str
    path: str

    def as_dict(self) -> dict:
        return asdict(self)


# The contract default: exactly what a single-camera deploy is today.
DEFAULT_CAMERAS: tuple[Camera, ...] = (
    Camera(id="front_door", name="Front Door", path="cam"),
)


def _entry_invalid_reason(entry: object, seen_ids: set[str]) -> str | None:
    """Return a human-readable reason the entry is invalid, or None
    when it is acceptable. Kept separate so `parse_cameras` can log
    the WHY on the failure path (logging plan: never a bare swallow)."""
    if not isinstance(entry, dict):
        return "entry is not a JSON object (got {})".format(
            type(entry).__name__
        )
    extra = set(entry) - {"id", "name", "path"}
    if extra:
        return "unknown keys {}".format(sorted(extra))
    cam_id = entry.get("id")
    if not isinstance(cam_id, str) or not CAMERA_ID_RE.match(cam_id):
        return "id must match ^[a-z0-9_]{{1,32}}$ (got {!r})".format(cam_id)
    if cam_id in seen_ids:
        return "duplicate id {!r}".format(cam_id)
    name = entry.get("name")
    if (
        not isinstance(name, str)
        or not name.strip()
        or len(name) > _NAME_MAX
    ):
        return "name must be a non-empty string <= {} chars (got {!r})".format(
            _NAME_MAX, name
        )
    path = entry.get("path")
    if not isinstance(path, str) or not _PATH_RE.match(path):
        return (
            "path must match ^[A-Za-z0-9_-]{{1,64}}$ (got {!r})".format(path)
        )
    return None


def parse_cameras(raw: str | None) -> list[Camera]:
    """Parse the HOMECAM_CAMERAS JSON into a camera list.

    Unset/blank → the default registry (normal single-camera deploy,
    no log noise). Anything set-but-invalid → WARNING naming the exact
    reason, then the default registry. Never raises — a bad operator
    edit to compose env must not crash server boot.
    """
    if raw is None or not raw.strip():
        return list(DEFAULT_CAMERAS)
    try:
        data = json.loads(raw)
    except (TypeError, ValueError) as exc:
        log.warning(
            "HOMECAM_CAMERAS is not valid JSON (%s); falling back to the "
            "default single-camera registry",
            exc,
        )
        return list(DEFAULT_CAMERAS)
    if not isinstance(data, list) or not data:
        log.warning(
            "HOMECAM_CAMERAS must be a non-empty JSON array of "
            "{id,name,path} objects (got %s); falling back to the "
            "default single-camera registry",
            type(data).__name__,
        )
        return list(DEFAULT_CAMERAS)
    cams: list[Camera] = []
    seen_ids: set[str] = set()
    for i, entry in enumerate(data):
        reason = _entry_invalid_reason(entry, seen_ids)
        if reason is not None:
            log.warning(
                "HOMECAM_CAMERAS entry %d invalid: %s; falling back to "
                "the default single-camera registry",
                i,
                reason,
            )
            return list(DEFAULT_CAMERAS)
        cams.append(
            Camera(
                id=entry["id"],
                name=entry["name"].strip(),
                path=entry["path"],
            )
        )
        seen_ids.add(entry["id"])
    return cams


class CameraRegistry:
    """Settings-backed singleton over `parse_cameras`.

    Re-reads `settings.cameras_json` on every `cameras()` call but only
    re-parses (and therefore only re-logs an invalid config) when the
    raw string actually changed — the registry sits on the push-fanout
    hot path, so the steady state is a string comparison. The re-read
    also makes tests self-resetting: `monkeypatch.setattr(settings,
    "cameras_json", ...)` takes effect on the next call with no
    explicit reload step.
    """

    _UNSET = object()

    def __init__(self) -> None:
        self._raw: object = self._UNSET
        self._cameras: list[Camera] = list(DEFAULT_CAMERAS)

    def cameras(self) -> list[Camera]:
        raw = settings.cameras_json
        if raw != self._raw:
            self._cameras = parse_cameras(raw)
            self._raw = raw
        return list(self._cameras)

    def get(self, camera_id: str | None) -> Camera | None:
        for cam in self.cameras():
            if cam.id == camera_id:
                return cam
        return None

    def name_for(self, camera_id: str | None) -> str | None:
        cam = self.get(camera_id)
        return cam.name if cam is not None else None

    def multi(self) -> bool:
        return len(self.cameras()) > 1


camera_registry = CameraRegistry()
