"""Runtime-tunable knobs for the detection pipeline.

The host-side worker polls `GET /api/detection/config` periodically; the UI
PATCHes the same endpoint. The server is the single source of truth.
Persisted to the same `homecam-secrets` volume as VAPID + push subs so it
survives container rebuilds.

Bounds are enforced both in the route schema (Pydantic) and here on disk
load (clamps out-of-range values from a manually-edited file).
"""
from __future__ import annotations

import json
import logging
import os
import re
from dataclasses import asdict, dataclass, field
from pathlib import Path

from ..config import settings

log = logging.getLogger(__name__)

THRESHOLD_MIN = 0.05
THRESHOLD_MAX = 0.95
COOLDOWN_MIN = 0.0
COOLDOWN_MAX = 60.0
# iter-254 (Feature #1 polish): clip duration bounds.
# iter-256: bounds raised.
# iter-257: bound derives from the retention-preset tier so the
# disk math stays bounded regardless of which trade-off the user
# picks. The MAX exported here is the absolute ceiling (week
# preset); the active per-preset cap lives in `RETENTION_PRESETS`
# below and is enforced on PATCH.
CLIP_POST_ROLL_MIN = 3.0
CLIP_POST_ROLL_MAX = 1800.0  # 30 min — only allowed at "week" preset
CLIP_PRE_ROLL_MIN = 0.0
CLIP_PRE_ROLL_MAX = 300.0    # 5 min — only allowed at "week" preset

# iter-257: retention/clip-cap presets. Each tier picks both
# `retention_days` and the maximum clip post-roll the user can dial
# in. Disk math at 720p30 H.264 ~50 KB/s and 50 events/day:
#   week  : 7d × 50 ev × 90 MB (30 min)  ≈ 31 GB worst case
#   month : 30d × 50 ev × 45 MB (15 min) ≈ 67 GB worst case
#   year_5: 1825d × 50 ev × 1.5 MB (30s) ≈ 137 GB worst case
# Realistic event volumes (~10/day average for a typical home)
# bring all three under 30 GB. Operator picks based on disk + how
# far back they want to scrub.
#
# Pre-roll caps mirror the post-roll cap proportionally — the
# rolling-segment recorder (iter-255) needs disk for the buffer
# AND each event includes the buffered seconds. Tier 3 (year_5)
# disables pre-roll because it's incompatible with the 30s budget.
RETENTION_PRESETS = {
    "week": {
        "retention_days": 7,
        "clip_post_roll_max_s": 1800.0,  # 30 min
        "clip_pre_roll_max_s": 300.0,    # 5 min
    },
    "month": {
        "retention_days": 30,
        "clip_post_roll_max_s": 900.0,   # 15 min
        "clip_pre_roll_max_s": 150.0,    # 2.5 min
    },
    "year_5": {
        "retention_days": 365 * 5,
        "clip_post_roll_max_s": 30.0,    # 30 sec — short clips only
        "clip_pre_roll_max_s": 0.0,      # no pre-roll budget at this tier
    },
}
RETENTION_PRESET_DEFAULT = "month"


def preset_clip_post_roll_max(preset: str) -> float:
    """Look up the post-roll cap for a preset; falls back to the
    default tier when an unknown value is passed (defends against
    disk-loaded config rows from a future / downgraded server)."""
    p = RETENTION_PRESETS.get(preset, RETENTION_PRESETS[RETENTION_PRESET_DEFAULT])
    return float(p["clip_post_roll_max_s"])


def preset_clip_pre_roll_max(preset: str) -> float:
    p = RETENTION_PRESETS.get(preset, RETENTION_PRESETS[RETENTION_PRESET_DEFAULT])
    return float(p["clip_pre_roll_max_s"])


def preset_retention_days(preset: str) -> int:
    p = RETENTION_PRESETS.get(preset, RETENTION_PRESETS[RETENTION_PRESET_DEFAULT])
    return int(p["retention_days"])
# iter-356.62 slice 3 (privacy controls): face/person capture
# retention bounds. 1 day is the minimum sane TTL (anything shorter
# would race the daily sweep + bootstrap photo retention); 365 days
# is the absolute ceiling (operator can manually export before that).
FACE_CAPTURE_RETENTION_MIN = 1
FACE_CAPTURE_RETENTION_MAX = 365
FACE_CAPTURE_RETENTION_DEFAULT = 30

# Continuous-capture (visit) feature config knobs — Slice 5 (S5).
# The worker reads these verbatim off the config-poll
# (detection/visit_runtime.py::resolve_continuous_config):
#   continuous_capture (bool), max_visit_s (float), absence_finalize_s (float).
# Feature defaults ON — `continuous_capture=True` is the baked-live
# 2026-07-07 default; legacy per-event re-arm is no longer the reset path.
# `max_visit_s` is the HARD CAP on a single visit's duration (caps
# stuck-detection disk fill); plan B2/R3 default 150s (between the
# 120-180s band). `absence_finalize_s` is the post-roll grace window
# after the subject leaves before the visit clip is finalized — a NEW
# field per plan R3; do NOT reinterpret the deprecated `clip_post_roll_s`.
MAX_VISIT_MIN = 30.0
MAX_VISIT_MAX = 600.0
MAX_VISIT_DEFAULT = 150.0
ABSENCE_FINALIZE_MIN = 3.0
ABSENCE_FINALIZE_MAX = 60.0
ABSENCE_FINALIZE_DEFAULT = 30.0

