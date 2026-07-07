#!/usr/bin/env python3
"""
Real-time person detection for Home Camera System.

Subscribes to the MediaMTX RTSP feed (rtsp://localhost:8554/cam by default),
decodes via the Jetson hardware H.264 decoder (NVDEC) through jetson-utils,
runs SSD-MobileNet-v2 via jetson-inference (TensorRT FP16, ~25 fps on a
Jetson Nano 2GB), and POSTs detection events to the FastAPI server's
internal endpoint.

Runs as a systemd service on the Jetson host (NOT in the Docker container) —
jetson-inference depends on the L4T-specific CUDA / TensorRT stack that's
on the host, and Python 3.6 is what JetPack 4.x ships.

Why RTSP and not a tee+shmsink off the camera capture pipeline:
  - JetPack's stock apt OpenCV (3.2.0) is built without GStreamer support,
    so cv2 can't read from shmsrc. jetson-utils' videoSource handles RTSP
    natively via NVDEC.
  - HW H.264 decode on a Nano 2GB is essentially free (<10 % NVDEC).
  - Single producer (mediamtx) makes lifecycle simpler — the detection
    worker doesn't depend on any extra GStreamer pipeline staying alive.

Environment variables (all optional):
    DETECT_SOURCE       videoSource URI (default rtsp://localhost:8554/cam)
    DETECT_THRESHOLD    detection confidence floor [0..1] (default 0.55)
    DETECT_COOLDOWN_S   minimum gap between emitted events (default 5.0)
    DETECT_MODEL        jetson-inference model name (default ssd-mobilenet-v2)
    DETECT_ACTIVE_FPS   max inference rate when something was detected
                        recently (default 5.0)
    DETECT_IDLE_FPS     max inference rate during idle, i.e. no detections
                        in DETECT_IDLE_AFTER_S (default 1.0)
    DETECT_IDLE_AFTER_S seconds of no detections before dropping to idle
                        rate (default 15.0)
    DETECT_THUMB_DIR    where to write per-event JPEG thumbnails (default
                        /home/israel/HomeCameraSystem/snapshots — this is the
                        host side of the docker-compose bind mount on /app/snapshots)
    DETECT_THUMB_MAX    keep this many most-recent thumbnails (default 100)
    DETECT_THUMB_QUALITY  JPEG quality 1-100 (default 70)
    EVENT_URL           server endpoint (default http://127.0.0.1:8000/api/_internal/event)
    CAMERA_ID           id sent in events (default cam1)
    PERSON_CLASS_ID     COCO id for the person class (default 1)

Why an idle gear: SSD-MobileNet-v2 on the Nano 2GB runs at ~22 fps if you
let it. That keeps the CUDA cores busy 24/7 and pushes thermals to the 87 °C
throttle setpoint. We don't actually need 22 fps for a doorbell — bumping up
to 5 fps when motion is happening is plenty, and dropping to 1 fps while
idle keeps the GPU cool enough to leave headroom for the encoder.
"""
import json
import math
import os
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import uuid

import jetson_inference
import jetson_utils

# Local helper modules sit next to this script; we keep the face_recog
# dir name distinct from the pip-installed `face_recognition` package so
# the wrapper can `import face_recognition` cleanly.
_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)
# applog is pure-stdlib (logging/os/sys) — no CUDA/native deps, so importing
# it here (after the sys.path insert, even before the jetson imports ran
# above) carries no static-TLS risk. main() calls applog.configure() first
# thing so the leaf-lib `logging` records + the hot-loop `[tag]` prints all
# land in journald with one format.
import applog  # noqa: E402

# Leaf-style logger for the worker. `applog.configure()` (called first
# thing in main()) installs the root handler so these records reach
# journald. Hot-loop breadcrumbs use `applog.emit("detect", ...)` so a
# broken pipe can never crash the inference loop; structured failure
# lines outside the per-frame inner path use `log.error/.warning/.info`.
log = applog.get_logger("detect")
try:
    from face_recog.recognizer import FaceRecognizer  # noqa: E402
except Exception as _fr_import_err:
    # Import-disable site: the wrapper module failed to import (missing
    # file, syntax error, or a transitive dep like cv2 unavailable).
    # Worker still runs but never touches face surfaces. Log WHY at
    # WARNING so an operator who expected face-recog sees the reason
    # instead of a silently dormant feature. (configure() hasn't run
    # yet at import time, but the record is buffered/handled once main()
    # installs the root handler; emit() is the belt-and-suspenders path.)
    FaceRecognizer = None
    applog.emit(
        "detect",
        "face_recog wrapper import failed ({}: {}) - face capture "
        "disabled".format(type(_fr_import_err).__name__, _fr_import_err),
    )
# iter-356.62 (slice 1): single read at import time. Worker boots
# rarely, deploy script can stamp `HOMECAM_SW_REV` via systemd unit env;
# absent → "unknown" so sidecars still record the field consistently.
_SW_REV = os.getenv("HOMECAM_SW_REV", "unknown")

# iter-357 (multi-person face-recog): bounded fan-out over the
# person bboxes for face recognition. Pre-iter-357 only the
# single highest-confidence person bbox got the face-region +
# recognize_in_crop pass; other people in frame contributed zero
# face captures and zero recognized names. The cap protects the
# Nano: each HOG face-locate is ~200 ms on a 720 p crop, so an
# unbounded loop on a frame with 10 detected people would burn
# ~2 s of CPU before the cooldown gate clears. With the default
# cap of 4 the worst-case is ~800 ms once per cooldown period (5 s
# default) which holds the worker under one full frame's slack.
# Setting `HOMECAM_MAX_PERSONS_FACE_RECOG=1` reverts to the
# single-person path. Setting `=0` disables face recognition for
# multi-person events entirely (useful if an operator hits a
# thermal cliff and wants to keep people-as-overlay-only). The
# value is read once at startup — no per-frame env lookup.
def _read_max_persons():
    """Read HOMECAM_MAX_PERSONS_FACE_RECOG at startup. Default 4.
    Negative values clamp to 0; non-integer strings fall back to 4.
    Returns int."""
    raw = os.getenv("HOMECAM_MAX_PERSONS_FACE_RECOG", "4")
    try:
        v = int(raw)
    except (TypeError, ValueError):
        return 4
    if v < 0:
        return 0
    # Hard ceiling at 16 to keep an over-eager operator from
    # accidentally setting "999" and stalling the worker on a
    # crowd scene. The SSD model itself caps at 32 boxes via
    # detectNet, but face-recog cost is the bound that matters.
    return min(v, 16)


_MAX_PERSONS_FACE_RECOG = _read_max_persons()


def _bbox_iou(a_left, a_top, a_right, a_bot, b_left, b_top, b_right, b_bot):
    """Pixel-coord IoU between two axis-aligned bboxes. Returns
    0.0 when either box is degenerate. Used in the multi-person
    face-recog loop to skip a candidate person bbox that overlaps
    heavily with one we've already processed (SSD occasionally
    returns two bboxes for the same physical person, especially
    when the person is partially occluded — those duplicates would
    otherwise produce duplicate face captures with the same face).
    Pure-Python; no numpy import needed (caller has integers
    already from `_clamped_person_bbox`)."""
    inter_left = max(a_left, b_left)
    inter_top = max(a_top, b_top)
    inter_right = min(a_right, b_right)
    inter_bot = min(a_bot, b_bot)
    iw = inter_right - inter_left
    ih = inter_bot - inter_top
    if iw <= 0 or ih <= 0:
        return 0.0
    inter = float(iw * ih)
    a_area = float(max(0, a_right - a_left) * max(0, a_bot - a_top))
    b_area = float(max(0, b_right - b_left) * max(0, b_bot - b_top))
    union = a_area + b_area - inter
    if union <= 0:
        return 0.0
    return inter / union


# 0.5 IoU threshold for the duplicate-person check. Picked because
# legitimate two-people-side-by-side detections IoU at ~0.1-0.2
# (clear horizontal separation), whereas the SSD double-detect of
# a partially-occluded person typically lands at IoU > 0.7 (same
# bounding region with sub-pixel jitter). 0.5 is the standard
# COCO-style "match" threshold and gives clear margin both ways.
_PERSON_DEDUP_IOU = 0.5

# Presence coalescing: if the same (label, camera) hasn't been detected for
# this many seconds, the subject is considered to have LEFT — the next
# detection starts a fresh event. Short enough that genuinely separate visits
# stay separate, long enough that a brief occlusion / step-out-of-frame within
# one visit doesn't spuriously re-trigger. See detection/presence.py.
_PRESENCE_GAP_S = 20.0

from box_norm import normalize_box  # noqa: E402
from mediamtx_watchdog import (  # noqa: E402
    ACTION_REBOOT,
    ACTION_RESTART_MEDIAMTX,
    ACTION_RESTART_NVARGUS,
    MediaMtxWatchdog,
)
import sdnotify  # noqa: E402  (systemd Type=notify liveness; no-op off-systemd)
from memory_guard import MemoryGuard, read_mem_available_mb  # noqa: E402
from metrics import Metrics  # noqa: E402
from presence import PresenceTracker  # noqa: E402
import visit_runtime  # noqa: E402  (continuous-capture wiring + recovery, S4)
from schedule import in_off_window  # noqa: E402
from thermal_guard import ThermalGuard, read_gpu_temp_c  # noqa: E402
from zones import any_box_center_inside_any_zone, sanitize_zones  # noqa: E402

# Note: `nvbuf_utils` / `dmabuf_fd` / `gstBufferManager` warnings come straight
# from C code, not Python's stderr — a Python-level fd-redirect doesn't catch
# them. They're filtered at the shell level by detection/run-detect.sh, which
# is what the systemd unit actually invokes. Run detect.py directly only when
# debugging; the noise lines will reappear.


def save_thumb(cuda_img, ts, thumb_dir, max_keep, quality):
    """Save a JPEG thumbnail of the detection frame. Returns the URL the
    server will serve it at, or None on failure (the event still publishes).

    Trims the thumb directory to `max_keep` most-recent files so we don't
    fill the disk over time."""
    try:
        os.makedirs(thumb_dir, exist_ok=True)
        name = "thumb_{:.0f}.jpg".format(ts * 1000)
        path = os.path.join(thumb_dir, name)
        jetson_utils.saveImage(path, cuda_img, quality=quality)
    except Exception as e:
        # Thumb save failed: the event still publishes (returns None ->
        # caller omits `thumb_url`), but the push-notification hero image
        # + Events thumbnail will be missing. Name the dir + reason so an
        # operator can tell disk-full / RO-mount / bad-extension apart.
        # Runs at most once per emitted event (cooldown-gated), not
        # per-frame. Caller bumps `thumb_save_failures` on the None return.
        log.error(
            "thumb save failed for dir=%s: %s: %s",
            thumb_dir, type(e).__name__, e,
        )
        return None

    try:
        files = sorted(
            f for f in os.listdir(thumb_dir)
            if f.startswith("thumb_") and f.endswith(".jpg")
        )
        for old in files[:-max_keep]:
            try:
                os.unlink(os.path.join(thumb_dir, old))
            except OSError:
                pass
    except OSError:
        pass

    return "/snapshots/" + name


def _env(name, default, cast=str):
    raw = os.environ.get(name)
    if raw is None or raw == "":
        return default
    try:
        return cast(raw)
    except (TypeError, ValueError):
        print("[detect] bad value for {}={!r}; using default {!r}".format(name, raw, default), flush=True)
        return default


def _enforce_mem_floor(read_mem_fn, floor_mb):
    """Startup mem-floor gate. iter-356.62 (camera-algorithm-auditor
    pre-YOLO win 3): TensorRT engine workspace allocation can demand
    ~150-300 MB during `detectNet(...)` construction. If MemAvailable
    is already below ~400 MB at boot (e.g. because the operator left
    Chrome open on the Jetson), we get OOM-killed by SIGKILL during
    engine load — no traceback, no log, just a silent service
    restart loop.

    This gate runs ONCE before model load and aborts with a clear
    error message + exit code 3 if MemAvailable < floor_mb. The
    runtime `MemoryGuard` (continuous, post-load) is a different
    mechanism: it pauses INFERENCE while keeping capture alive so
    metrics keep flowing; this gate refuses to start at all so
    systemd's RestartSec gives the operator a chance to free RAM.

    Factored to take `read_mem_fn` as a parameter so tests can
    substitute a fake without patching `/proc/meminfo`.
    """
    avail = read_mem_fn()
    if avail is None:
        # /proc/meminfo unreadable — pass through rather than block
        # boot. This is the dev-host case (the test suite runs here).
        return
    if avail < floor_mb:
        msg = (
            "[detect] FATAL: mem-floor gate refused to start "
            "(MemAvailable={:.0f} MB < {:.0f} MB floor). "
            "Free RAM (close Chrome / kill stale workers) and the "
            "service will retry. Override with DETECT_MIN_FREE_MEM_MB."
        ).format(avail, floor_mb)
        print(msg, flush=True)
        # Exit code 3 = startup gate refusal (distinct from generic 1).
        raise SystemExit(3)


