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
try:
    from face_recog.recognizer import FaceRecognizer  # noqa: E402
except Exception:
    FaceRecognizer = None
from box_norm import normalize_box  # noqa: E402
from mediamtx_watchdog import MediaMtxWatchdog  # noqa: E402
from memory_guard import MemoryGuard, read_mem_available_mb  # noqa: E402
from metrics import Metrics  # noqa: E402
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
        print("[detect] thumb save failed: {}".format(e), flush=True)
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


def post_event(url, payload, timeout=2.0):
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=body, method="POST")
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            resp.read()
    except urllib.error.HTTPError as e:
        try:
            detail = e.read().decode("utf-8", "replace")[:200]
        except Exception:
            detail = ""
        print("[detect] event POST {} {} {}".format(e.code, e.reason, detail), flush=True)
    except Exception as e:
        print("[detect] event POST failed: {}".format(e), flush=True)


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

    def schedule_says_off(self):
        """True if the current local time is inside the off-window.

        Pure logic delegated to `schedule.in_off_window` (testable
        without monkeypatching `time.localtime`); this method just
        plugs in the current local-time minute-of-day.
        """
        now = time.localtime()
        cur = now.tm_hour * 60 + now.tm_min
        return in_off_window(self.schedule_off_start, self.schedule_off_end, cur)


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
        while True:
            try:
                req = urllib.request.Request(url, method="GET")
                with urllib.request.urlopen(req, timeout=2.0) as resp:
                    data = json.loads(resp.read().decode("utf-8"))
                if "threshold" in data:
                    runtime.threshold = float(data["threshold"])
                if "cooldown_s" in data:
                    runtime.cooldown_s = float(data["cooldown_s"])
                if "enabled" in data:
                    runtime.enabled = bool(data["enabled"])
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
                # iter-191b (Feature #5): zones from the server config.
                # `sanitize_zones` mirrors server-side `_valid_zones`
                # bounds (3-32 vertices, coords [0,1], up to 16 polys)
                # so a transient corrupt payload or downgraded server
                # can't poison the worker's runtime.
                if "zones" in data:
                    runtime.zones = sanitize_zones(data["zones"])
                # iter-254 (Feature #1 polish): live-tunable clip
                # duration knobs. Wrapped in try/except so a corrupt
                # payload doesn't poison the runtime (Python 3.6
                # compat — no walrus / structural pattern match).
                if "clip_post_roll_s" in data:
                    try:
                        runtime.clip_post_roll_s = float(data["clip_post_roll_s"])
                    except (ValueError, TypeError):
                        pass
                if "clip_pre_roll_s" in data:
                    try:
                        runtime.clip_pre_roll_s = float(data["clip_pre_roll_s"])
                    except (ValueError, TypeError):
                        pass
                    # iter-356.61: grow the segment-recorder ring if
                    # the slider asked for more pre-roll than the
                    # current capacity covers. No-op when the ring
                    # already has enough headroom; never shrinks.
                    if preroll_buffer is not None:
                        try:
                            preroll_buffer.ensure_capacity_for(
                                runtime.clip_pre_roll_s,
                            )
                        except Exception as _e:
                            print(
                                "[detect] preroll resize failed: {}".format(_e),
                                flush=True,
                            )
                backoff = 1.0
                warned = False
            except Exception as e:
                if not warned:
                    print("[detect] config poll failed: {}".format(e), flush=True)
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
                if backoff <= 1.0:
                    print(
                        "[detect] heartbeat skipped: inference loop stalled "
                        "({:.1f}s since last bump)".format(
                            time.time() - liveness.last_active
                        ),
                        flush=True,
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
                # Don't spam the log — heartbeat failures are routine during
                # server restart. Print once per backoff cycle.
                if backoff <= 1.0:
                    print("[detect] heartbeat failed: {}".format(e), flush=True)
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
        print("[detect] face_recog wrapper missing - face capture disabled", flush=True)
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
        print("[detect] face recognizer in MATCH mode ({} encodings, tolerance={})".format(
            len(rec.names), rec.tolerance), flush=True)
    else:
        print("[detect] face recognizer in CAPTURE-ONLY mode "
              "(no encodings or face_recognition unavailable; "
              "cv2 Haar fallback will save crops)", flush=True)
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
    mediamtx-only restarts have failed to recover the stream — see
    `mediamtx_watchdog.should_escalate`. Heavy-hammer: kills + restarts
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
    5. Watchdog restart check; iter-172 unconditional `mark_restarted`
       so a wedged sudo doesn't burn ~10 s every iteration.
    6. SystemExit at 100 — systemd recovers.

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
    if mediamtx_watchdog.should_restart(now):
        # iter-302: escalation tier. After 2 mediamtx-only restarts
        # have failed to recover the stream, the next watchdog kick
        # restarts nvargus-daemon FIRST (the iter-300 wedge that
        # mediamtx alone couldn't unstick) then mediamtx. Both
        # paths bump mark_restarted so cooldown applies regardless.
        if mediamtx_watchdog.restart_count >= 2:
            success = escalate_argus_recovery()
            if success:
                metrics.argus_restarts += 1
        else:
            success = restart_mediamtx()
            if success:
                metrics.mediamtx_restarts = mediamtx_watchdog.restart_count + 1
        mediamtx_watchdog.mark_restarted(now)
    if consecutive_failures > 100:
        print(
            "[detect] giving up after 100 consecutive capture failures "
            "({})".format(reason),
            flush=True,
        )
        raise SystemExit(1)
    return consecutive_failures


def main():
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
            print("[detect] clip recorder armed -> {} ({}s clips, max {} concurrent)".format(
                recordings_dir, clip_duration_s, clip_max_concurrent,
            ), flush=True)
        except Exception as e:
            print("[detect] clip recorder disabled: {}".format(e), flush=True)
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
                    print("[detect] preroll buffer armed -> {} (watchdog 10s)".format(
                        preroll_dir,
                    ), flush=True)
                else:
                    print("[detect] preroll buffer failed to start", flush=True)
                    preroll_buffer = None
            except Exception as e:
                print("[detect] preroll buffer disabled: {}".format(e), flush=True)
                preroll_buffer = None

    # detectNet uses a fixed low floor; the live-tunable threshold filters
    # the results post-inference (avoids reloading the TRT engine).
    print("[detect] loading {} (floor={}, initial threshold={})".format(
        model, RuntimeConfig.DETECT_FLOOR, threshold), flush=True)
    net = jetson_inference.detectNet(model, threshold=RuntimeConfig.DETECT_FLOOR)
    print("[detect] model ready", flush=True)

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
    metrics_known_names = (
        sorted(set(recognizer.names)) if recognizer is not None else []
    )
    config_url = event_url.rsplit("/event", 1)[0] + "/detection/config"
    # iter-356.61: thread the preroll_buffer through so the poll can
    # grow the segment-recorder ring on demand when the user pushes
    # the Settings "Pre-roll" slider above the boot-time capacity.
    start_config_poll(config_url, runtime, preroll_buffer=preroll_buffer)
    print("[detect] config poll -> {}".format(config_url), flush=True)

    # Liveness signal driven by the inference loop; heartbeat thread reads
    # it before each POST. Bumped here so the server sees us alive during
    # the camera open + RTSP warmup window.
    liveness = Liveness()
    metrics = Metrics()
    metrics.face_recog_names = metrics_known_names
    heartbeat_url = event_url.rsplit("/", 1)[0] + "/heartbeat"
    start_heartbeat(heartbeat_url, liveness, metrics)
    print("[detect] heartbeat -> {}".format(heartbeat_url), flush=True)

    print("[detect] opening source {}".format(source_uri), flush=True)
    camera = open_camera(source_uri)
    print("[detect] source open; sending events to {}".format(event_url), flush=True)
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
    last_emit_by_key = {}  # type: ignore[var-annotated]
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
        # Fail-quiet: if tracks.py is missing or broken, fall back
        # to today's static-overlay behavior. The clip MP4 path is
        # independent.
        print("[detect] track sidecar disabled: {}".format(_e), flush=True)
        _tracks_mod = None
    last_inference = 0.0
    last_detection = 0.0
    last_latest_save = 0.0
    latest_save_warned = False
    started = time.time()
    metrics.started = started  # so fps() / infer_per_s() use the same baseline
    latest_path = os.path.join(thumb_dir, "latest.jpg")

    consecutive_failures = 0
    # The watchdog kicks mediamtx after a sustained burst of capture
    # timeouts — covers the failure mode where the gst-launch pipeline
    # stays alive in mediamtx's cgroup but stops producing frames
    # (libargus hang, NvMMLite block error). detect.py restarting alone
    # would just reconnect to the same dead RTSP path. Tuned so a single
    # mediamtx kick happens around the 60 s mark; if THAT doesn't clear
    # it, the existing 100-failure exit will hand recovery to systemd.
    mediamtx_watchdog = MediaMtxWatchdog(fail_threshold=30, cooldown_s=60.0)
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
    thermal_check_every_n_frames = 30
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
            # to 1 — and the cycle repeated forever. Watchdog
            # `should_restart` never returned True (`failures` reset
            # every iteration to 0 then 1), the 100-failure
            # SystemExit never fired, and the worker logged
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
        mediamtx_watchdog.on_capture_ok()
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
        # If the user has disabled detection (manually or via the schedule
        # window), drop the frame without running inference. Worker thus
        # burns no CUDA while still consuming the RTSP stream so it doesn't
        # back up. /api/status will show `worker_alive: true` because
        # heartbeats keep firing — the `gear` field tells the UI which
        # off-state we're in.
        if not runtime.enabled:
            metrics.gear = "off"
            del img
            continue
        if runtime.schedule_says_off():
            metrics.gear = "scheduled-off"
            del img
            continue

        # iter-172: sampling moved earlier (above the early-continue
        # ladder). The guards' state checks below remain in place —
        # only the `step()` calls relocated.
        # Memory pressure: when low, drop inference; we keep capturing +
        # writing latest.jpg above so the camera plane stays clean.
        if memory_guard.low:
            metrics.gear = "low-memory"
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
            metrics.gear = "thermal-throttled"
        else:
            metrics.gear = "idle" if idle else "active"
        target_period = idle_period if idle else active_period
        if target_period > 0 and (now - last_inference) < target_period:
            # Drop the cudaImage explicitly so jetson-utils releases the
            # underlying dmabuf promptly — leaving it for refcount GC has
            # caused "nvbuf_utils: NvReleaseFd Failed" log spam.
            del img
            continue
        last_inference = now

        infer_t0 = time.time()
        detections = net.Detect(img, overlay="none")
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
        if not wanted:
            del img
            continue
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
        for d, label in kept:
            # Use the box-normalizer helper so x+w <= 1 exactly (clamps
            # pixel coords before the division — the iter-96 follow-up
            # to iter-95's server-side validator). The helper raises
            # ValueError on a zero-dim frame; img.width/height come
            # from videoSource and are always positive on a live feed.
            boxes.append(normalize_box(
                d.Left, d.Top, d.Right, d.Bottom, w, h, label, d.Confidence,
            ))
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
            del img
            continue
        # Compute the top-confidence detection now — it drives both
        # the cooldown key (iter-272 B1) and the rest of the emit path.
        top_d, top_label = max(kept, key=lambda dl: dl[0].Confidence)
        # iter-272 (camera-algorithm-auditor B1): per-(label, camera_id)
        # cooldown. Two concurrent classes (person + dog) are gated
        # independently so a low-priority bark doesn't suppress a
        # high-priority person event in the same window.
        emit_key = "{}:{}".format(top_label, camera_id)
        if now - last_emit_by_key.get(emit_key, 0.0) < cooldown_now:
            # iter-172 cudaImage release symmetry — release the dmabuf
            # promptly so jetson-utils can recycle it; matches every
            # other early-continue in this loop.
            del img
            continue
        last_emit_by_key[emit_key] = now
        # Bound the dict's growth. Label vocab × camera count is
        # bounded today (single camera + ~10 wanted classes), but
        # this is a defensive cap against operator misconfig (e.g.
        # selecting all 90 SSD classes). Drop the oldest entry —
        # not strictly LRU but cheap and correct under our access
        # pattern (recent labels stay hot).
        if len(last_emit_by_key) > 32:
            oldest = min(last_emit_by_key, key=last_emit_by_key.get)
            del last_emit_by_key[oldest]
        # iter-271 (camera-algorithm-auditor C1): bump idle-gear ONLY
        # after a detection has cleared every filter (threshold +
        # wanted-classes + zone + cooldown). Pre-iter-271 the bump
        # happened right after the wanted-classes filter, so a
        # zone-rejected false positive kept the worker at 5 fps for
        # the full idle_after_s window.
        last_detection = now
        # iter-187 (Feature #9 observability): time the whole save_thumb
        # call (mkdir + jetson_utils.saveImage + retention sweep). This
        # is the operator-level "what does a thumb cost me" number that
        # decides whether the NVENC swap is worth doing. The metric
        # rolls into the next heartbeat as `thumb_ms_recent`.
        thumb_t0 = time.time()
        thumb_url = save_thumb(img, now, thumb_dir, thumb_max, thumb_quality)
        metrics.record_thumb_ms((time.time() - thumb_t0) * 1000.0)

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
        person_name = None
        if recognizer is not None and top_label == "person":
            person_dets = [d for d, l in kept if l == "person"]
            top_person = max(person_dets, key=lambda d: d.Confidence)
            try:
                rgb = cuda_to_rgb_numpy(img)
                crop = crop_face_region(rgb, top_person)
                if crop is not None:
                    # iter-352: thread face_captures_dir + event_id +
                    # ts_ms into the recognizer so the iter-351 capture
                    # path actually fires. Empty FACE_CAPTURES_DIR =
                    # capture disabled (operator opt-out). Mirrors the
                    # RECORDINGS_DIR opt-out convention. ts_ms is the
                    # current emit time in unix-epoch ms (worker uses
                    # `now` floats elsewhere; convert here).
                    person_name = recognizer.recognize_in_crop(
                        crop,
                        capture_dir=face_captures_dir or None,
                        event_id=event_id,
                        ts_ms=int(now * 1000),
                    )
            except Exception as e:
                # Don't let a face-recognition glitch block the event.
                print("[detect] face match failed: {}".format(e), flush=True)
                person_name = None

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
            except Exception as e:
                # Recorder failures are best-effort. The event still
                # flows; clip_url stays None and the client modal
                # falls back to the snapshot.
                print("[detect] clip start failed: {}".format(e), flush=True)

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
        if clip_url:
            payload["clip_url"] = clip_url
        post_event(event_url, payload)
        metrics.emitted += 1

        elapsed = max(time.time() - started, 0.001)
        name_suffix = " (face={})".format(person_name) if person_name else ""
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