CLASSES_MAX = 30  # cap to keep config files sane and validation cheap
# Cap the length of any individual class name. Longest real COCO label
# is "kitchen scissors" at 16 chars; 64 is generous. Without this, a
# disk row with `["x" * 1_000_000]` would survive `_valid_classes` and
# survive into the worker's runtime config.
CLASS_NAME_MAX = 64

# iter-191 (Feature #5): in-frame polygon mask bounds.
# A "zone" is a polygon = list of [x, y] points; coords normalized
# [0, 1] so they re-project to whatever frame size MediaMTX is
# emitting today (and survive a resolution change). 3 is the
# minimum that defines an area; 32 vertices is enough to draw
# complex L-shapes / curves while keeping the per-event point-in-
# polygon test cheap (~32 floating-point compares). 16 polygons
# covers "porch + driveway + sidewalk" with room to spare and caps
# config-file size at ~10 KB.
ZONES_MAX = 16
ZONE_VERTICES_MIN = 3
ZONE_VERTICES_MAX = 32

# Household operating mode. This is deliberately explicit and local: phone
# presence integrations may PATCH it later, but the camera always has one
# inspectable persisted mode and a manual override remains possible.
OPERATING_MODES = {"home", "away", "night", "privacy"}
OPERATING_MODE_DEFAULT = "home"

SMART_RULE_ID_RE = re.compile(r"^[a-z0-9_]{1,32}$")
SMART_RULE_KINDS = {"line_crossing", "loitering", "package"}
SMART_RULE_DIRECTIONS = {"any", "forward", "reverse"}
SMART_RULES_MAX = 16
SMART_RULE_LABELS_MAX = 16
PACKAGE_CHANGE_THRESHOLD_MIN = 0.05
PACKAGE_CHANGE_THRESHOLD_MAX = 3.0
PACKAGE_CHANGE_THRESHOLD_DEFAULT = 0.35
PACKAGE_STABLE_S_MIN = 2.0
PACKAGE_STABLE_S_MAX = 300.0
PACKAGE_STABLE_S_DEFAULT = 10.0
AUDIO_EVENT_LABELS = {
    "audio_smoke_alarm",
    "audio_glass_break",
    "audio_scream",
    "audio_dog_bark",
}
DETERRENCE_ACTIONS = {"light", "warning", "siren"}
DETERRENCE_DURATION_MIN = 1.0
DETERRENCE_DURATION_MAX = 60.0


def _valid_operating_mode(value, fallback: str = OPERATING_MODE_DEFAULT) -> str:
    return value if isinstance(value, str) and value in OPERATING_MODES else fallback