def post_event(url, payload, timeout=2.0, metrics=None):
    """POST one detection event to the server's internal endpoint.

    The event is LOST on failure — there is no retry queue. We log WHY
    at ERROR and bump `metrics.event_post_failures` (when `metrics` is
    supplied) so the operator sees both the first occurrence in journald
    AND the rate over time on /api/status, since a silent POST failure
    looks identical to "camera saw nobody."

    Two distinct failure classes are logged apart:
      * HTTPError (4xx/5xx) — the server answered. A 422 means a
        permanent schema drift between worker payload and the server's
        `extra='forbid'` validator (the event will NEVER post until a
        deploy); a 5xx is transient server trouble. The status + reason
        + a short body tail disambiguate. We log `event_id` (safe — it's
        the same uuid that flows through the rest of the system) but
        NEVER the full payload (carries person_name + thumb URLs).
      * everything else — transient network reject (server restarting,
        loopback not yet listening). No status code.
    """
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=body, method="POST")
    req.add_header("Content-Type", "application/json")
    event_id = payload.get("id") if isinstance(payload, dict) else None
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            resp.read()
    except urllib.error.HTTPError as e:
        try:
            detail = e.read().decode("utf-8", "replace")[:200]
        except Exception:
            detail = ""
        log.error(
            "event POST rejected for id=%s: HTTP %s %s (event LOST, no "
            "retry) %s", event_id, e.code, e.reason, detail,
        )
        if metrics is not None:
            metrics.event_post_failures += 1
    except Exception as e:
        log.error(
            "event POST failed for id=%s: %s: %s (event LOST, no retry)",
            event_id, type(e).__name__, e,
        )
        if metrics is not None:
            metrics.event_post_failures += 1


class RuntimeConfig:
    """Live-tunable knobs polled from /api/detection/config.

    Inference loop reads `threshold`, `cooldown_s`, and `enabled` per
    iteration so the user can drag sliders / flip the toggle in Settings
    and the change takes effect within one polling interval.

    detectNet is loaded with a fixed low floor (0.05) — we filter manually
    in Python against `runtime.threshold`. Re-creating detectNet on every
    threshold change costs ~6 s of TRT engine deserialise, so we don't.

    `enabled=False` skips `net.Detect()` entirely. The worker still drains
    frames (so the camera pipeline doesn't back up) but burns no CUDA.
    Big thermal win for "away" / overnight use.
    """

    DETECT_FLOOR = 0.05

    def __init__(self, threshold=0.55, cooldown_s=5.0, enabled=True):
        self.threshold = threshold
        self.cooldown_s = cooldown_s
        self.enabled = enabled
        # HH:MM strings (24h, local time) defining a daily off-window;
        # both must be set for the schedule to apply.
        self.schedule_off_start = None
        self.schedule_off_end = None
        # Lower-cased class names the worker should emit events for.
        # Empty list = nothing fires.
        self.classes = ["person"]
        # iter-191b (Feature #5): list of polygons (each polygon is a
        # list of [x, y] points with normalized [0,1] coords). Empty
        # list = no spatial gating (default = pre-iter-191 behaviour).
        # When non-empty, emit events only when at least one
        # detection box's center falls inside any polygon.
        self.zones = []
        # iter-254 (Feature #1 polish): live-tunable per-event clip
        # duration. `clip_post_roll_s` is honoured by the iter-202
        # ClipRecorder.start_clip call below (passed per-event so
        # the slider takes effect on the NEXT detection without a
        # worker restart). `clip_pre_roll_s` is persisted but
        # ignored until iter-255 lands the rolling-segment recorder.
        self.clip_post_roll_s = 8.0
        self.clip_pre_roll_s = 0.0
        # Continuous-capture (person-following) feature, plan S4. Default OFF
        # (hard XOR with the legacy start_clip path). The flag + knobs are
        # resolved from env + this polled config via
        # `visit_runtime.resolve_continuous_config`; the loop reads them live
        # so an operator can flip the toggle / drag the sliders without a
        # worker restart. Seeded from env at construction in main().
        self.continuous_capture = False
        self.max_visit_s = 150.0
        self.absence_finalize_s = 10.0

    def schedule_says_off(self):
        """True if the current local time is inside the off-window.

        Pure logic delegated to `schedule.in_off_window` (testable
        without monkeypatching `time.localtime`); this method just
        plugs in the current local-time minute-of-day.
        """
        now = time.localtime()
        cur = now.tm_hour * 60 + now.tm_min
        return in_off_window(self.schedule_off_start, self.schedule_off_end, cur)


def apply_config(runtime, data):
    """Apply a polled config dict to `runtime`, field by field.

    Returns a list of ``(field, reason)`` tuples for any field that was
    PRESENT in `data` but failed to cast to the runtime type. Pre-logging
    this used a single outer try/except so one bad field (e.g.
    ``threshold="abc"``) raised and discarded the WHOLE update — the
    operator's other slider changes silently never took effect. Now each
    field is applied independently: a bad ``threshold`` is reported and
    skipped while ``cooldown_s`` / ``enabled`` / zones still apply.

    Pure function (no I/O, no logging) so the per-field cast behaviour
    can be unit-tested without a live server or a logger fixture. The
    caller (`start_config_poll`) turns the returned warnings into
    re-arming once-flag log lines.
    """
    warnings = []  # list of (field, reason)
    if "threshold" in data:
        try:
            runtime.threshold = float(data["threshold"])
        except (TypeError, ValueError) as e:
            warnings.append(("threshold", "{}".format(e)))
    if "cooldown_s" in data:
        try:
            runtime.cooldown_s = float(data["cooldown_s"])
        except (TypeError, ValueError) as e:
            warnings.append(("cooldown_s", "{}".format(e)))
    if "enabled" in data:
        # bool() never raises, but a non-bool truthy (e.g. the string
        # "false", which is truthy!) is a server/worker drift worth
        # flagging rather than silently coercing.
        val = data["enabled"]
        if isinstance(val, bool):
            runtime.enabled = val
        else:
            runtime.enabled = bool(val)
            warnings.append((
                "enabled",
                "non-bool {!r} coerced to {}".format(val, runtime.enabled),
            ))
    if "schedule_off_start" in data:
        runtime.schedule_off_start = data["schedule_off_start"]
    if "schedule_off_end" in data:
        runtime.schedule_off_end = data["schedule_off_end"]
    if "classes" in data:
        raw = data["classes"]
        if isinstance(raw, list):
            runtime.classes = [
                c.strip().lower() for c in raw
                if isinstance(c, str) and c.strip()
            ]
        else:
            warnings.append((
                "classes",
                "expected list, got {}".format(type(raw).__name__),
            ))
    # iter-191b (Feature #5): zones from the server config.
    # `sanitize_zones` mirrors server-side `_valid_zones` bounds
    # (3-32 vertices, coords [0,1], up to 16 polys) so a transient
    # corrupt payload or downgraded server can't poison the runtime.
    if "zones" in data:
        try:
            runtime.zones = sanitize_zones(data["zones"])
        except Exception as e:
            warnings.append(("zones", "{}: {}".format(type(e).__name__, e)))
    if "clip_post_roll_s" in data:
        try:
            runtime.clip_post_roll_s = float(data["clip_post_roll_s"])
        except (TypeError, ValueError) as e:
            warnings.append(("clip_post_roll_s", "{}".format(e)))
    if "clip_pre_roll_s" in data:
        try:
            runtime.clip_pre_roll_s = float(data["clip_pre_roll_s"])
        except (TypeError, ValueError) as e:
            warnings.append(("clip_pre_roll_s", "{}".format(e)))
    # Continuous-capture flag + knobs (plan S4). Config-poll overrides the
    # env-seeded values so the operator can flip the feature live. Resolution
    # (incl. precedence + bad-cast guarding) lives in visit_runtime, but we
    # re-apply onto `runtime` field-by-field here so the existing per-field
    # warning machinery still reports a fat-fingered slider.
    if "continuous_capture" in data:
        runtime.continuous_capture = bool(data["continuous_capture"])
    if "max_visit_s" in data:
        try:
            v = float(data["max_visit_s"])
            if v > 0:
                runtime.max_visit_s = v
            else:
                warnings.append(("max_visit_s", "non-positive {!r}".format(v)))
        except (TypeError, ValueError) as e:
            warnings.append(("max_visit_s", "{}".format(e)))
    if "absence_finalize_s" in data:
        try:
            v = float(data["absence_finalize_s"])
            if v > 0:
                runtime.absence_finalize_s = v
            else:
                warnings.append(
                    ("absence_finalize_s", "non-positive {!r}".format(v))
                )
        except (TypeError, ValueError) as e:
            warnings.append(("absence_finalize_s", "{}".format(e)))
    return warnings


def start_config_poll(url, runtime, preroll_buffer=None, interval_s=30.0):
    """Periodically GET the config endpoint and update `runtime`. Runs as
    a daemon thread; failures are logged once per backoff cycle so a brief
    server-restart blip doesn't fill the journal.

    iter-356.61: when `preroll_buffer` is supplied, the poll also grows
    the segment-recorder ring on demand whenever the live
    `clip_pre_roll_s` exceeds the current ring's window. Lets the
    Settings "Pre-roll" slider take effect on the next event without a
    worker restart, even when the user pushes the value above the
    PrerollBuffer's boot-time `DEFAULT_CAPACITY`. Never shrinks (would
    lose history mid-capture)."""

    def loop():
        backoff = 1.0
        warned = False
        # Per-field "warned-once" set so a PERSISTENT bad field
        # (server/worker schema drift that never self-heals) logs once
        # then stays quiet, but RE-ARMS the moment that field next
        # casts cleanly — a clean poll clears the whole set so a future
        # regression logs again instead of being silenced forever (the
        # plan §4 re-arm guardrail). Keyed by field name.
        field_warned = set()
        while True:
            try:
                req = urllib.request.Request(url, method="GET")
                with urllib.request.urlopen(req, timeout=2.0) as resp:
                    data = json.loads(resp.read().decode("utf-8"))
                # Apply field-by-field (pure helper). A bad single field
                # no longer discards the whole update — it's reported and
                # skipped while the other fields still take effect.
                cast_warnings = apply_config(runtime, data)
                bad_fields = set(f for f, _r in cast_warnings)
                for field, reason in cast_warnings:
                    if field not in field_warned:
                        log.warning(
                            "config poll: field %r failed to apply (%s); "
                            "skipped, other fields still applied", field, reason,
                        )
                        field_warned.add(field)
                # Re-arm: any field that's now healthy drops out of the
                # warned set so a later regression on it logs afresh.
                field_warned &= bad_fields
                # iter-356.61: grow the segment-recorder ring if the
                # slider asked for more pre-roll than the current
                # capacity covers. No-op when the ring already has
                # enough headroom; never shrinks.
                if preroll_buffer is not None and "clip_pre_roll_s" in data:
                    try:
                        preroll_buffer.ensure_capacity_for(
                            runtime.clip_pre_roll_s,
                        )
                    except Exception as _e:
                        log.warning(
                            "preroll ring resize failed for pre_roll_s=%s: "
                            "%s: %s (buffer stays at current capacity)",
                            runtime.clip_pre_roll_s, type(_e).__name__, _e,
                        )
                backoff = 1.0
                warned = False
            except Exception as e:
                # Whole-poll failure (network reject, server down,
                # unparseable body). Re-arming once-flag: log once per
                # outage, re-arm on the next successful poll so a fresh
                # outage is visible. Distinct from the per-field warnings
                # above (which fire when the server answered but a value
                # was bad).
                if not warned:
                    log.warning(
                        "config poll failed (live config frozen at last "
                        "good values): %s: %s", type(e).__name__, e,
                    )
                    warned = True
                backoff = min(backoff * 2, 60.0)
            time.sleep(interval_s if backoff <= 1.0 else min(backoff, 60.0))

    t = threading.Thread(target=loop, daemon=True, name="config-poll")
    t.start()
    return t


class Liveness:
    """Shared mutable state between the main inference loop and the
    heartbeat thread. The loop calls `bump()` on every iteration; the
    heartbeat thread only POSTs while `bump()` has been called recently.

    If the main loop crashes or wedges (e.g. `net.Detect()` deadlocks),
    `bump()` stops being called, the heartbeat goes silent, the server's
    `WorkerHealth` window expires, and the UI's "DETECTION OFFLINE" pill
    appears within 30 s. Without this gate, a daemon heartbeat thread
    happily POSTs "I'm fine" while the worker is actually dead.
    """

    def __init__(self):
        self.last_active = time.time()

    def bump(self):
        self.last_active = time.time()

    def stale(self, threshold_s):
        return (time.time() - self.last_active) > threshold_s


def start_heartbeat(url, liveness, metrics, interval_s=10.0, stale_threshold_s=30.0):
    """Background thread that POSTs to the server's heartbeat endpoint —
    but only if the main inference loop has shown signs of life recently.
    Payload is a JSON snapshot of the inference metrics so the UI can
    surface live FPS / gear without an extra round-trip.
    """

    def loop():
        backoff = 1.0
        while True:
            if liveness.stale(stale_threshold_s):
                # Don't lie to the server. Skip the POST; WorkerHealth will
                # expire the alive window and the UI will show OFFLINE.
                # WARN (not routine): a stale liveness means the main
                # inference loop is wedged (net.Detect deadlock, a hung
                # Capture, etc.) — the worker process is alive but doing
                # no work. Logged once per backoff cycle so a sustained
                # wedge doesn't fill the journal but the FIRST occurrence
                # is always recorded with WHY (seconds-since-last-bump).
                if backoff <= 1.0:
                    log.warning(
                        "heartbeat skipped: inference loop stalled "
                        "(%.1fs since last bump > %.0fs threshold); "
                        "WorkerHealth will expire -> UI shows OFFLINE",
                        time.time() - liveness.last_active, stale_threshold_s,
                    )
                backoff = min(backoff * 2, 60.0)
                time.sleep(min(backoff, 60.0))
                continue

            try:
                body = json.dumps(metrics.snapshot()).encode("utf-8")
                req = urllib.request.Request(url, data=body, method="POST")
                req.add_header("Content-Type", "application/json")
                with urllib.request.urlopen(req, timeout=2.0) as resp:
                    resp.read()
                backoff = 1.0
            except Exception as e:
                # Heartbeat POST failed — routine during a server
                # restart, so log once per backoff cycle (re-arms when
                # backoff resets to 1.0 on the next success) rather than
                # per-attempt. WARN, not ERROR: the server simply sees a
                # gap and expires the alive window on its own.
                if backoff <= 1.0:
                    log.warning(
                        "heartbeat POST failed (server may be restarting): "
                        "%s: %s", type(e).__name__, e,
                    )
                backoff = min(backoff * 2, 60.0)
            time.sleep(interval_s if backoff <= 1.0 else min(backoff, 60.0))

    t = threading.Thread(target=loop, daemon=True, name="heartbeat")
    t.start()
    return t