@dataclass
class DetectionConfig:
    """User-facing detection knobs.

    `enabled` is the new home for the on/off toggle (was previously an
    in-memory `detection_service.active`). Persisting it means:
      - The user's preference survives container restart / Jetson reboot.
      - The worker sees the change (via its config-poll thread) and stops
        running inference, freeing CPU/GPU/thermal budget — not just
        gating the event POST like before.

    `schedule_off_start` / `schedule_off_end` are HH:MM (24h, local time)
    strings. When BOTH set, the worker self-disables during that window —
    a daily "away mode" that survives across restarts. When either is null
    the schedule is off. Window can wrap midnight (e.g. 23:00 -> 06:30).

    Out of scope here (env-only on the worker for now): active/idle FPS,
    model name. Those need a worker restart to take effect; we'll surface
    them later behind an explicit "Apply & restart" flow.
    """

    threshold: float = 0.55
    cooldown_s: float = 5.0
    enabled: bool = True
    operating_mode: str = OPERATING_MODE_DEFAULT
    schedule_off_start: str | None = None
    schedule_off_end: str | None = None
    # iter-254 (Feature #1 polish): per-event clip duration knobs.
    # `clip_post_roll_s` controls how many seconds AFTER the
    # detection moment the recorder keeps writing; live-tunable in
    # the iter-202 ClipRecorder via the iter-244 unauth config-poll.
    # `clip_pre_roll_s` is the desired pre-event window; the
    # post-roll-only recorder (iter-202) ignores it today, but the
    # value persists so iter-255's rolling-segment recorder can
    # honour the user's choice on first deploy.
    clip_post_roll_s: float = 8.0
    # iter-325 (Feature #1 slice 2c follow-up): bumped 0.0 → 3.0
    # so the iter-324 pre-roll buffer lights up without a Settings
    # nudge. 3 seconds catches the typical "porch pirate approaches
    # the door" moment ahead of the trigger; users can lengthen via
    # the iter-254 Settings slider (cap is the active retention
    # preset's `pre_roll_s` ceiling).
    clip_pre_roll_s: float = 3.0
    # iter-257: which retention/clip-cap tier the operator picked.
    # Picks BOTH `recordings_retention_days` (read by the sweeper
    # via `preset_retention_days`) AND the upper cap on
    # `clip_post_roll_s` / `clip_pre_roll_s` (PATCH validates
    # against the preset's caps). Default "month" matches the
    # iter-256 retention bump.
    clip_retention_preset: str = RETENTION_PRESET_DEFAULT
    # Which COCO class names to emit events for. Default is just person —
    # most users want a doorbell, not a wildlife logger. Empty list = no
    # events at all (a more aggressive form of `enabled=false`).
    classes: list[str] = field(default_factory=lambda: ["person"])
    # iter-191 (Feature #5): in-frame polygon masks. Each zone is a
    # list of [x, y] points with normalized [0,1] coords. When zones
    # is NON-empty, the worker emits a detection event only when the
    # bbox-center falls inside at least one polygon (any-zone-match
    # passes). Empty default = no spatial gating, behaviour identical
    # to pre-iter-191. Iter-191 ships schema + persistence only;
    # iter-191b wires the worker-side filter via `point_in_polygon`,
    # iter-191c lands the client `<canvas>` editor in Settings.
    zones: list[list[list[float]]] = field(default_factory=list)
    # Areas that must never contribute detections or saved still imagery.
    # The worker conservatively redacts each polygon's bounding rectangle.
    privacy_masks: list[list[list[float]]] = field(default_factory=list)
    # iter-305 (user "How do I know which cam is which? Right now, I
    # only have 1 camera, but it is not labeled at all"): a friendly
    # display name for the camera. Used as the Live page header
    # ("Front Door"/"Back Yard"/"Driveway") and on event detail rows
    # in multi-cam future. Today single-camera deploys can rename to
    # something descriptive; multi-cam (MC Phase 1+) will move this
    # under a per-camera section.
    camera_label: str = "Front Door"
    # iter-308 (user "buy a decent mic and speaker setup so that I
    # can listen and speak through the camera system... add that
    # capability in your queue. I do not have the hardware yet, but
    # make the infrustructure in the app please"): two-way audio
    # gating flag. Default false because most deploys today don't
    # have a mic + speaker wired to the Jetson. Owner enables this
    # once the hardware is connected (Plugable USB Audio Adapter +
    # AC-powered speaker per the iter-307 research recommendation).
    # When true the Live page lights up the Talk button + a Listen
    # toggle; when false they stay disabled with "Soon" caption.
    # See memory/two_way_audio_plan_iter308.md for the WebRTC +
    # ALSA wiring design that lands when hardware arrives.
    audio_enabled: bool = False
    # iter-356.62 slice 3 (privacy controls): operator toggle for
    # face/person capture write-path. Worker reads this via the
    # iter-244 unauth /api/_internal/detection/config poll; when
    # false the worker skips the JPEG + sidecar write entirely so
    # no biometric crops land on disk in the first place. Defaults
    # to True because the existing iter-351 capture path was always
    # on; switching this off is the privacy-conscious operator's
    # opt-out without ripping the worker code.
    face_capture_enabled: bool = True
    # iter-356.62 slice 3: TTL (days) for files under
    # face_captures_dir + person_captures_dir. Server-side sweeper
    # in face_capture_sweeper.py honours this. Bounded
    # [FACE_CAPTURE_RETENTION_MIN, FACE_CAPTURE_RETENTION_MAX].
    face_capture_retention_days: int = FACE_CAPTURE_RETENTION_DEFAULT
    # Continuous-capture (visit) feature — Slice 5. The worker reads
    # these off the unauth config-poll (visit_runtime.py). Feature
    # defaults ON; `clip_post_roll_s` above stays for the legacy
    # per-event path and is NOT repurposed (plan R3).
    continuous_capture: bool = True
    # Hard cap on a single visit's duration (seconds). Clamped
    # [MAX_VISIT_MIN, MAX_VISIT_MAX] on PATCH + disk-load.
    max_visit_s: float = MAX_VISIT_DEFAULT
    # Post-roll grace after the subject leaves before finalizing the
    # visit clip. NEW field (plan R3) — distinct from clip_post_roll_s.
    # Clamped [ABSENCE_FINALIZE_MIN, ABSENCE_FINALIZE_MAX].
    absence_finalize_s: float = ABSENCE_FINALIZE_DEFAULT
    daily_digest_enabled: bool = True
    daily_digest_time: str = "20:00"
    smart_rules: list[dict[str, object]] = field(default_factory=list)
    package_change_threshold: float = PACKAGE_CHANGE_THRESHOLD_DEFAULT
    package_stable_s: float = PACKAGE_STABLE_S_DEFAULT
    audio_event_enabled: bool = False
    audio_event_labels: list[str] = field(
        default_factory=lambda: ["audio_smoke_alarm", "audio_glass_break"]
    )
    deterrence_enabled: bool = False
    deterrence_action: str = "light"
    deterrence_duration_s: float = 10.0


# Length cap for `camera_label`. iter-305: 32 chars covers
# "Living Room (East Window)" with headroom; longer strings
# blow up the Live page header on mobile (truncates ugly).
CAMERA_LABEL_MAX = 32


# Single source of truth for the HH:MM (24-hour) format the
# schedule fields accept. The route's Pydantic Field uses the same
# string verbatim — exporting it from one place keeps the wire
# contract aligned with the service-side validation.
HHMM_PATTERN = r"^([01]\d|2[0-3]):[0-5]\d$"
_HHMM_RE = re.compile(HHMM_PATTERN)


def _valid_hhmm(value: str | None) -> str | None:
    """Return value if it parses as HH:MM (24h), else None."""
    if value is None:
        return None
    if not isinstance(value, str):
        return None
    return value if _HHMM_RE.match(value) else None


def _valid_camera_label(value, fallback: str) -> str:
    """iter-305: sanitize a camera_label from disk-load or PATCH.
    Strip whitespace, reject non-strings, cap length. Empty string
    falls back to the fallback (default "Front Door") rather than
    rendering as a blank header."""
    if not isinstance(value, str):
        return fallback
    cleaned = value.strip()
    if not cleaned:
        return fallback
    return cleaned[:CAMERA_LABEL_MAX]


def _valid_zones(values) -> list[list[list[float]]]:
    """Sanitize a zones list from disk-load or PATCH payload. Tolerant
    by design — drop malformed polygons silently rather than failing
    the whole config load (a pattern symmetric with `_valid_classes`
    + `_valid_hhmm`). Returns a clean list of polygons.

    iter-191 (Feature #5). Bounds:
    - Each polygon: ZONE_VERTICES_MIN..ZONE_VERTICES_MAX points.
    - Each point: 2-element [x, y] list with x, y in [0.0, 1.0].
    - Up to ZONES_MAX polygons total (cap config file size).
    """
    if not isinstance(values, list):
        return []
    cleaned: list[list[list[float]]] = []
    for poly in values:
        if not isinstance(poly, list):
            continue
        if not (ZONE_VERTICES_MIN <= len(poly) <= ZONE_VERTICES_MAX):
            continue
        points: list[list[float]] = []
        ok = True
        for pt in poly:
            if not isinstance(pt, list) or len(pt) != 2:
                ok = False
                break
            try:
                x = float(pt[0])
                y = float(pt[1])
            except (ValueError, TypeError):
                ok = False
                break
            if not (0.0 <= x <= 1.0) or not (0.0 <= y <= 1.0):
                ok = False
                break
            points.append([x, y])
        if not ok:
            continue
        cleaned.append(points)
        if len(cleaned) >= ZONES_MAX:
            break
    return cleaned


def point_in_polygon(x: float, y: float, polygon: list[list[float]]) -> bool:
    """Ray-casting point-in-polygon test (iter-191).

    Returns True when (x, y) lies inside `polygon`. Polygon is a
    closed shape defined by its vertex list; the algorithm casts a
    horizontal ray from the point and counts intersections with the
    edges (odd = inside). Pure float math, ~32 compares for the
    largest valid polygon — cheap enough to call per detection
    event in iter-191b's worker filter.

    Degenerate input (polygon with <3 vertices) returns False — the
    caller should guard, but defending here keeps the function
    exception-free.
    """
    n = len(polygon)
    if n < 3:
        return False
    inside = False
    j = n - 1
    for i in range(n):
        xi, yi = polygon[i][0], polygon[i][1]
        xj, yj = polygon[j][0], polygon[j][1]
        # Tiny epsilon guards horizontal edges (yj == yi) where the
        # divisor would be zero. The polygon's verbal definition
        # excludes self-intersecting horizontal-only shapes anyway.
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi + 1e-12) + xi:
            inside = not inside
        j = i
    return inside


def _valid_classes(values) -> list[str]:
    """Lowercase, dedupe, drop empties, cap list length, cap per-string
    length. Tolerates non-list input (returns empty list)."""
    if not isinstance(values, list):
        return []
    seen: list[str] = []
    for v in values:
        if not isinstance(v, str):
            continue
        cleaned = v.strip().lower()
        if not cleaned or len(cleaned) > CLASS_NAME_MAX:
            continue
        if cleaned in seen:
            continue
        seen.append(cleaned)
        if len(seen) >= CLASSES_MAX:
            break
    return seen


def _valid_audio_event_labels(values) -> list[str]:
    if not isinstance(values, list):
        return []
    out: list[str] = []
    for value in values:
        if isinstance(value, str) and value in AUDIO_EVENT_LABELS and value not in out:
            out.append(value)
    return out[: len(AUDIO_EVENT_LABELS)]