def init_face_recognizer():
    """Build a FaceRecognizer instance for the worker. Three modes:

    1. **Match mode** (encodings.pkl present + face_recognition + dlib
       importable): full detect + match path. `person_name` flows
       through to events; sidecars carry `confidence`.
    2. **Capture-only mode** (iter-355b1b — encodings.pkl missing OR
       face_recognition import fails): cv2 Haar-cascade detect only.
       Crops still save to face_captures/__unknown__/ with sidecar
       confidence=0. The iter-355c review queue lets the operator
       label these and graduate to mode 1 after a re-train.
    3. **Fully dormant** (FaceRecognizer wrapper module missing): the
       worker keeps running but never touches face surfaces.

    Returns the recognizer instance for modes 1+2, None for mode 3.
    """
    if FaceRecognizer is None:
        # Import-disable site (mode 3): the wrapper module didn't import
        # (the reason was already logged at import time). WARN, not INFO:
        # an operator who deployed encodings expecting face-recog needs
        # to know the whole subsystem is dormant.
        log.warning(
            "face_recog wrapper unavailable - face capture/recognition "
            "fully disabled (see import-time error above for the cause)"
        )
        return None
    encodings_path = os.path.join(_HERE, "face_recog", "encodings.pkl")
    rec = FaceRecognizer(encodings_path)
    # rec.load() returns True only when ALL of: encodings.pkl present,
    # numpy importable, face_recognition importable. Any failure leaves
    # rec._fr = None — recognize_in_crop then takes the iter-355b1b
    # cv2 fallback path. Don't return None: the cv2 path is still
    # useful for capture-only.
    matching_ready = rec.load()
    if matching_ready:
        log.info(
            "face recognizer in MATCH mode (%d encodings, tolerance=%s)",
            len(rec.names), rec.tolerance,
        )
    else:
        # Capture-only (mode 2): a degraded-but-running state. INFO so
        # the operator can confirm WHY names aren't appearing on events
        # (no encodings.pkl, or face_recognition/dlib unimportable) —
        # otherwise "no names ever match" looks like a recognition bug.
        log.info(
            "face recognizer in CAPTURE-ONLY mode (no encodings or "
            "face_recognition unavailable; cv2 Haar fallback saves crops, "
            "no name matching)"
        )
    return rec


def cuda_to_rgb_numpy(cuda_img):
    """Materialise `cuda_img` as a CPU-owned HxWx3 uint8 RGB numpy array.
    detectNet emits RGB8 cudaImages by default; on Tegra these live in
    unified memory so `cudaToNumpy` returns a CPU-readable view of the
    GPU buffer. We force a real copy with `np.array(...)` so the array
    is independent of the cudaImage's lifetime — the next `Capture()`
    will recycle the dmabuf, and `face_recognition` may hold onto the
    buffer across calls."""
    import numpy as np
    view = jetson_utils.cudaToNumpy(cuda_img)
    return np.array(view, dtype="uint8", copy=True)


def crop_face_region(rgb, det):
    """Slice the upper portion of the person bbox to give face_recognition
    something head-sized rather than full-body to scan. Returns None if
    the crop is too small to contain a face (<60 px on the short side)."""
    h, w = rgb.shape[:2]
    top = max(0, int(det.Top))
    bot = min(h, int(det.Bottom))
    left = max(0, int(det.Left))
    right = min(w, int(det.Right))
    if bot <= top or right <= left:
        return None
    bbox_h = bot - top
    # Faces sit roughly in the top ~45 % of a standing person; clamp to a
    # minimum of 120 px so close-up shots still include the whole head.
    face_bot = top + max(120, int(bbox_h * 0.45))
    face_bot = min(face_bot, bot)
    crop = rgb[top:face_bot, left:right]
    if min(crop.shape[:2]) < 60:
        return None
    return crop


def _clamped_person_bbox(rgb, det):
    """iter-356.62 (slice 1): clamp the SSD person bbox to the rgb
    array bounds and return `(left, top, right, bottom)` pixel coords.
    Mirrors the clamping inside `crop_face_region` but returns the
    FULL person box (not the upper-portion face slice). Returns None
    when the box is degenerate. Worker uses this to slice a numpy
    person crop for sidecar v2's full-person training capture.
    """
    h, w = rgb.shape[:2]
    top = max(0, int(det.Top))
    bot = min(h, int(det.Bottom))
    left = max(0, int(det.Left))
    right = min(w, int(det.Right))
    if bot <= top or right <= left:
        return None
    return (left, top, right, bot)


def restart_mediamtx():
    """Kick mediamtx via systemd. Runs as user `israel` which has
    passwordless sudo on the Jetson; a 10 s timeout keeps the worker
    from blocking forever if systemctl wedges. Logs the outcome and
    returns True on success, False otherwise — we don't raise because a
    failed kick should still let the existing 100-failure exit path
    take over."""
    try:
        result = subprocess.run(
            ["sudo", "-n", "systemctl", "restart", "mediamtx"],
            timeout=10.0,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
    except Exception as e:
        print("[detect] mediamtx restart attempt failed: {}".format(e), flush=True)
        return False
    if result.returncode != 0:
        stderr = result.stderr.decode("utf-8", "replace")[:200]
        print(
            "[detect] mediamtx restart returned {}: {}".format(result.returncode, stderr),
            flush=True,
        )
        return False
    print("[detect] mediamtx restarted by watchdog", flush=True)
    return True


def escalate_argus_recovery():
    """iter-302 (user "make sure all issues that broke the live feed
    will never happen again"): nvargus-daemon escalation tier.

    Background: the iter-300 outage had two failure modes. The first
    was a coding bug in the worker (success-reset before None-check)
    fixed in iter-300. The second was a libargus wedge — mediamtx's
    publisher pipeline got "Failed to create CaptureSession" after
    a stream restart, and `sudo systemctl restart mediamtx` alone
    couldn't unstick it because nvargus-daemon (the system-wide
    libargus broker) was holding stale state. Manual recovery
    required `sudo systemctl restart nvargus-daemon` THEN mediamtx.

    This function automates that escalation. The caller (in
    `_handle_capture_failure`) only invokes it after N consecutive
    mediamtx-only restarts have failed to recover the stream — see the
    escalation ladder in `mediamtx_watchdog`. Heavy-hammer: kills + restarts
    the daemon that owns the camera sensor, which blanks every
    consumer for 5-10 s. Worth it on a stuck-feed but never on a
    transient blip — that's why it's gated behind 2 prior restart
    attempts.

    Returns True on success, False otherwise. Mediamtx is restarted
    AFTER nvargus-daemon so the publisher pipeline re-acquires a
    fresh argus session.
    """
    for unit in ("nvargus-daemon", "mediamtx"):
        try:
            result = subprocess.run(
                ["sudo", "-n", "systemctl", "restart", unit],
                timeout=15.0,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )
        except Exception as e:
            print(
                "[detect] WATCHDOG ESCALATION: {} restart raised {}".format(
                    unit, e,
                ),
                flush=True,
            )
            return False
        if result.returncode != 0:
            stderr = result.stderr.decode("utf-8", "replace")[:200]
            print(
                "[detect] WATCHDOG ESCALATION: {} restart returned {}: {}".format(
                    unit, result.returncode, stderr,
                ),
                flush=True,
            )
            return False
        print(
            "[detect] WATCHDOG ESCALATION: restarted {} (libargus recovery)".format(unit),
            flush=True,
        )
        # Brief pause between argus restart and mediamtx restart so
        # the daemon has time to clean up its socket state before
        # mediamtx's runOnInit pipeline attempts a new CaptureSession.
        time.sleep(1.0)
    return True


# --- escalating-watchdog persistence + diagnostics + guarded reboot --------
#
# THE FIX (root-caused 2026-06-20): the nvargus escalation was unreachable
# because the watchdog's in-memory level reset every time systemd recycled the
# worker (~60-75 s under a fast-failing wedge), so it never climbed past a
# mediamtx restart. Persisting `level`/`last_action_at` to a file on the data
# volume lets the ladder keep climbing ACROSS worker restarts → nvargus restart
# (which clears the libargus wedge) is reached in ~3 min, reboot only after.
#
# `_WATCHDOG_STATE` also carries `last_reboot_at` — the boot-loop guard: if a
# reboot didn't clear the wedge, we must NOT reboot again immediately.
_WATCHDOG_STATE = {}          # type: ignore[var-annotated]
_WATCHDOG_STATE_PATH = None   # set in main() to <recordings_dir>/.watchdog_state.json
# Active continuous-capture runner (plan S4/R5). Set in main() ONLY when the
# continuous_capture flag is on; None otherwise (legacy start_clip path). The
# capture-failure handler reads it to finalize any open visit at last_seen
# BEFORE the watchdog restarts mediamtx/nvargus or reboots, so a mid-visit
# wedge yields a short VALID clip rather than one spanning the gap.
_VISIT_RUNNER = None          # type: ignore[var-annotated]
# Don't auto-reboot more than once per this window — a reboot that doesn't fix
# the wedge would otherwise boot-loop the Jetson.
_REBOOT_MIN_INTERVAL_S = 1800.0
# Interval between systemd sd_notify WATCHDOG=1 pings (the unit's WatchdogSec is
# ~4-5x this). Pinged from a dedicated thread so it never sits behind a blocking
# camera.Capture (which broke the first per-loop attempt).
_SD_WATCHDOG_PING_S = 20.0


def _coerce_watchdog_timestamp(value, now, reject_future_after_s=0.0):
    """Return a finite persisted wall-clock timestamp, or 0.0 if corrupt."""
    try:
        ts = float(value)
    except (TypeError, ValueError):
        return 0.0
    if not math.isfinite(ts):
        return 0.0
    if ts > (now + reject_future_after_s):
        return 0.0
    return ts


def _load_watchdog_state(path):
    """Read the persisted escalation state ({level, last_action_at,
    last_reboot_at}). Survives the systemd worker-restart so the escalation
    ladder keeps climbing. Returns {} on any error (fresh start)."""
    try:
        with open(str(path)) as f:
            data = json.load(f)
        if isinstance(data, dict):
            return data
    except (OSError, ValueError):
        pass
    return {}


def _save_watchdog_state(path, state):
    """Atomically persist the escalation state. Best-effort — a save failure
    just means escalation can't span a restart, never a crash."""
    if path is None:
        return
    try:
        tmp = str(path) + ".tmp"
        with open(tmp, "w") as f:
            json.dump(state, f)
        os.replace(tmp, str(path))
    except OSError as e:
        print("[detect] watchdog state save failed: {}".format(e), flush=True)


def _persist_watchdog_level(watchdog):
    """After an action, write the new ladder level so a worker restart resumes
    the escalation instead of dropping back to mediamtx-only."""
    snap = watchdog.snapshot()
    _WATCHDOG_STATE["level"] = snap["level"]
    _WATCHDOG_STATE["last_action_at"] = snap["last_action_at"]
    _save_watchdog_state(_WATCHDOG_STATE_PATH, _WATCHDOG_STATE)


def _clear_watchdog_escalation():
    """On recovery (a real frame), reset the persisted ladder to the bottom —
    but KEEP last_reboot_at so the boot-loop guard survives."""
    if _WATCHDOG_STATE.get("level"):
        _WATCHDOG_STATE["level"] = 0
        _WATCHDOG_STATE["last_action_at"] = None
        _save_watchdog_state(_WATCHDOG_STATE_PATH, _WATCHDOG_STATE)


def _capture_wedge_diagnostics(action):
    """Snapshot thermal / power / memory / nvargus / kernel state when the
    watchdog escalates, so the (still-undiagnosed) ROOT cause of the libargus
    wedge becomes greppable from the journal. Runs only on escalation (rare),
    best-effort, bounded, never raises."""
    print(
        "[detect] === WATCHDOG DIAGNOSTICS (escalating -> {}) ===".format(action),
        flush=True,
    )
    probes = (
        ("memory", ["free", "-m"]),
        ("tegrastats", ["timeout", "2", "tegrastats"]),
        ("nvargus", ["sh", "-c", "ps -o pid=,rss=,etime=,cmd= -C nvargus-daemon || true"]),
        ("dmesg-tail", ["sh", "-c", "sudo -n dmesg 2>/dev/null | tail -15 || true"]),
        ("thermal", ["sh", "-c",
                     "for z in /sys/class/thermal/thermal_zone*/temp; do "
                     "echo \"$z=$(cat $z 2>/dev/null)\"; done"]),
    )
    for name, cmd in probes:
        try:
            out = subprocess.run(
                cmd, timeout=4.0,
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            )
            text = out.stdout.decode("utf-8", "replace").strip()[:1500]
            print("[detect] [diag:{}]\n{}".format(name, text), flush=True)
        except Exception as e:
            print("[detect] [diag:{}] probe failed: {}".format(name, e), flush=True)


def _do_reboot():
    """Last-resort reboot, with a boot-loop guard. If we rebooted within
    `_REBOOT_MIN_INTERVAL_S`, a reboot clearly isn't fixing the wedge — DON'T
    loop; fall back to a nvargus-daemon restart instead."""
    now = time.time()
    last = _coerce_watchdog_timestamp(
        _WATCHDOG_STATE.get("last_reboot_at"), now,
    )
    if (now - last) < _REBOOT_MIN_INTERVAL_S:
        print(
            "[detect] WATCHDOG: reboot SUPPRESSED — last reboot {:.0f}s ago "
            "(< {:.0f}s boot-loop guard); falling back to nvargus restart".format(
                now - last, _REBOOT_MIN_INTERVAL_S,
            ),
            flush=True,
        )
        return escalate_argus_recovery()
    _WATCHDOG_STATE["last_reboot_at"] = now
    _save_watchdog_state(_WATCHDOG_STATE_PATH, _WATCHDOG_STATE)
    print(
        "[detect] WATCHDOG: REBOOTING Jetson — camera wedged and mediamtx + "
        "nvargus-daemon restarts did not clear it (set "
        "DETECT_WATCHDOG_ALLOW_REBOOT=0 to disable)",
        flush=True,
    )
    try:
        subprocess.run(
            ["sudo", "-n", "systemctl", "reboot"],
            timeout=10.0, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
    except Exception as e:
        print("[detect] WATCHDOG: reboot command failed: {}".format(e), flush=True)
        return False
    return True


def _build_visit_runner(recordings_dir, clip_recorder, preroll_buffer,
                        event_url, camera_id):
    """Construct a ``visit_runtime.VisitRunner`` with the three side-effect
    callables wired to the real recorder/preroll/POST path (plan S4 item 2).
    Factored out of ``main()`` so the wiring is small + the loop body stays
    focused. The callables themselves are thin adapters; the heavy lifting is
    in ``recording.finalize_visit`` / ``preroll.copy_new_segments`` (S2/S3)."""
    def _post_open(visit_id, key, start_ts, boxes):
        # event_id == visit_id (plan: "pick an event_id (= visit_id)"). POST
        # the open event today with clip_url pointing at the eventual clip
        # (R4's no-clip-url-at-open is S6's job, NOT here). label is the part
        # of the emit key before ":".
        #
        # `boxes` is the frame's already-normalized box list (server-valid
        # dicts from `normalize_box`), threaded from the observe call site —
        # the server's DetectionPayload requires `Field(min_length=1)` on
        # boxes, so an empty list would 422 (S4 shipped boxes:[] as a known
        # gap; this is the S6 fix). An open is always triggered by a present
        # detection, so `boxes` has >=1 entry here; guard defensively anyway.
        label = key.split(":", 1)[0] if isinstance(key, str) else "person"
        if not boxes:
            applog.emit(
                "visit",
                "open POST for visit {} had no boxes — skipping POST (clip "
                "still finalizes); should not happen on a present "
                "detection".format(visit_id),
            )
            return
        payload = {
            "id": visit_id,
            "label": label,
            "score": 1.0,
            "boxes": list(boxes),
            "camera_id": camera_id,
            "clip_url": "/api/events/{}/clip".format(visit_id),
        }
        post_event(event_url, payload)

    def _copy_segments(visit_id, start_ts, until_ts, scratch_dir, already):
        if preroll_buffer is None:
            return [], (already if already is not None else set())
        return preroll_buffer.copy_new_segments(
            start_ts, until_ts, scratch_dir, already_copied=already,
        )

    def _finalize(visit_id, scratch_dir, start_ts, end_ts):
        return clip_recorder.finalize_visit(
            visit_id, scratch_dir, start_ts, end_ts,
            recordings_dir=recordings_dir,
        )

    return visit_runtime.VisitRunner(
        recordings_dir=recordings_dir,
        post_event=_post_open,
        copy_segments=_copy_segments,
        finalize_visit=_finalize,
    )


def _recover_open_visits(recordings_dir, clip_recorder, runner,
                         absence_finalize_s):
    """Boot crash recovery (plan B4). Delegates to
    ``visit_runtime.recover_open_visits`` with the recorder's ffprobe gate as
    the idempotency validator and the recorder's ``finalize_visit`` as the
    surviving-scratch finalizer. Kept here (not in visit_runtime) only to bind
    the recorder; the LOGIC + idempotency property are in + tested via
    visit_runtime."""
    def _validate(path):
        # Reuse the recorder's real-decode validator? No — that needs the
        # nominal window. For the idempotency gate a structural moov/ffprobe
        # check is the right "is this a good file" test (a valid clip from a
        # prior life). `_probe_duration` returns a positive float iff ffprobe
        # parsed the container + a sane duration.
        return clip_recorder._probe_duration(path) is not None

    def _finalize(visit_id, scratch_dir, start_ts, end_ts):
        return clip_recorder.finalize_visit(
            visit_id, scratch_dir, start_ts, end_ts,
            recordings_dir=recordings_dir,
        )

    return visit_runtime.recover_open_visits(
        recordings_dir, _validate, _finalize,
        now=time.time(),
        default_absence_finalize_s=absence_finalize_s,
    )


def open_camera(uri, attempts=30, retry_s=2.0):
    """Wait for the upstream RTSP to come up (mediamtx may still be starting)."""
    last_err = None
    for i in range(attempts):
        try:
            cam = jetson_utils.videoSource(uri, argv=["--input-codec=h264"])
            return cam
        except Exception as e:
            last_err = e
            print("[detect] videoSource not ready (attempt {}/{}): {}; retrying in {:.1f}s"
                  .format(i + 1, attempts, e, retry_s), flush=True)
            time.sleep(retry_s)
    raise SystemExit("videoSource never came up: {}".format(last_err))


def _handle_capture_failure(
    reason, consecutive_failures, metrics, mediamtx_watchdog, liveness,
):
    """iter-285 (camera-library-usage-auditor A1 dedupe): both the
    exception path and the `img is None` path of `camera.Capture()`
    run the same 6-step recovery ladder. Pre-iter-285 these were
    inlined twice in main() and drifted (iter-264 added the None
    path; the exception path's log message wording differed from the
    None path's). Factor the ladder so changes can't drift.

    Steps:
    1. Bump `consecutive_failures` (returned to caller).
    2. Bump dropped + watchdog on_capture_fail counters.
    3. Bump liveness — the worker IS alive; only the upstream
       RTSP is silent. Without this the heartbeat thread skips
       POSTing after 30 s and the UI shows worker_alive=false
       prematurely (iter-172).
    4. Print every 10 failures (with `reason` in the message).
    5. Watchdog `next_action` check → execute the escalation rung
       (mediamtx -> nvargus -> reboot) + persist the level.
    6. SystemExit at 100 — systemd recovers (but the PERSISTED ladder
       lets the next worker life resume the escalation).

    Returns the new `consecutive_failures` count. Raises SystemExit
    on giving up.
    """
    consecutive_failures += 1
    metrics.dropped += 1
    mediamtx_watchdog.on_capture_fail()
    liveness.bump()
    if consecutive_failures % 10 == 1:
        print(
            "[detect] capture {} #{}".format(reason, consecutive_failures),
            flush=True,
        )
    now = time.time()
    action = mediamtx_watchdog.next_action(now)
    if action is not None:
        # The watchdog chose a recovery rung (mediamtx -> nvargus -> reboot).
        # Capture diagnostics FIRST (the wedge's root cause is still unknown),
        # then execute, then persist the new escalation level so a systemd
        # worker-restart RESUMES the ladder instead of resetting to
        # mediamtx-only (the 2026-06-20 reachability fix).
        _capture_wedge_diagnostics(action)
        # plan R5: finalize any open continuous-capture visit at last_seen and
        # persist .open_visits.json BEFORE the recovery action (esp. reboot) —
        # a short valid clip, not one spanning the wedge gap. No-op when the
        # legacy path is active (_VISIT_RUNNER is None).
        if _VISIT_RUNNER is not None:
            try:
                _VISIT_RUNNER.finalize_open_visits_for_escalation(now)
            except Exception as e:
                print(
                    "[detect] WATCHDOG: visit finalize-on-escalation failed: "
                    "{}: {}".format(type(e).__name__, e), flush=True,
                )
        if action == ACTION_RESTART_MEDIAMTX:
            if restart_mediamtx():
                metrics.mediamtx_restarts += 1
        elif action == ACTION_RESTART_NVARGUS:
            if escalate_argus_recovery():
                metrics.argus_restarts += 1
        elif action == ACTION_REBOOT:
            _do_reboot()
        _persist_watchdog_level(mediamtx_watchdog)
    if consecutive_failures > 100:
        print(
            "[detect] giving up after 100 consecutive capture failures "
            "({})".format(reason),
            flush=True,
        )
        raise SystemExit(1)
    return consecutive_failures


# Human-readable reason for each gear, surfaced on the transition log
# line so an operator reading the journal understands WHY the worker
# stopped emitting events without cross-referencing the code. The
# "healthy but zero events" footgun (plan §2): a worker sitting in
# `off` / `scheduled-off` / `low-memory` / `thermal-throttled` looks
# identical in /api/status to "camera saw nobody" unless the gear
# transition is logged.
_GEAR_REASON = {
    "off": "detection disabled (manual toggle) - NO events will fire",
    "scheduled-off": "inside the scheduled off-window - NO events will fire",
    "low-memory": "RAM below floor - inference PAUSED (capture continues)",
    "thermal-throttled": "GPU hot - forced to idle gear (1 fps)",
    "idle": "no recent detections - inference throttled to idle fps",
    "active": "recent detection - inference at active fps",
}


def top_label_for_log(kept):
    """Best-effort top-confidence label from a `kept` list of
    ``(detection, label)`` tuples, for log lines that need a label
    BEFORE the main emit path computes `top_label`. Returns ``"?"`` on
    an empty list so a log line can never KeyError/ValueError. Pure
    (no I/O); kept tiny so it stays off the per-frame cost path (only
    called on the throttled zone-suppression line)."""
    if not kept:
        return "?"
    try:
        return max(kept, key=lambda dl: dl[0].Confidence)[1]
    except Exception:
        return "?"


def gear_transition(prev_gear, new_gear):
    """Pure helper: decide whether a gear change warrants a log line.

    Returns ``(should_log, message)``. ``should_log`` is True only on an
    actual transition (``prev_gear != new_gear``) so the inference loop
    logs ONCE per gear change, never per-frame — the plan §4 hot-path
    silence guardrail and the "log on TRANSITION only" directive. The
    message embeds the `_GEAR_REASON` text for the destination gear.

    Factored out (no logging, no I/O) so the transition decision can be
    unit-tested without spinning up the inference loop or a logger.
    """
    if prev_gear == new_gear:
        return (False, "")
    reason = _GEAR_REASON.get(new_gear, "")
    if reason:
        msg = "gear {} -> {}: {}".format(prev_gear, new_gear, reason)
    else:
        msg = "gear {} -> {}".format(prev_gear, new_gear)
    return (True, msg)


def main():
    # First thing: install the root logging handler so every leaf-lib
    # `log.warning(...)` (recognizer / detector / *_guard / watchdog) and
    # every `applog.emit("[tag] ...")` breadcrumb reaches journald. Must
    # run BEFORE any worker thread (heartbeat / config-poll / preroll
    # watchdog) spawns so their first log line is already handled.
    applog.configure()
    source_uri = _env("DETECT_SOURCE", "rtsp://localhost:8554/cam")
    threshold = _env("DETECT_THRESHOLD", 0.55, float)
    cooldown = _env("DETECT_COOLDOWN_S", 5.0, float)
    event_url = _env("EVENT_URL", "http://127.0.0.1:8000/api/_internal/event")
    # iter-288 (security-auditor G1, queued since iter-264): the
    # systemd unit file (`deploy/systemd/homecam-detect.service`) is
    # root-owned + chmod 644 in the operator-blessed deploy, so a
    # malicious EVENT_URL is unlikely. But the cost of a one-line
    # defense-in-depth assert is negligible and closes the
    # confused-deputy vector if env ever IS tampered (operator
    # typo, misapplied config-mgmt rollout). The worker is allowed
    # ONLY to post events to the loopback FastAPI; allow-list
    # 127.0.0.1, localhost, and ::1 (IPv6 loopback). Anything
    # else SystemExit immediately so systemd reports a clean
    # failed-to-start state instead of letting the worker exfiltrate
    # detection events (including matched person_names + thumb URLs)
    # to an attacker-controlled host.
    _allowed_event_hosts = ("127.0.0.1", "localhost", "::1")
    try:
        from urllib.parse import urlparse as _urlparse
    except ImportError:
        # Python 3.6 ships urllib.parse out of the box; this branch
        # is defensive only.
        raise
    _parsed_event = _urlparse(event_url)
    _event_host = (_parsed_event.hostname or "").lower()
    if _event_host not in _allowed_event_hosts:
        raise SystemExit(
            "EVENT_URL host {!r} is not loopback (allowed: {}). "
            "Refuse to start to prevent detection-event exfiltration.".format(
                _event_host, ", ".join(_allowed_event_hosts),
            )
        )
    camera_id = _env("CAMERA_ID", "cam1")
    model = _env("DETECT_MODEL", "ssd-mobilenet-v2")
    person_class_id = _env("PERSON_CLASS_ID", 1, int)
    active_fps = _env("DETECT_ACTIVE_FPS", 5.0, float)
    idle_fps = _env("DETECT_IDLE_FPS", 1.0, float)
    idle_after_s = _env("DETECT_IDLE_AFTER_S", 15.0, float)
    active_period = 1.0 / active_fps if active_fps > 0 else 0.0
    idle_period = 1.0 / idle_fps if idle_fps > 0 else 0.0
    thumb_dir = _env(
        "DETECT_THUMB_DIR", "/home/israel/HomeCameraSystem/snapshots"
    )
    thumb_max = _env("DETECT_THUMB_MAX", 100, int)
    thumb_quality = _env("DETECT_THUMB_QUALITY", 70, int)

    # iter-247 (Feature #1 slice 2b): wire the iter-202 ClipRecorder
    # into the emit path. Worker generates a uuid before each emit,
    # spawns ffmpeg to write `<recordings_dir>/<event_id>.mp4` (no
    # re-encode, `-c copy` from the existing RTSP stream), and
    # includes both `id` and `clip_url` in the event payload so the
    # server stores the same id everywhere. Empty `recordings_dir`
    # disables clip recording entirely (op opt-out).
    recordings_dir = _env(
        "RECORDINGS_DIR", "/home/israel/HomeCameraSystem/recordings"
    )
    # iter-352 (face-capture-for-retraining, Phase 2): worker writes
    # face crops into this dir via face_recog/recognizer.py +
    # face_recog/capture.py. Container server reads via the auth-
    # gated /api/face/captures route (PWA /training page). Empty =
    # capture disabled (operator opt-out, mirrors RECORDINGS_DIR
    # convention). Default matches the iter-351 docker-compose
    # bind-mount.
    face_captures_dir = _env(
        "FACE_CAPTURES_DIR", "/home/israel/HomeCameraSystem/face_captures"
    )
    # iter-356.62 (slice 1): parallel root for full-person crops. NOT a
    # subdir of face_captures_dir — the existing /face/captures listing
    # walks face_captures_dir/<name>/ and would otherwise treat a
    # _person subtree as a person bucket. Empty = person capture
    # disabled (operator opt-out, mirrors RECORDINGS_DIR convention).
    person_captures_dir = _env(
        "PERSON_CAPTURES_DIR",
        "/home/israel/HomeCameraSystem/person_captures",
    )
    clip_duration_s = _env("DETECT_CLIP_DURATION_S", 8.0, float)
    clip_max_concurrent = _env("DETECT_CLIP_MAX_CONCURRENT", 3, int)
    clip_recorder = None
    if recordings_dir:
        try:
            from recording import ClipRecorder
            clip_recorder = ClipRecorder(
                rtsp_url=source_uri,
                recordings_dir=recordings_dir,
                duration_s=clip_duration_s,
                max_concurrent=clip_max_concurrent,
            )
            log.info(
                "clip recorder armed -> %s (%ss clips, max %s concurrent)",
                recordings_dir, clip_duration_s, clip_max_concurrent,
            )
        except Exception as e:
            # Import-disable site: RECORDINGS_DIR was configured (operator
            # wants clips) but the recorder couldn't be built. ERROR with
            # the reason + dir — every detection event will now ship
            # without a clip and the ClipModal falls back to the snapshot.
            log.error(
                "clip recorder disabled (events will have no clips) for "
                "dir=%s: %s: %s", recordings_dir, type(e).__name__, e,
            )
            clip_recorder = None

    # iter-324 (Feature #1 slice 2c, pre-roll): start a long-running
    # ffmpeg segment-recorder so detection events can include the
    # moments BEFORE the trigger. Buffer dir lives next to recordings
    # so the same volume bind-mount works. Optional — operator
    # disables by setting `DETECT_PREROLL_DIR=` (empty). When the
    # buffer is off, ClipRecorder falls back to post-roll-only
    # behavior automatically (pre_roll_s defaults to 0 in the
    # caller below).
    preroll_buffer = None
    if recordings_dir:
        preroll_dir = _env(
            "DETECT_PREROLL_DIR",
            os.path.join(recordings_dir, "_preroll"),
        )
        if preroll_dir:
            try:
                from preroll import PrerollBuffer
                preroll_buffer = PrerollBuffer(
                    rtsp_url=source_uri,
                    buffer_dir=preroll_dir,
                )
                if preroll_buffer.start():
                    # iter-325: arm the watchdog so the subprocess
                    # auto-restarts if MediaMTX bounces (the iter-26
                    # gateway watchdog kicks mediamtx, which drops
                    # the pre-roll's RTSP connection → ffmpeg exits
                    # silently). 10 s polling cadence: long enough
                    # to dodge restart storms during a mediamtx
                    # cycle, short enough that the buffer is back
                    # in service before the next detection event.
                    preroll_buffer.start_watchdog(interval_s=10.0)
                    log.info(
                        "preroll buffer armed -> %s (watchdog 10s)",
                        preroll_dir,
                    )
                else:
                    # start() returned False: the segment-recorder ffmpeg
                    # didn't come up (RTSP not yet available, ffmpeg
                    # missing, buffer dir unwritable). ERROR — pre-roll is
                    # configured but silently absent; clips will be
                    # post-roll-only with no warning to the operator.
                    log.error(
                        "preroll buffer failed to start for dir=%s "
                        "(clips will be post-roll-only)", preroll_dir,
                    )
                    preroll_buffer = None
            except Exception as e:
                # Import-disable site: pre-roll configured but the module
                # couldn't load / construct. ERROR with reason + dir.
                log.error(
                    "preroll buffer disabled for dir=%s: %s: %s "
                    "(clips will be post-roll-only)",
                    preroll_dir, type(e).__name__, e,
                )
                preroll_buffer = None

    # iter-356.62 (camera-algorithm-auditor pre-YOLO win 3): mem-floor
    # gate runs ONCE here, before TRT engine workspace allocation can
    # SIGKILL us. Distinct from the runtime MemoryGuard armed below
    # (which pauses inference; this refuses to start at all).
    min_free_mem_mb = _env("DETECT_MIN_FREE_MEM_MB", 400.0, float)
    _enforce_mem_floor(read_mem_available_mb, min_free_mem_mb)

    # detectNet uses a fixed low floor; the live-tunable threshold filters
    # the results post-inference (avoids reloading the TRT engine).
    log.info(
        "loading %s (floor=%s, initial threshold=%s)",
        model, RuntimeConfig.DETECT_FLOOR, threshold,
    )
    try:
        net = jetson_inference.detectNet(
            model, threshold=RuntimeConfig.DETECT_FLOOR,
        )
    except Exception as e:
        # detectNet construction failed: TRT engine couldn't be built /
        # deserialized (missing model files, corrupt .engine, TensorRT
        # version mismatch, or an OOM-SIGKILL'd workspace alloc that
        # surfaced as an exception rather than a kill). The worker CANNOT
        # run without the net — log ERROR naming the model + reason and
        # abort so systemd's RestartSec retries with a clear cause in the
        # journal instead of a bare traceback.
        log.error(
            "detectNet load FAILED for model=%s: %s: %s (worker cannot "
            "start)", model, type(e).__name__, e,
        )
        raise SystemExit(4)
    log.info("model ready")

    # Optional face recognizer: matches each person detection against a
    # small known-faces database. Disables itself cleanly if the encodings
    # file or the face_recognition library are missing.
    recognizer = init_face_recognizer()

    # Live-tunable runtime config (threshold, cooldown). Polled from the
    # server's `/api/_internal/detection/config` so the Settings slider
    # can dial it without a worker restart. iter-244 moved the worker
    # poll from the user-facing `/api/detection/config` (which is
    # iter-184 auth-gated and 401s without a cookie) to the unauth
    # `_internal` mirror that the rest of the worker → server traffic
    # already uses.
    runtime = RuntimeConfig(threshold=threshold, cooldown_s=cooldown)
    # Seed the continuous-capture flag + knobs from env (plan S4). The
    # config-poll later overrides these live; resolving here means a boot-time
    # env override is honored before the server has spoken. Default OFF.
    _cc = visit_runtime.resolve_continuous_config(env=os.environ)
    runtime.continuous_capture = _cc["enabled"]
    runtime.max_visit_s = _cc["max_visit_s"]
    runtime.absence_finalize_s = _cc["absence_finalize_s"]
    metrics_known_names = (
        sorted(set(recognizer.names)) if recognizer is not None else []
    )
    config_url = event_url.rsplit("/event", 1)[0] + "/detection/config"
    # iter-356.61: thread the preroll_buffer through so the poll can
    # grow the segment-recorder ring on demand when the user pushes
    # the Settings "Pre-roll" slider above the boot-time capacity.
    start_config_poll(config_url, runtime, preroll_buffer=preroll_buffer)
    log.info("config poll -> %s", config_url)

    # Liveness signal driven by the inference loop; heartbeat thread reads
    # it before each POST. Bumped here so the server sees us alive during
    # the camera open + RTSP warmup window.
    liveness = Liveness()
    metrics = Metrics()
    metrics.face_recog_names = metrics_known_names
    heartbeat_url = event_url.rsplit("/", 1)[0] + "/heartbeat"
    start_heartbeat(heartbeat_url, liveness, metrics)
    log.info("heartbeat -> %s", heartbeat_url)

    log.info("opening source %s", source_uri)
    camera = open_camera(source_uri)
    log.info("source open; sending events to %s", event_url)
    # Worker is fully up (model loaded + camera open). Tell systemd we're READY
    # (Type=notify) so the WatchdogSec liveness timer starts NOW — the long TRT
    # load above must not count against it. Each main-loop iteration then pings
    # WATCHDOG=1; if the loop HANGS (a true deadlock, distinct from a capture
    # wedge that the mediamtx_watchdog handles) the pings stop and systemd
    # restarts us — and the persisted escalation state resumes recovery. No-op
    # when not run under systemd (dev host / tests).
    sdnotify.ready()
    # systemd liveness: ping WATCHDOG=1 from a DEDICATED daemon thread, NOT the
    # main loop. A per-loop ping proved unreliable — the loop can block inside
    # camera.Capture() during stream startup, so the ping didn't refresh the
    # timer and WatchdogSec restart-cycled the worker. This thread only pings +
    # sleeps, so it can't block; it proves the PROCESS is alive and scheduling
    # threads (an OOM/kernel freeze stops it → systemd restarts the unit, and
    # the persisted escalation state resumes recovery). The capture-wedge "no
    # frames" case is the mediamtx_watchdog's job, not this. No-op off-systemd.
    if sdnotify.enabled():
        def _sd_watchdog_loop():
            pings = 0
            while True:
                sdnotify.watchdog()
                pings += 1
                if pings == 1 or pings % 30 == 0:
                    log.info("sd-watchdog: process-liveness ping #%d", pings)
                time.sleep(_SD_WATCHDOG_PING_S)
        threading.Thread(
            target=_sd_watchdog_loop, daemon=True, name="sd-watchdog",
        ).start()
    liveness.bump()

    # iter-272 (camera-algorithm-auditor B1): per-(label, camera_id)
    # cooldown so a `dog` detection at t=0 doesn't suppress a `person`
    # event at t=2s under a 5 s cooldown. Pre-iter-272 a single
    # `last_emit: float` gated all classes globally — fine while
    # camera_id is hardcoded "cam1" + only one label is interesting,
    # but the multi-camera Phase 1+ work (iter-186+ in flight) and
    # multi-class detection (person + dog + car) make this a real
    # bug. Key shape: "{label}:{camera_id}". Bounded by label
    # vocab × camera count; defensive 32-entry LRU cap against an
    # unbounded growth path (e.g. ssd-mobilenet-v2 has 90 class
    # labels, all of which could in theory survive `wanted` if the
    # operator selected them).
    # Presence-coalescing emit gate (replaces the old flat per-(label,camera)
    # cooldown dict). A continuous presence used to re-fire a fresh event +
    # clip every cooldown (~5 s); the tracker collapses those re-fires into one
    # event per presence (segmented only when a long linger outlasts its clip).
    # See detection/presence.py and the gate below. The old `cooldown_s` now
    # acts as the min-gap floor between emits for one key.
    presence_tracker = PresenceTracker()
    # --- continuous-capture runner + crash recovery (plan S4) -------------
    # HARD XOR with the legacy ClipRecorder.start_clip path: the runner is
    # built ONLY when the flag is on, and the loop branches on it so both
    # paths never run for one detection. The legacy recorder stays armed as
    # the rollback (flipping the flag off reverts to it with no restart).
    global _VISIT_RUNNER
    _VISIT_RUNNER = None
    if runtime.continuous_capture and recordings_dir and clip_recorder is not None:
        _vr = _build_visit_runner(
            recordings_dir, clip_recorder, preroll_buffer, event_url,
            camera_id,
        )
        _VISIT_RUNNER = _vr
        # Boot recovery (B4) + orphan sweep (R8) BEFORE the loop opens any new
        # visit. Idempotent: a visit whose <id>.mp4 already validates is
        # marked done and skipped (never re-finalized / never os.replace'd).
        try:
            _recover_open_visits(
                recordings_dir, clip_recorder, _vr, runtime.absence_finalize_s,
            )
        except Exception as e:
            log.error(
                "continuous-capture recovery failed: %s: %s",
                type(e).__name__, e,
            )
        try:
            visit_runtime.sweep_orphans(recordings_dir)
        except Exception as e:
            log.error(
                "continuous-capture orphan sweep failed: %s: %s",
                type(e).__name__, e,
            )
        log.info(
            "continuous-capture ARMED (max_visit=%ss, absence_finalize=%ss) "
            "— legacy start_clip path SUPPRESSED",
            runtime.max_visit_s, runtime.absence_finalize_s,
        )
    # iter-356.53 (bbox-track sidecar, Feature #1 follow-up):
    # rolling deque of (frame_ts, boxes) for the last ~64 s of
    # inferences (covers the absolute pre-roll ceiling). Single-
    # threaded inference loop owns it; CPython GIL covers append.
    # ACTIVE_TRACKS holds in-flight clip-recordings whose post-roll
    # window is still capturing. On expiry, drained entries are
    # written to `<recordings_dir>/<event_id>.tracks.json` and the
    # ClipModal picks up bbox-following on the next playback.
    import collections as _collections
    track_deque = _collections.deque(maxlen=512)
    active_tracks = {}  # type: ignore[var-annotated]
    try:
        import tracks as _tracks_mod
    except Exception as _e:
        # Import-disable site: if tracks.py is missing or broken, fall
        # back to today's static-overlay behavior. The clip MP4 path is
        # independent, so this degrades gracefully — WARN (not ERROR)
        # naming the reason so the operator knows bbox-following will be
        # absent on new clips and why.
        log.warning(
            "track sidecar disabled (clips fall back to static overlay): "
            "%s: %s", type(_e).__name__, _e,
        )
        _tracks_mod = None
    last_inference = 0.0
    last_detection = 0.0
    last_latest_save = 0.0
    latest_save_warned = False
    started = time.time()
    metrics.started = started  # so fps() / infer_per_s() use the same baseline
    latest_path = os.path.join(thumb_dir, "latest.jpg")
    # Gear-transition logging state (plan §2 "healthy but zero events"
    # footgun). `prev_gear` tracks the last gear we logged; the loop
    # calls `_set_gear(...)` instead of assigning `metrics.gear`
    # directly so a change is logged ONCE at the transition, never
    # per-frame. Seeded to None so the FIRST gear is always logged.
    gear_state = {"prev": None}

    def _set_gear(new_gear):
        metrics.gear = new_gear
        should_log, msg = gear_transition(gear_state["prev"], new_gear)
        if should_log:
            log.info("%s", msg)
            gear_state["prev"] = new_gear

    # Throttle state for the in-loop INFO/WARN lines that would
    # otherwise fire per-frame. `_empty_class_warned` is a re-arming
    # once-flag (set when the wanted-set is empty, cleared the moment a
    # non-empty set is seen). `_zone_suppress` rate-limits the
    # zone-gate-suppression INFO to at most one line per
    # `_ZONE_SUPPRESS_EVERY_S` so a busy scene outside every zone
    # doesn't flood the journal.
    empty_class_warned = False
    last_zone_suppress_log = 0.0
    _ZONE_SUPPRESS_EVERY_S = 60.0

    consecutive_failures = 0
    # The watchdog kicks mediamtx after a sustained burst of capture
    # timeouts — covers the failure mode where the gst-launch pipeline
    # stays alive in mediamtx's cgroup but stops producing frames
    # (libargus hang, NvMMLite block error). detect.py restarting alone
    # would just reconnect to the same dead RTSP path. Tuned so a single
    # mediamtx kick happens around the 60 s mark; if THAT doesn't clear
    # it, the existing 100-failure exit will hand recovery to systemd.
    # Escalating, PERSISTENT recovery ladder (2026-06-20): mediamtx restart ->
    # nvargus-daemon restart (clears the libargus "Failed to create
    # CaptureSession" wedge) -> reboot. Level/last_action_at are persisted to
    # the data volume so the ladder keeps climbing ACROSS systemd worker
    # restarts — the old in-memory restart_count reset every restart, so the
    # nvargus rung was unreachable and it flapped on mediamtx forever.
    global _WATCHDOG_STATE, _WATCHDOG_STATE_PATH
    _WATCHDOG_STATE_PATH = os.path.join(str(recordings_dir), ".watchdog_state.json")
    _WATCHDOG_STATE = _load_watchdog_state(_WATCHDOG_STATE_PATH)
    _allow_reboot = _env("DETECT_WATCHDOG_ALLOW_REBOOT", "1") not in (
        "0", "false", "False", "no", "off",
    )
    mediamtx_watchdog = MediaMtxWatchdog(
        fail_threshold=30, cooldown_s=60.0, allow_reboot=_allow_reboot,
    )
    # Resume the escalation ladder where the last worker life left off.
    mediamtx_watchdog.restore(
        _WATCHDOG_STATE.get("level", 0),
        _WATCHDOG_STATE.get("last_action_at"),
        now=time.time(),
    )
    # Memory guard: pauses inference (not capture) when the host runs
    # critically low on RAM. Worker keeps draining frames so the RTSP
    # pipeline doesn't back up, and metrics keep flowing — the user can
    # see the pause via gear='low-memory'. Hysteresis: enter at 80 MB,
    # leave only once back above 150 MB, so we don't flap.
    memory_guard = MemoryGuard(low_mb=80, recover_mb=150)
    mem_check_every_n_frames = 30
    # Thermal guard: when the GPU climbs past 80 °C, force the loop into
    # idle gear (1 fps) regardless of activity. Tegra's thermal trip is
    # near 87 °C; the 80 → 70 hysteresis gives ~7 °C of warning before
    # the kernel starts clamping clocks. Defense for hot-ambient /
    # fanless cases — iter-3's idle-gear keeps the system at ~50 °C in
    # normal operation, so this rarely fires in practice.
    thermal_guard = ThermalGuard(hot_c=80.0, cool_c=70.0)
    # iter-356.62 (camera-algorithm-auditor pre-YOLO win 1): cadence
    # was 30 frames — at idle gear (1 fps) that's a 30 s sampling
    # window, long enough for the GPU to climb from 70 °C to ~87 °C
    # (Tegra thermal trip) on an idle→active gear transition before
    # the guard notices. 10 frames = 10 s at idle / 2 s at active,
    # both safely under any plausible thermal slew. Cost: one extra
    # `_read_thermal_zone_by_name` syscall per ~10 s — negligible.
    thermal_check_every_n_frames = 10
    while True:
        # Capture returns a cudaImage allocated on the GPU; pass it directly
        # into detectNet without round-tripping through CPU memory. The
        # 2000 ms timeout in jetson-utils handles transient RTSP hiccups
        # on its own — sleeping again here on failure cuts effective FPS.
        try:
            img = camera.Capture(timeout=2000)
        except Exception as e:
            consecutive_failures = _handle_capture_failure(
                "error: {}".format(e),
                consecutive_failures,
                metrics,
                mediamtx_watchdog,
                liveness,
            )
            continue
        if img is None:
            # iter-264 (camera-library-usage-auditor A1): jetson-utils
            # `videoSource.Capture` returns None on a soft "no frame
            # arrived within the timeout" path — distinct from the
            # exception case above. Pre-iter-264 we incremented the
            # `dropped` counter and continued, but DID NOT bump
            # `consecutive_failures` or call the watchdog. Result: a
            # MediaMTX pipeline silently producing no frames (libargus
            # half-stuck, NvMMLite partial init) would never trip the
            # 30-failure watchdog or the 100-failure giving-up exit.
            #
            # iter-300 (root cause of "live feed broken 14h" user
            # report): pre-iter-300 the success-branch reset
            # `consecutive_failures = 0` + `on_capture_ok()` ran
            # UNCONDITIONALLY after Capture() returned, BEFORE this
            # None check. So a None return immediately reset both
            # counters, then the handler bumped consecutive_failures
            # to 1 — and the cycle repeated forever. The watchdog
            # never acted (`failures` reset every iteration to 0 then
            # 1), the 100-failure SystemExit never fired, and the
            # worker logged
            # "[detect] capture timeout (None) #1" 1460 times in
            # an hour with zero recovery action. Move the success
            # reset BELOW this check so it only runs on a real
            # frame (img is not None).
            consecutive_failures = _handle_capture_failure(
                "timeout (None)",
                consecutive_failures,
                metrics,
                mediamtx_watchdog,
                liveness,
            )
            continue
        # iter-300: real frame received. Reset both the local
        # counter AND the watchdog tally. Pre-iter-300 these were
        # at the top of the try block — see comment above.
        consecutive_failures = 0
        if mediamtx_watchdog.on_capture_ok():
            # Recovered from an escalated state — reset the PERSISTED ladder so
            # the next incident starts cheap (mediamtx restart), not mid-ladder.
            _clear_watchdog_escalation()
        # iter-302: timestamp of the most recent real frame. The
        # heartbeat thread forwards this; server derives
        # `seconds_since_last_frame` from it on /api/status. Without
        # this signal, a stalled stream looks identical to a healthy
        # one as long as the worker keeps heartbeating (which the
        # liveness gate forces it to, even when failing).
        metrics.last_frame_ts = time.time()
        metrics.frames += 1
        liveness.bump()

        # iter-172: sample thermal + memory pressure every N frames
        # BEFORE the early-continue ladder (manual-off / scheduled-off /
        # low-memory / inference-path). Pre-iter-172, sampling lived
        # inside the inference branch only. When the worker was stuck
        # in `low-memory` or `scheduled-off` gear, the guards never
        # got fresh readings — a chip that thermal-throttled and then
        # cooled while the gear was `low-memory` would stay
        # `thermal-throttled` until memory recovered AND the inference
        # path ran again. Now both guards step on every loop iteration
        # at their declared cadence regardless of gear, so transitions
        # back to healthy state are prompt.
        if metrics.frames % mem_check_every_n_frames == 0:
            memory_guard.step(read_mem_available_mb())
        if metrics.frames % thermal_check_every_n_frames == 0:
            thermal_guard.step(read_gpu_temp_c())

        # Refresh the "latest frame" snapshot once a second so /api/capture
        # has something recent to copy, regardless of the idle-gear gating
        # below. Cheap (~50 KB JPEG write) and means the user gets a
        # current frame on tap.
        #
        # iter-244b: atomic write via sibling intermediate + os.rename.
        # POSIX rename is atomic on the same filesystem, so the server-
        # side `CameraService.capture()` (shutil.copy of latest.jpg)
        # either sees the previous complete file or the new complete
        # one — never a partial JPEG mid-write. The user reported
        # "Part of the image isn't showing in the UI when I take a
        # capture. The rest of the image is white" — that was the
        # worker-write / server-read race surfacing a half-flushed
        # JPEG to the browser, which decoded what it had and rendered
        # the rest as canvas default.
        #
        # iter-244c: intermediate name MUST end in `.jpg` (not `.tmp`).
        # jetson-utils' `saveImage` infers codec from extension; an
        # unrecognised extension fails with `[image] invalid extension
        # format '.tmp' saving image ...` and the worker stops
        # producing latest.jpg entirely — surfaced as broken /api/
        # capture immediately after the iter-244b deploy. Use
        # `_latest.new.jpg` (leading underscore + .new.jpg keeps the
        # extension valid AND prevents the listing-regex defenses in
        # `/api/timelapses` etc. from accidentally picking up the
        # intermediate as a complete artifact).
        now_for_latest = time.time()
        if now_for_latest - last_latest_save >= 1.0:
            try:
                os.makedirs(thumb_dir, exist_ok=True)
                tmp_path = os.path.join(thumb_dir, "_latest.new.jpg")
                jetson_utils.saveImage(tmp_path, img, quality=thumb_quality)
                os.rename(tmp_path, latest_path)
                last_latest_save = now_for_latest
                # A successful save resets the warning gate so a future
                # outage logs once again, instead of forever silently.
                latest_save_warned = False
            except Exception as e:
                # Advance the timestamp even on failure: the original code
                # left it at 0.0 on persistent first-boot failures, which
                # meant the 1-Hz throttle never engaged and the loop tried
                # (and logged) on every active-gear frame (5 Hz). Now both
                # the retry attempt and the log are 1 Hz at most. The
                # warning is one-shot per outage period.
                last_latest_save = now_for_latest
                if not latest_save_warned:
                    print("[detect] latest.jpg save failed: {}".format(e), flush=True)
                    latest_save_warned = True

        # Idle gear: cap inference rate. When nothing has been detected
        # recently, run inference at idle_fps (default 1 Hz). When a
        # detection happened in the last idle_after_s window, run at
        # active_fps (default 5 Hz). This keeps the GPU off the thermal
        # throttle while still giving prompt response on motion.
        now = time.time()
        # plan B5: continuous-capture tick at the TOP of the loop body, BEFORE
        # any detection logic or early-continue (off / scheduled-off / zone-
        # reject / no-detection all early-continue below — exactly the absent
        # frames the absence deadline needs to fire on). Unconditional when the
        # runner is armed; no-op on the legacy path. The tracker is pure, so a
        # frame where the subject is gone still drives finalize at the deadline.
        if _VISIT_RUNNER is not None:
            _VISIT_RUNNER.set_absence_finalize_s(runtime.absence_finalize_s)
            _VISIT_RUNNER.tick(
                now, runtime.absence_finalize_s, runtime.max_visit_s,
            )
            # plan S6: mirror the runner's observability counters onto the
            # metrics heartbeat (same pattern as face_recog_names below).
            # Cheap plain-int reads; runner increments them on the main
            # thread so there's no torn read.
            metrics.visits_finalized = _VISIT_RUNNER.visits_finalized
            metrics.clips_dropped_disk_floor = (
                _VISIT_RUNNER.clips_dropped_disk_floor
            )
        # If the user has disabled detection (manually or via the schedule
        # window), drop the frame without running inference. Worker thus
        # burns no CUDA while still consuming the RTSP stream so it doesn't
        # back up. /api/status will show `worker_alive: true` because
        # heartbeats keep firing — the `gear` field tells the UI which
        # off-state we're in.
        if not runtime.enabled:
            _set_gear("off")
            del img
            continue
        if runtime.schedule_says_off():
            _set_gear("scheduled-off")
            del img
            continue

        # iter-172: sampling moved earlier (above the early-continue
        # ladder). The guards' state checks below remain in place —
        # only the `step()` calls relocated.
        # Memory pressure: when low, drop inference; we keep capturing +
        # writing latest.jpg above so the camera plane stays clean.
        if memory_guard.low:
            _set_gear("low-memory")
            del img
            continue

        # Thermal pressure: when hot, force the loop into idle gear
        # (1 fps) regardless of recent activity — slower-but-still-
        # running, so coverage degrades gracefully instead of dropping
        # to zero like the memory guard. Tegra's GPU thermal trip is
        # ~87 °C; the 80/70 hysteresis gives 7 °C of headroom before
        # the kernel autonomously clamps clocks (which would show up
        # as cpu_freq_pct < 100 in /api/status).
        thermally_throttled = thermal_guard.hot

        idle = thermally_throttled or (now - last_detection) > idle_after_s
        if thermally_throttled:
            _set_gear("thermal-throttled")
        else:
            _set_gear("idle" if idle else "active")
        target_period = idle_period if idle else active_period
        if target_period > 0 and (now - last_inference) < target_period:
            # Drop the cudaImage explicitly so jetson-utils releases the
            # underlying dmabuf promptly — leaving it for refcount GC has
            # caused "nvbuf_utils: NvReleaseFd Failed" log spam.
            del img
            continue
        last_inference = now

        infer_t0 = time.time()
        try:
            detections = net.Detect(img, overlay="none")
        except Exception as e:
            # net.Detect raised — a CUDA fault (illegal address, ECC
            # error, OOM on the GPU) or a TensorRT runtime error. This is
            # NOT recoverable in-process: the CUDA context is poisoned, so
            # every subsequent Detect would fault too. Log ERROR naming
            # the reason + frame count (one line — we re-raise so the loop
            # does NOT spin logging per-frame) and let systemd restart the
            # worker with a fresh CUDA context. del img so the dmabuf is
            # released before we unwind.
            del img
            log.error(
                "net.Detect CUDA fault at frame %s: %s: %s (CUDA context "
                "poisoned; worker will restart)",
                metrics.frames, type(e).__name__, e,
            )
            raise
        # Wall-clock per-inference latency. On the Nano 2GB at FP16 this is
        # ~45 ms steady-state and climbs into the 100s when the GPU thermal
        # throttles — the most direct signal we have for thermal pressure.
        # `record_infer_ms` updates both the latest scalar and the p95
        # ring buffer so the heartbeat snapshot can report both.
        metrics.record_infer_ms((time.time() - infer_t0) * 1000.0)
        metrics.inferences += 1
        # detectNet runs at a low floor; gate on the user's chosen threshold
        # post-inference so the slider in Settings is live. Per-class filter
        # uses jetson-inference's GetClassDesc(class_id) so we match on the
        # human-readable label rather than a hardcoded ID.
        threshold_now = runtime.threshold
        cooldown_now = runtime.cooldown_s
        wanted = set(runtime.classes)
        # An empty wanted-set means the user explicitly turned every class
        # off. Treat as "no detections" (silent), don't fall back to person.
        # WARN once on the transition into the empty state (re-arming
        # once-flag, NOT per-frame): a worker that emits zero events
        # because every class was deselected looks identical to "the
        # camera saw nobody" — the operator needs the reason. The flag
        # clears the moment a non-empty wanted-set is seen so re-enabling
        # a class logs a fresh recovery on the next non-empty poll.
        if not wanted:
            if not empty_class_warned:
                log.warning(
                    "wanted-class set is EMPTY (every class deselected in "
                    "Settings) - NO events will fire until a class is "
                    "re-enabled"
                )
                empty_class_warned = True
            del img
            continue
        empty_class_warned = False
        kept: list = []     # list[(detection, label)]
        for d in detections:
            if d.Confidence < threshold_now:
                continue
            label = net.GetClassDesc(d.ClassID).lower()
            if label not in wanted:
                continue
            kept.append((d, label))
        if not kept:
            del img
            continue

        now = time.time()
        # iter-272 (camera-algorithm-auditor B1): the cooldown gate
        # moved from HERE to AFTER the zone gate. Pre-iter-272 a
        # zone-rejected event still consumed the cooldown window —
        # blocking the next valid detection in the same class for
        # `cooldown_s` for no observable reason. The new flow:
        # zone-gate first (cheap; pure numeric polygon test), then
        # per-(label, camera_id) cooldown using the dict above.

        w = float(img.width)
        h = float(img.height)
        boxes = []
        try:
            for d, label in kept:
                # Use the box-normalizer helper so x+w <= 1 exactly
                # (clamps pixel coords before the division — the iter-96
                # follow-up to iter-95's server-side validator). The
                # helper raises ValueError on a zero-dim frame;
                # img.width/height come from videoSource and are always
                # positive on a live feed.
                boxes.append(normalize_box(
                    d.Left, d.Top, d.Right, d.Bottom, w, h, label, d.Confidence,
                ))
        except ValueError as e:
            # Non-positive frame dims (zero-width/height cudaImage —
            # corrupt frame, decoder hiccup). Pre-logging this propagated
            # and crashed the whole inference loop. ERROR naming the dims
            # + reason, then drop THIS frame and continue so one bad
            # frame doesn't take the worker down. del img first to
            # release the dmabuf.
            del img
            log.error(
                "box normalize failed for frame %s (w=%s h=%s): %s - "
                "frame dropped", metrics.frames, w, h, e,
            )
            continue
        # iter-356.53: capture this frame's boxes for any in-flight
        # clip's track sidecar — runs BEFORE zone/cooldown gates so
        # the post-roll path of a triggering event still sees every
        # frame even if downstream gates skip the rest of this loop
        # iteration. Also seeds the rolling deque used at emit time
        # to snapshot the pre-roll window.
        if _tracks_mod is not None:
            track_deque.append((now, list(boxes)))
            if active_tracks:
                _expired = []
                for _eid, _track in active_tracks.items():
                    if now > _track["expires_at"]:
                        _expired.append(_eid)
                    else:
                        _track["samples"].append((now, list(boxes)))
                for _eid in _expired:
                    _track = active_tracks.pop(_eid)
                    try:
                        _payload = _tracks_mod.build_payload(
                            _eid, _track["event_ts"],
                            _track["pre_roll_s"], _track["post_roll_s"],
                            _track["samples"],
                        )
                        _tracks_mod.write_sidecar(
                            recordings_dir, _eid, _payload,
                        )
                    except Exception as _e:
                        print(
                            "[detect] track sidecar write failed for {}: {}".format(_eid, _e),
                            flush=True,
                        )
        # iter-191b (Feature #5): zone gate. When the user has drawn
        # zones, drop the event entirely if no detection box's center
        # falls inside any polygon. Empty zones short-circuits to
        # True (pre-iter-191 behaviour). iter-272 reordered: zone
        # gate now runs BEFORE the cooldown gate, so a zone-rejected
        # false positive can't consume the cooldown window.
        if not any_box_center_inside_any_zone(boxes, runtime.zones):
            # Zone gate suppressed this detection: a box cleared the
            # threshold + wanted-class filters but its center fell
            # outside every drawn zone. Throttled INFO (at most one line
            # per `_ZONE_SUPPRESS_EVERY_S`) so a busy scene just outside
            # the zone doesn't flood the journal, but the operator can
            # still tell "zones are silently eating my detections" apart
            # from "nothing was detected" — only logged when zones are
            # actually configured (empty zones short-circuit to allow).
            if runtime.zones and (now - last_zone_suppress_log) >= _ZONE_SUPPRESS_EVERY_S:
                log.info(
                    "zone gate suppressed a %s detection (center outside "
                    "all %d zone(s)); throttled to 1/%.0fs",
                    top_label_for_log(kept), len(runtime.zones),
                    _ZONE_SUPPRESS_EVERY_S,
                )
                last_zone_suppress_log = now
            del img
            continue
        # Compute the top-confidence detection now — it drives the presence
        # key and the rest of the emit path.
        top_d, top_label = max(kept, key=lambda dl: dl[0].Confidence)
        # iter-271 (camera-algorithm-auditor C1): bump the idle-gear keepalive
        # once a detection has cleared threshold + wanted-classes + zone.
        # iter (presence coalescing): MOVED above the emit gate. With
        # coalescing, a lingering subject emits only ~once per clip — if the
        # keepalive only bumped on emit, the worker would drop to idle 1 fps
        # mid-presence. Bumping on every in-zone detection keeps it at active
        # fps while a subject is present. Still AFTER the zone gate, so a
        # zone-rejected false positive does NOT keep it awake (iter-271 intent).
        last_detection = now
        # iter-272 (camera-algorithm-auditor B1): per-(label, camera_id) key so
        # two concurrent classes (person + dog) are tracked independently.
        emit_key = "{}:{}".format(top_label, camera_id)
        # plan S4: continuous-capture path (HARD XOR with the legacy presence-
        # coalescing + start_clip path below). The keepalive bump above stays
        # ABOVE this gate (CLAUDE.md pin) so a coalesced-but-present subject
        # holds active fps. When the runner is armed we feed the present
        # detection into the visit tracker (open/extend/finalize handled inside)
        # and short-circuit: one visit = one clip, no per-event start_clip.
        if _VISIT_RUNNER is not None:
            top_box_cc = (top_d.Left, top_d.Top, top_d.Right, top_d.Bottom)
            # Pass the full normalized `boxes` (>=1 here) so the open POST
            # carries server-valid boxes; `top_box_cc` (pixel L/T/R/B) is the
            # single box the tracker uses for IoU continuity.
            _VISIT_RUNNER.observe(
                emit_key, top_box_cc, now,
                float(runtime.clip_pre_roll_s),
                runtime.absence_finalize_s, runtime.max_visit_s,
                boxes=boxes,
            )
            del img
            continue
        # Presence-coalescing gate (replaces the old flat per-key cooldown).
        # While this same subject keeps appearing in roughly the same place
        # (IoU-matched) AND its clip is still recording, suppress the re-fire —
        # one event per continuous presence. Re-arm to the next segment only
        # when a long linger outlasts its clip, so coverage stays complete and
        # the segments tile back-to-back without overlap. `cooldown_now` (the
        # old DETECT_COOLDOWN_S) is now the min-gap floor between emits. See
        # detection/presence.py + tests/test_presence.py.
        top_box = (top_d.Left, top_d.Top, top_d.Right, top_d.Bottom)
        clip_duration_s = max(
            runtime.clip_pre_roll_s + runtime.clip_post_roll_s, cooldown_now
        )
        if not presence_tracker.should_emit(
            emit_key, top_box, now, clip_duration_s,
            _PRESENCE_GAP_S, cooldown_now,
        ):
            # iter-172 cudaImage release symmetry — release the dmabuf promptly
            # so jetson-utils can recycle it; matches every other early-continue.
            del img
            continue
        # iter-187 (Feature #9 observability): time the whole save_thumb
        # call (mkdir + jetson_utils.saveImage + retention sweep). This
        # is the operator-level "what does a thumb cost me" number that
        # decides whether the NVENC swap is worth doing. The metric
        # rolls into the next heartbeat as `thumb_ms_recent`.
        thumb_t0 = time.time()
        thumb_url = save_thumb(img, now, thumb_dir, thumb_max, thumb_quality)
        metrics.record_thumb_ms((time.time() - thumb_t0) * 1000.0)
        if thumb_url is None:
            # save_thumb already logged the ERROR with the reason (dir +
            # exception). Bump the counter here at the caller (where
            # `metrics` is in scope) so the rate surfaces on /api/status.
            # Runs at most once per emitted event (cooldown-gated).
            metrics.thumb_save_failures += 1

        # iter-352 (face-capture-for-retraining): generate event_id
        # earlier so the recognizer's capture path can stamp it on the
        # saved JPEG filename. Pre-iter-352 event_id was generated AFTER
        # the recognize call, so the iter-351 capture would always
        # receive None and fall back to "unknown" in the filename. This
        # MUST stay BEFORE the recognize_in_crop block. The clip_recorder
        # below picks up the same event_id so the on-disk clip + face
        # capture cross-reference correctly.
        event_id = uuid.uuid4().hex

        # Face recognition: when the top detection is a person and we have
        # a known-faces database loaded, try to put a name on them. We run
        # this only after the cooldown gate (~once per emit) so the CPU
        # cost (~200ms hog detect + encode) is bounded.
        #
        # iter-357 (multi-person): instead of picking only the
        # highest-confidence person bbox, iterate the top-N person
        # detections (sorted by confidence desc, capped at
        # `_MAX_PERSONS_FACE_RECOG`, IoU-deduped at 0.5 against
        # already-processed boxes). Each box gets its own face-region
        # crop + recognize_in_crop pass, so a family of four standing
        # apart in the FOV all get face captures + matched names —
        # not just the closest one. `person_name` (legacy single-name
        # field) becomes the FIRST matched name for backward compat;
        # `person_names` (new list field) carries every matched name
        # in detection-confidence order, deduped case-insensitively.
        person_name = None
        person_names = []
        if (
            recognizer is not None
            and top_label == "person"
            and _MAX_PERSONS_FACE_RECOG > 0
        ):
            person_dets = [d for d, l in kept if l == "person"]
            # Sort by confidence DESC so we process the strongest
            # detections first — both for the IoU dedup (the kept
            # box is the higher-confidence twin) and for the legacy
            # `person_name = person_names[0]` semantic (first name
            # = first-detected person).
            person_dets_sorted = sorted(
                person_dets, key=lambda d: d.Confidence, reverse=True,
            )
            try:
                rgb = cuda_to_rgb_numpy(img)
                src_w = int(w)
                src_h = int(h)
                # Pre-compute clamped bboxes for the whole batch so
                # the IoU dedup can compare candidates against the
                # already-accepted set without re-clamping each time.
                # Each entry: (det, clamp) where clamp is the (left,
                # top, right, bot) tuple OR None for degenerate boxes.
                with_clamps = [
                    (d, _clamped_person_bbox(rgb, d)) for d in person_dets_sorted
                ]
                # Greedy selection: walk in confidence order, accept
                # if (a) bbox is non-degenerate, (b) IoU < 0.5 with
                # every already-accepted bbox, (c) we haven't hit
                # the per-event cap.
                selected_clamps = []
                selected_dets = []
                for det, clamp in with_clamps:
                    if clamp is None:
                        continue
                    is_dup = False
                    for prev in selected_clamps:
                        if (
                            _bbox_iou(
                                clamp[0], clamp[1], clamp[2], clamp[3],
                                prev[0], prev[1], prev[2], prev[3],
                            )
                            >= _PERSON_DEDUP_IOU
                        ):
                            is_dup = True
                            break
                    if is_dup:
                        continue
                    selected_dets.append(det)
                    selected_clamps.append(clamp)
                    if len(selected_dets) >= _MAX_PERSONS_FACE_RECOG:
                        break

                # Per-person face-recog + capture pass. Each
                # iteration is best-effort: a single failed
                # recognize_in_crop must NOT abort the loop or drop
                # other people from the event. `seen_lower` dedups
                # matched names case-insensitively across persons
                # (two SSD bboxes both matching "Alice" produce one
                # "Alice" in person_names).
                seen_lower = set()
                for idx, (det, clamp) in enumerate(
                    zip(selected_dets, selected_clamps)
                ):
                    try:
                        crop = crop_face_region(rgb, det)
                        if crop is None:
                            continue
                        p_left, p_top, p_right, p_bot = clamp
                        if src_w > 0 and src_h > 0:
                            bbox_pixels = [p_left, p_top, p_right, p_bot]
                            bbox_norm = [
                                p_left / float(src_w),
                                p_top / float(src_h),
                                p_right / float(src_w),
                                p_bot / float(src_h),
                            ]
                        else:
                            bbox_pixels = None
                            bbox_norm = None
                        # iter-357: per-person capture_meta carries
                        # `person_index` so a downstream operator
                        # auditing /face_captures/<event_id>_*.json
                        # can tell whether two crops came from the
                        # same physical person (same event, two
                        # face crops in one face-region) or two
                        # different people (different person_index).
                        capture_meta = {
                            "source": {
                                "w": src_w,
                                "h": src_h,
                                "camera_id": camera_id,
                            },
                            "model": {
                                "name": model,
                                "version": os.getenv(
                                    "HOMECAM_MODEL_VERSION", "trt-fp16",
                                ),
                                "floor": RuntimeConfig.DETECT_FLOOR,
                            },
                            "detection": {
                                "label": top_label,
                                "score": float(det.Confidence),
                                "bbox_pixels": bbox_pixels,
                                "bbox_norm": bbox_norm,
                            },
                            "pad_frac": 0.30,
                            "jpeg_quality": 95,
                            "infer_ms": metrics.infer_ms_recent or None,
                            "gear": metrics.gear,
                            "sw_rev": _SW_REV,
                            "person_index": idx,
                        }
                        face_origin_xy = (p_left, p_top)
                        # ts_ms offset by `idx * 1000` so concurrent
                        # captures across persons in the SAME event
                        # don't collide on the recognizer's
                        # `(ts_ms or 0) + idx` filename suffix
                        # (which dedups WITHIN one person's face
                        # crops but not ACROSS persons).
                        per_person_ts_ms = int(now * 1000) + (idx * 1000)
                        matched = recognizer.recognize_in_crop(
                            crop,
                            capture_dir=face_captures_dir or None,
                            event_id=event_id,
                            ts_ms=per_person_ts_ms,
                            capture_meta=capture_meta,
                            face_origin_xy=face_origin_xy,
                        )
                        if matched:
                            lo = matched.lower()
                            if lo not in seen_lower:
                                seen_lower.add(lo)
                                person_names.append(matched)
                        # Save the FULL person crop alongside the
                        # face captures (iter-356.62 slice 1
                        # contract preserved). One full-body crop
                        # PER selected person bbox.
                        if person_captures_dir:
                            try:
                                from PIL import Image as _PIL_Image
                                import io as _io
                                from face_recog.capture import (
                                    save_person_capture,
                                )
                                person_crop_arr = rgb[p_top:p_bot, p_left:p_right]
                                if person_crop_arr.size > 0:
                                    _img = _PIL_Image.fromarray(person_crop_arr)
                                    _buf = _io.BytesIO()
                                    _img.save(_buf, format="JPEG", quality=95)
                                    save_person_capture(
                                        capture_dir=person_captures_dir,
                                        name=matched,
                                        event_id=event_id,
                                        ts_ms=per_person_ts_ms,
                                        jpeg_bytes=_buf.getvalue(),
                                        predicted_name=matched,
                                        meta=dict(capture_meta, kind="person"),
                                    )
                            except Exception as _pe:
                                # Full-person training crop failed to
                                # save for THIS person (PIL encode, disk
                                # write). Best-effort: the face capture +
                                # event are unaffected. WARN + bump the
                                # face-recog failure counter (runs at most
                                # once per emit, not per-frame).
                                metrics.face_recog_failures += 1
                                log.warning(
                                    "person capture save failed for "
                                    "event=%s idx=%s: %s: %s",
                                    event_id, idx, type(_pe).__name__, _pe,
                                )
                    except Exception as _per_e:
                        # Per-person glitch must NOT drop other selected
                        # people. WARN naming the person index + reason,
                        # bump the counter, and continue so the rest of
                        # the batch still gets recognized.
                        metrics.face_recog_failures += 1
                        log.warning(
                            "per-person face match failed for event=%s "
                            "idx=%s: %s: %s (other people in frame still "
                            "processed)",
                            event_id, idx, type(_per_e).__name__, _per_e,
                        )
                        continue
                # Legacy single-name field = first matched name
                # (or None when nobody recognized). Preserves the
                # iter-22..iter-356 wire shape for old clients/tests
                # that read `event.person_name` directly.
                person_name = person_names[0] if person_names else None
            except Exception as e:
                # Whole face-recog batch failed (numpy materialize, the
                # selection loop, an unexpected recognizer error). Don't
                # let it block the event — the event still fires without
                # names. WARN naming the event + reason and bump the
                # counter so a recognizer that's silently failing every
                # event is visible on /api/status.
                metrics.face_recog_failures += 1
                log.warning(
                    "face match batch failed for event=%s: %s: %s "
                    "(event fires without recognized names)",
                    event_id, type(e).__name__, e,
                )
                person_name = None
                person_names = []

        # iter-284 (camera-library-usage-auditor A2): release the
        # cudaImage dmabuf BEFORE the network-I/O-heavy emit path.
        # Pre-iter-284 `del img` happened at the end of the loop
        # iteration (after post_event), so the GPU buffer was held
        # through `start_clip` (subprocess fork + ffmpeg launch) +
        # `post_event` (urllib HTTP roundtrip). Worst case ~200 ms
        # of held dmabuf per emit when pywebpush latency dominates,
        # which leaks "nvbuf_utils: NvReleaseFd Failed" warnings
        # exactly the iter-4 run-detect.sh wrapper filters. After
        # this point: save_thumb already ran (line above), the
        # numpy copy in cuda_to_rgb_numpy already decoupled the
        # face-recog crop's lifetime, and nothing further reads
        # `img`. Releasing here lets jetson-utils recycle the
        # buffer for the next Capture() ~100 ms sooner.
        del img

        # iter-247: event_id was previously generated here. iter-352
        # hoisted it ABOVE the recognize_in_crop block so the iter-351
        # face-capture path can stamp it on the saved JPEG filename.
        # Same uuid.hex shape; same matching charset on the server side.
        clip_url = None
        if clip_recorder is not None:
            try:
                # iter-254: pass live `clip_post_roll_s` so Settings-
                # slider changes take effect on the NEXT detection
                # without a worker restart. Recorder defaults if None.
                # iter-324: also pass live `clip_pre_roll_s` + the
                # PrerollBuffer ref so the recorder can ffmpeg-concat
                # pre-event segments + post-roll into the final clip.
                # Pre-roll fields default to "off" when buffer is None
                # — the existing post-roll-only path is unchanged.
                if clip_recorder.start_clip(
                    event_id,
                    duration_s=runtime.clip_post_roll_s,
                    pre_roll_s=runtime.clip_pre_roll_s,
                    preroll_buffer=preroll_buffer,
                ):
                    clip_url = "/api/events/{}/clip".format(event_id)
                    # iter-356.53: register the active track. Snapshot
                    # the pre-roll window from the rolling deque NOW,
                    # then keep appending post-roll samples each loop
                    # iteration above until `expires_at`. The +1.0 s
                    # grace covers ffmpeg flush + the moment the clip
                    # MP4 lands on disk.
                    if _tracks_mod is not None:
                        _pre_lo = now - float(runtime.clip_pre_roll_s)
                        _pre_samples = [
                            (_t, _b) for (_t, _b) in list(track_deque)
                            if _t >= _pre_lo
                        ]
                        active_tracks[event_id] = {
                            "event_ts": now,
                            "pre_roll_s": float(runtime.clip_pre_roll_s),
                            "post_roll_s": float(runtime.clip_post_roll_s),
                            "samples": _pre_samples,
                            "expires_at": now + float(runtime.clip_post_roll_s) + 1.0,
                        }
                else:
                    # start_clip returned False — capacity was full
                    # (max_concurrent ffmpeg subprocesses already
                    # in-flight; the event_id is always a fresh uuid so
                    # the malformed-id branch can't be hit here). The
                    # recording module stays log-free by design (so it
                    # unit-tests without a logger), so the DROP is logged
                    # HERE at the caller. Pre-logging this was fully
                    # silent: a sustained burst would drop every clip
                    # with zero signal. WARN + bump the capacity counter
                    # so the operator sees both the line and the rate on
                    # /api/status.
                    metrics.clips_dropped_capacity += 1
                    log.warning(
                        "clip dropped at capacity for event=%s (%d/%d "
                        "concurrent recordings in flight); event still "
                        "fires without a clip",
                        event_id, clip_recorder.in_flight(),
                        clip_recorder.max_concurrent,
                    )
            except Exception as e:
                # Recorder raised (ffmpeg spawn failure, makedirs OSError,
                # etc. propagated out of start_clip). Best-effort: the
                # event still flows; clip_url stays None and the client
                # modal falls back to the snapshot. ERROR naming the
                # event + reason, and bump `clip_start_failures` so the
                # rate is visible.
                metrics.clip_start_failures += 1
                log.error(
                    "clip start failed for event=%s: %s: %s (event fires "
                    "without a clip)", event_id, type(e).__name__, e,
                )

        payload = {
            "id": event_id,
            "label": top_label,
            "score": float(top_d.Confidence),
            "boxes": boxes,
            "camera_id": camera_id,
        }
        if thumb_url:
            payload["thumb_url"] = thumb_url
        if person_name:
            payload["person_name"] = person_name
        # iter-357 (multi-person): emit `person_names` only when a
        # match was made — null/absent = "no recognized faces" stays
        # consistent with the iter-22 person_name semantics. The
        # field is omitted (not sent as []) when empty so older
        # server validators that don't recognize the key still
        # accept the payload (Pydantic `extra='forbid'` rejects
        # unknown KEYS, but missing-default-None on the new field
        # accepts payloads that don't carry it).
        if person_names:
            payload["person_names"] = person_names
        if clip_url:
            payload["clip_url"] = clip_url
        post_event(event_url, payload, metrics=metrics)
        metrics.emitted += 1

        elapsed = max(time.time() - started, 0.001)
        # iter-357: log line surfaces the full match list when
        # multi-person — operator running `journalctl -u homecam-detect
        # -f` sees the actual fan-out happen, not just the first name.
        if person_names:
            if len(person_names) > 1:
                name_suffix = " (faces={})".format(",".join(person_names))
            else:
                name_suffix = " (face={})".format(person_names[0])
        else:
            name_suffix = ""
        print(
            "[detect] {} score={:.2f} count={}{} | frames={} infer={} ({:.1f}/s) emitted={} gear={}".format(
                top_label,
                top_d.Confidence,
                len(kept),
                name_suffix,
                metrics.frames,
                metrics.inferences,
                metrics.inferences / elapsed,
                metrics.emitted,
                metrics.gear,
            ),
            flush=True,
        )
        # iter-284 (A2): `del img` moved upstream — see comment
        # before the face-recog block. Removed from here so a
        # CudaImage isn't double-freed (jetson-utils tolerates it
        # but the contract is one `del` per Capture).


if __name__ == "__main__":
    main()