def _valid_smart_rules(values) -> list[dict[str, object]]:
    """Sanitize persisted rules while retaining valid siblings."""
    if not isinstance(values, list):
        return []
    out: list[dict[str, object]] = []
    seen: set[str] = set()
    for raw in values:
        if not isinstance(raw, dict):
            continue
        rule_id = raw.get("id")
        kind = raw.get("kind")
        name = raw.get("name")
        camera_id = raw.get("camera_id", "front_door")
        if (
            not isinstance(rule_id, str)
            or SMART_RULE_ID_RE.fullmatch(rule_id) is None
            or rule_id in seen
            or kind not in SMART_RULE_KINDS
            or not isinstance(name, str)
            or not name.strip()
            or len(name.strip()) > 64
            or not isinstance(camera_id, str)
            or SMART_RULE_ID_RE.fullmatch(camera_id) is None
        ):
            continue
        points_raw = raw.get("points")
        min_points = 2 if kind == "line_crossing" else 3
        max_points = 2 if kind == "line_crossing" else 32
        if not isinstance(points_raw, list) or not (
            min_points <= len(points_raw) <= max_points
        ):
            continue
        points: list[list[float]] = []
        valid = True
        for point in points_raw:
            if not isinstance(point, list) or len(point) != 2:
                valid = False
                break
            try:
                x, y = float(point[0]), float(point[1])
            except (TypeError, ValueError):
                valid = False
                break
            if not (0.0 <= x <= 1.0 and 0.0 <= y <= 1.0):
                valid = False
                break
            points.append([x, y])
        direction = raw.get("direction", "any")
        dwell_s = _safe_float(raw.get("dwell_s", 0.0), 0.0)
        threshold = _safe_float(raw.get("threshold", 0.5), 0.5)
        if (
            not valid
            or direction not in SMART_RULE_DIRECTIONS
            or not 0.0 <= dwell_s <= 3600.0
            or not 0.0 <= threshold <= 1.0
        ):
            continue
        out.append({
            "id": rule_id,
            "name": name.strip(),
            "kind": kind,
            "enabled": bool(raw.get("enabled", True)),
            "camera_id": camera_id,
            "points": points,
            "labels": _valid_classes(raw.get("labels", []))[:SMART_RULE_LABELS_MAX],
            "direction": direction,
            "dwell_s": dwell_s,
            "threshold": threshold,
        })
        seen.add(rule_id)
        if len(out) >= SMART_RULES_MAX:
            break
    return out


def in_schedule_off_window(
    start: str | None, end: str | None, hour: int, minute: int
) -> bool:
    """Pure helper: is the local-time clock currently inside the off window?

    Returns False if either bound is missing/invalid, or if start == end
    (zero-length window — interpret as "no schedule"). Wraps across
    midnight when start > end (e.g. 23:00 → 06:00 covers 23-24 + 0-6).
    """
    if not start or not end:
        return False
    s = _valid_hhmm(start)
    e = _valid_hhmm(end)
    if s is None or e is None:
        return False
    sh, sm = map(int, s.split(":"))
    eh, em = map(int, e.split(":"))
    s_min = sh * 60 + sm
    e_min = eh * 60 + em
    if s_min == e_min:
        return False
    cur = hour * 60 + minute
    if s_min < e_min:
        return s_min <= cur < e_min
    return cur >= s_min or cur < e_min


def _valid_face_capture_retention_days(value, fallback: int) -> int:
    """iter-356.62 slice 3: clamp / coerce retention_days from disk
    or PATCH. Rejects bool (Python `isinstance(True, int)` quirk),
    non-numeric, NaN, sub-MIN, super-MAX. Bool intentionally rejected
    so a stray `true` doesn't smuggle in as `1`."""
    if isinstance(value, bool):
        return fallback
    try:
        n = int(value)
    except (ValueError, TypeError):
        return fallback
    if n < FACE_CAPTURE_RETENTION_MIN:
        return FACE_CAPTURE_RETENTION_MIN
    if n > FACE_CAPTURE_RETENTION_MAX:
        return FACE_CAPTURE_RETENTION_MAX
    return n


def _clamp(value: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, value))


def _safe_float(value, default: float) -> float:
    """Coerce a disk-loaded value to float, falling back to `default` if
    the value is missing, the wrong type (list, dict, None), or a string
    that doesn't parse. Without this, a manually-edited config like
    `{"threshold": "high"}` raises an uncaught ValueError from
    `float(...)` and prevents the server from starting."""
    try:
        return float(value)
    except (ValueError, TypeError):
        return default


class DetectionConfigStore:
    def __init__(self, path: Path | None = None) -> None:
        self.path = path if path is not None else settings.detection_config_path
        self.config = DetectionConfig()
        self._load()

    def _load(self) -> None:
        if not self.path.exists():
            return
        try:
            data = json.loads(self.path.read_text())
        except (OSError, json.JSONDecodeError) as e:
            log.warning("detection config %s unreadable: %s", self.path, e)
            return
        if not isinstance(data, dict):
            log.warning("detection config %s is not a dict; ignoring", self.path)
            return
        self.config = DetectionConfig(
            threshold=_clamp(
                _safe_float(
                    data.get("threshold", self.config.threshold),
                    self.config.threshold,
                ),
                THRESHOLD_MIN,
                THRESHOLD_MAX,
            ),
            cooldown_s=_clamp(
                _safe_float(
                    data.get("cooldown_s", self.config.cooldown_s),
                    self.config.cooldown_s,
                ),
                COOLDOWN_MIN,
                COOLDOWN_MAX,
            ),
            # `bool(None) is False` would silently disable detection if a
            # manually-edited config had `"enabled": null`. The update()
            # path already treats None as "keep current"; mirror that
            # here so disk-load semantics match.
            enabled=(
                bool(data["enabled"])
                if data.get("enabled") is not None
                else self.config.enabled
            ),
            operating_mode=_valid_operating_mode(
                data.get("operating_mode"), self.config.operating_mode
            ),
            schedule_off_start=_valid_hhmm(
                data.get("schedule_off_start", self.config.schedule_off_start)
            ),
            schedule_off_end=_valid_hhmm(
                data.get("schedule_off_end", self.config.schedule_off_end)
            ),
            classes=_valid_classes(data.get("classes", self.config.classes)),
            zones=_valid_zones(data.get("zones", self.config.zones)),
            privacy_masks=_valid_zones(
                data.get("privacy_masks", self.config.privacy_masks)
            ),
            camera_label=_valid_camera_label(
                data.get("camera_label", self.config.camera_label),
                self.config.camera_label,
            ),
            audio_enabled=(
                bool(data["audio_enabled"])
                if data.get("audio_enabled") is not None
                else self.config.audio_enabled
            ),
            face_capture_enabled=(
                bool(data["face_capture_enabled"])
                if data.get("face_capture_enabled") is not None
                else self.config.face_capture_enabled
            ),
            face_capture_retention_days=_valid_face_capture_retention_days(
                data.get(
                    "face_capture_retention_days",
                    self.config.face_capture_retention_days,
                ),
                self.config.face_capture_retention_days,
            ),
            clip_post_roll_s=_clamp(
                _safe_float(
                    data.get("clip_post_roll_s", self.config.clip_post_roll_s),
                    self.config.clip_post_roll_s,
                ),
                CLIP_POST_ROLL_MIN,
                # iter-257: clamp to the active preset's cap on
                # disk-load — a manually-edited row or a future
                # server's looser bound can't smuggle a too-long
                # value past the tier guarantee.
                preset_clip_post_roll_max(
                    str(data.get("clip_retention_preset", RETENTION_PRESET_DEFAULT))
                ),
            ),
            clip_pre_roll_s=_clamp(
                _safe_float(
                    data.get("clip_pre_roll_s", self.config.clip_pre_roll_s),
                    self.config.clip_pre_roll_s,
                ),
                CLIP_PRE_ROLL_MIN,
                preset_clip_pre_roll_max(
                    str(data.get("clip_retention_preset", RETENTION_PRESET_DEFAULT))
                ),
            ),
            clip_retention_preset=(
                data["clip_retention_preset"]
                if data.get("clip_retention_preset") in RETENTION_PRESETS
                else RETENTION_PRESET_DEFAULT
            ),
            continuous_capture=(
                bool(data["continuous_capture"])
                if data.get("continuous_capture") is not None
                else self.config.continuous_capture
            ),
            max_visit_s=_clamp(
                _safe_float(
                    data.get("max_visit_s", self.config.max_visit_s),
                    self.config.max_visit_s,
                ),
                MAX_VISIT_MIN,
                MAX_VISIT_MAX,
            ),
            absence_finalize_s=_clamp(
                _safe_float(
                    data.get("absence_finalize_s", self.config.absence_finalize_s),
                    self.config.absence_finalize_s,
                ),
                ABSENCE_FINALIZE_MIN,
                ABSENCE_FINALIZE_MAX,
            ),
            daily_digest_enabled=(
                bool(data["daily_digest_enabled"])
                if data.get("daily_digest_enabled") is not None
                else self.config.daily_digest_enabled
            ),
            daily_digest_time=(
                _valid_hhmm(data.get("daily_digest_time"))
                or self.config.daily_digest_time
            ),
            smart_rules=_valid_smart_rules(
                data.get("smart_rules", self.config.smart_rules)
            ),
            package_change_threshold=_clamp(
                _safe_float(
                    data.get(
                        "package_change_threshold",
                        self.config.package_change_threshold,
                    ),
                    self.config.package_change_threshold,
                ),
                PACKAGE_CHANGE_THRESHOLD_MIN,
                PACKAGE_CHANGE_THRESHOLD_MAX,
            ),
            package_stable_s=_clamp(
                _safe_float(
                    data.get("package_stable_s", self.config.package_stable_s),
                    self.config.package_stable_s,
                ),
                PACKAGE_STABLE_S_MIN,
                PACKAGE_STABLE_S_MAX,
            ),
            audio_event_enabled=(
                bool(data["audio_event_enabled"])
                if data.get("audio_event_enabled") is not None
                else self.config.audio_event_enabled
            ),
            audio_event_labels=_valid_audio_event_labels(
                data.get("audio_event_labels", self.config.audio_event_labels)
            ),
            deterrence_enabled=(
                bool(data["deterrence_enabled"])
                if data.get("deterrence_enabled") is not None
                else self.config.deterrence_enabled
            ),
            deterrence_action=(
                data["deterrence_action"]
                if data.get("deterrence_action") in DETERRENCE_ACTIONS
                else self.config.deterrence_action
            ),
            deterrence_duration_s=_clamp(
                _safe_float(
                    data.get(
                        "deterrence_duration_s", self.config.deterrence_duration_s
                    ),
                    self.config.deterrence_duration_s,
                ),
                DETERRENCE_DURATION_MIN,
                DETERRENCE_DURATION_MAX,
            ),
        )
        log.info("loaded detection config: %s", asdict(self.config))

    def _save(self) -> None:
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.path.with_suffix(self.path.suffix + ".tmp")
            tmp.write_text(json.dumps(asdict(self.config)))
            os.replace(tmp, self.path)
            try:
                self.path.chmod(0o600)
            except OSError:
                pass
        except OSError as e:
            log.warning("could not persist detection config to %s: %s", self.path, e)

    def get(self) -> DetectionConfig:
        return self.config

    def update(self, **patch) -> DetectionConfig:
        """Partial update. Only keys present in `patch` are touched —
        callers should use `model.model_dump(exclude_unset=True)` to
        preserve the "not provided" vs "explicitly null" distinction.

        For schedule fields, `None` means "clear the schedule".
        """
        cur = self.config
        threshold = (
            _clamp(patch["threshold"], THRESHOLD_MIN, THRESHOLD_MAX)
            if "threshold" in patch and patch["threshold"] is not None
            else cur.threshold
        )
        cooldown_s = (
            _clamp(patch["cooldown_s"], COOLDOWN_MIN, COOLDOWN_MAX)
            if "cooldown_s" in patch and patch["cooldown_s"] is not None
            else cur.cooldown_s
        )
        enabled = (
            bool(patch["enabled"])
            if "enabled" in patch and patch["enabled"] is not None
            else cur.enabled
        )
        operating_mode = (
            _valid_operating_mode(patch["operating_mode"], cur.operating_mode)
            if "operating_mode" in patch and patch["operating_mode"] is not None
            else cur.operating_mode
        )
        schedule_off_start = (
            _valid_hhmm(patch["schedule_off_start"])
            if "schedule_off_start" in patch
            else cur.schedule_off_start
        )
        schedule_off_end = (
            _valid_hhmm(patch["schedule_off_end"])
            if "schedule_off_end" in patch
            else cur.schedule_off_end
        )
        classes = (
            _valid_classes(patch["classes"]) if "classes" in patch else cur.classes
        )
        zones = _valid_zones(patch["zones"]) if "zones" in patch else cur.zones
        privacy_masks = (
            _valid_zones(patch["privacy_masks"])
            if "privacy_masks" in patch else cur.privacy_masks
        )
        camera_label = (
            _valid_camera_label(patch["camera_label"], cur.camera_label)
            if "camera_label" in patch and patch["camera_label"] is not None
            else cur.camera_label
        )
        audio_enabled = (
            bool(patch["audio_enabled"])
            if "audio_enabled" in patch and patch["audio_enabled"] is not None
            else cur.audio_enabled
        )
        face_capture_enabled = (
            bool(patch["face_capture_enabled"])
            if "face_capture_enabled" in patch
            and patch["face_capture_enabled"] is not None
            else cur.face_capture_enabled
        )
        face_capture_retention_days = (
            _valid_face_capture_retention_days(
                patch["face_capture_retention_days"],
                cur.face_capture_retention_days,
            )
            if "face_capture_retention_days" in patch
            and patch["face_capture_retention_days"] is not None
            else cur.face_capture_retention_days
        )
        # iter-257: preset MUST be resolved before clip durations so
        # the durations clamp to the new preset's cap (not the
        # previous one). Same patch can change preset AND
        # clip_post_roll_s — the new preset wins.
        if (
            "clip_retention_preset" in patch
            and patch["clip_retention_preset"] in RETENTION_PRESETS
        ):
            clip_retention_preset = patch["clip_retention_preset"]
        else:
            clip_retention_preset = cur.clip_retention_preset
        post_max = preset_clip_post_roll_max(clip_retention_preset)
        pre_max = preset_clip_pre_roll_max(clip_retention_preset)
        clip_post_roll_s = (
            _clamp(patch["clip_post_roll_s"], CLIP_POST_ROLL_MIN, post_max)
            if "clip_post_roll_s" in patch and patch["clip_post_roll_s"] is not None
            else _clamp(cur.clip_post_roll_s, CLIP_POST_ROLL_MIN, post_max)
        )
        clip_pre_roll_s = (
            _clamp(patch["clip_pre_roll_s"], CLIP_PRE_ROLL_MIN, pre_max)
            if "clip_pre_roll_s" in patch and patch["clip_pre_roll_s"] is not None
            else _clamp(cur.clip_pre_roll_s, CLIP_PRE_ROLL_MIN, pre_max)
        )
        continuous_capture = (
            bool(patch["continuous_capture"])
            if "continuous_capture" in patch
            and patch["continuous_capture"] is not None
            else cur.continuous_capture
        )
        max_visit_s = (
            _clamp(patch["max_visit_s"], MAX_VISIT_MIN, MAX_VISIT_MAX)
            if "max_visit_s" in patch and patch["max_visit_s"] is not None
            else cur.max_visit_s
        )
        absence_finalize_s = (
            _clamp(
                patch["absence_finalize_s"],
                ABSENCE_FINALIZE_MIN,
                ABSENCE_FINALIZE_MAX,
            )
            if "absence_finalize_s" in patch
            and patch["absence_finalize_s"] is not None
            else cur.absence_finalize_s
        )
        daily_digest_enabled = (
            bool(patch["daily_digest_enabled"])
            if "daily_digest_enabled" in patch and patch["daily_digest_enabled"] is not None
            else cur.daily_digest_enabled
        )
        daily_digest_time = (
            _valid_hhmm(patch["daily_digest_time"])
            if "daily_digest_time" in patch and patch["daily_digest_time"] is not None
            else cur.daily_digest_time
        ) or cur.daily_digest_time
        smart_rules = (
            _valid_smart_rules(patch["smart_rules"])
            if "smart_rules" in patch else cur.smart_rules
        )
        package_change_threshold = (
            _clamp(
                patch["package_change_threshold"],
                PACKAGE_CHANGE_THRESHOLD_MIN,
                PACKAGE_CHANGE_THRESHOLD_MAX,
            )
            if patch.get("package_change_threshold") is not None
            else cur.package_change_threshold
        )
        package_stable_s = (
            _clamp(
                patch["package_stable_s"],
                PACKAGE_STABLE_S_MIN,
                PACKAGE_STABLE_S_MAX,
            )
            if patch.get("package_stable_s") is not None
            else cur.package_stable_s
        )
        audio_event_enabled = (
            bool(patch["audio_event_enabled"])
            if patch.get("audio_event_enabled") is not None
            else cur.audio_event_enabled
        )
        audio_event_labels = (
            _valid_audio_event_labels(patch["audio_event_labels"])
            if "audio_event_labels" in patch else cur.audio_event_labels
        )
        deterrence_enabled = (
            bool(patch["deterrence_enabled"])
            if patch.get("deterrence_enabled") is not None
            else cur.deterrence_enabled
        )
        deterrence_action = (
            patch["deterrence_action"]
            if patch.get("deterrence_action") in DETERRENCE_ACTIONS
            else cur.deterrence_action
        )
        deterrence_duration_s = (
            _clamp(
                patch["deterrence_duration_s"],
                DETERRENCE_DURATION_MIN,
                DETERRENCE_DURATION_MAX,
            )
            if patch.get("deterrence_duration_s") is not None
            else cur.deterrence_duration_s
        )
        self.config = DetectionConfig(
            threshold=threshold,
            cooldown_s=cooldown_s,
            enabled=enabled,
            operating_mode=operating_mode,
            schedule_off_start=schedule_off_start,
            schedule_off_end=schedule_off_end,
            classes=classes,
            zones=zones,
            privacy_masks=privacy_masks,
            clip_post_roll_s=clip_post_roll_s,
            clip_pre_roll_s=clip_pre_roll_s,
            clip_retention_preset=clip_retention_preset,
            camera_label=camera_label,
            audio_enabled=audio_enabled,
            face_capture_enabled=face_capture_enabled,
            face_capture_retention_days=face_capture_retention_days,
            continuous_capture=continuous_capture,
            max_visit_s=max_visit_s,
            absence_finalize_s=absence_finalize_s,
            daily_digest_enabled=daily_digest_enabled,
            daily_digest_time=daily_digest_time,
            smart_rules=smart_rules,
            package_change_threshold=package_change_threshold,
            package_stable_s=package_stable_s,
            audio_event_enabled=audio_event_enabled,
            audio_event_labels=audio_event_labels,
            deterrence_enabled=deterrence_enabled,
            deterrence_action=deterrence_action,
            deterrence_duration_s=deterrence_duration_s,
        )
        self._save()
        return self.config


detection_config = DetectionConfigStore()
