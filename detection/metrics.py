"""Live perf snapshot for the detection worker's heartbeat.

Extracted from `detect.py` so the percentile / ring-buffer / counter
logic can be unit-tested without pulling in `jetson_inference` and
`jetson_utils` (which only load on a Jetson host).

Must stay Python 3.6 compatible — runs on JetPack 4.x's host Python.
No `from __future__ import annotations`, no PEP-604 unions.

Threading model:
    The class is read by the heartbeat thread and written by the main
    inference loop. We rely on CPython's GIL to make scalar / list
    appends / `dict.copy()` atomic under contention. No explicit lock —
    if you ever need stronger ordering (e.g. for a metric that's
    multi-step to update), add it then.
"""
import collections
import time


class Metrics:
    """Live perf snapshot the inference loop exposes for the heartbeat
    thread to forward to the server.

    `face_recog_names` is the de-duplicated list of names currently in
    the recognizer's encoding database. Empty list = recognition
    disabled (or no encodings loaded). Sent so the UI can show "Knows:
    Israel, Sheenal" without an extra round-trip.
    """

    # Ring-buffer cap for `_infer_history`. 20 calls cover ~4 s at
    # active gear (5 fps) or ~20 s at idle gear (1 fps) — enough to
    # smooth single cold-cache spikes but short enough that the p95
    # actually moves when sustained throttle starts.
    INFER_HISTORY_CAP = 20
    # Minimum samples before `infer_ms_p95()` returns a meaningful
    # value. Below this, the worker's first cold-cache TRT inference
    # (~8 s) dominates the percentile and shows up in the UI as
    # `infer_ms_p95: 8000`, which is misleading. Wait until we have
    # at least 5 samples so a single outlier can't skew the result.
    INFER_HISTORY_WARMUP = 5

    def __init__(self):
        self.frames = 0
        self.inferences = 0
        self.emitted = 0
        # Total Capture() failures since worker start. The capture loop
        # already counts consecutive failures for a fast-restart
        # trigger; this is the cumulative tally so the UI can surface
        # RTSP flakiness over time without needing journald access.
        self.dropped = 0
        # Wall-clock latency of the most recent net.Detect() call, in
        # milliseconds. 0.0 until the first inference completes.
        self.infer_ms_recent = 0.0
        # Ring buffer of the last N inference latencies (ms). p95 over
        # this window is a more honest "is the GPU under sustained
        # thermal pressure" signal than `infer_ms_recent` — a single
        # cold-cache TRT call can spike to 100+ ms even on a healthy
        # system, but a p95 above 80 ms over 20 calls means real load.
        self._infer_history = collections.deque(maxlen=self.INFER_HISTORY_CAP)
        # The very first `net.Detect()` after a worker boot pays the
        # full TensorRT engine warm-up (~8 s) and is never representative.
        # We update `infer_ms_recent` for it (so the user can see the
        # raw timing if they're staring at the UI right after restart)
        # but exclude it from the ring buffer that feeds p95 — otherwise
        # the cold-cache outlier dominates the percentile until it's
        # rotated out, which can be tens of seconds at idle gear.
        self._cold_cache_sample_skipped = False
        # Count of times the mediamtx watchdog has kicked the gateway
        # since worker start. Updated by the capture loop after each
        # successful restart. Persistent rises here mean the camera
        # pipeline is dropping out repeatedly.
        self.mediamtx_restarts = 0
        # iter-302 (user "Make sure that all issues that caused the
        # live feed to break will never happen again"): tally of
        # nvargus-daemon escalations since worker start. After N
        # consecutive mediamtx-only restarts fail to recover the
        # stream, the worker escalates to a nvargus-daemon restart
        # (the iter-300 wedge that mediamtx alone couldn't unstick).
        # A non-zero value here means the camera pipeline needed
        # the heavy-hammer recovery path.
        self.argus_restarts = 0
        # iter-302: wall-clock unix-epoch seconds of the most recent
        # successful Capture() (img is not None). Surfaced on
        # /api/status as `seconds_since_last_frame` so the UI can
        # render a "STREAM STALE" pill when the worker is alive but
        # no frames are flowing — exactly the iter-300 silent-stall
        # signature. 0.0 until the first real frame arrives.
        self.last_frame_ts = 0.0
        # iter-187 (Feature #9 observability): wall-clock ms for the
        # most recent `save_thumb()` call. Captures the whole save
        # path (mkdir + jetson_utils.saveImage + retention sweep), not
        # just the encode — that's the honest "what does a thumb cost
        # me" number an operator needs before deciding whether to
        # invest in the NVENC swap. 0.0 until the first detection
        # event fires.
        self.thumb_ms_recent = 0.0
        self.gear = "idle"
        self.face_recog_names = []
        # logging-plan (docs/logging_plan.md §1.2): failure-rate counters.
        # Individual failures are logged to journald at their call site;
        # these cumulative counters let the operator see the RATE over
        # time on /api/status without journald access. Each is bumped
        # directly (`metrics.clip_start_failures += 1`) at the
        # corresponding failure site in detect.py / recording.py. They
        # are part of the producer/consumer contract pinned by
        # test_internal.py::test_worker_snapshot_keys_match_whitelist —
        # snapshot() keys must equal the server _ALLOWED_METRIC_FIELDS.
        self.clips_dropped_capacity = 0
        self.clip_start_failures = 0
        self.face_recog_failures = 0
        self.event_post_failures = 0
        self.thumb_save_failures = 0
        # Continuous-capture observability (plan S6). Only meaningful when the
        # worker runs with DETECT_CONTINUOUS_CAPTURE=1; both stay 0 on the
        # legacy fixed-clip path. detect.py mirrors these from the live
        # VisitRunner before each heartbeat.
        #  - visits_finalized: visits that reached finalize (one clip each).
        #  - clips_dropped_disk_floor: opens REFUSED because free space was
        #    below the worker disk floor (S4.5/B2) — the clip was skipped.
        self.visits_finalized = 0
        self.clips_dropped_disk_floor = 0
        self.started = time.time()

    def fps(self):
        elapsed = self.uptime_s()
        return (self.frames / elapsed) if elapsed > 0 else 0.0

    def infer_per_s(self):
        elapsed = self.uptime_s()
        return (self.inferences / elapsed) if elapsed > 0 else 0.0

    def uptime_s(self):
        """Wall-clock seconds since worker start. The cumulative
        counters (`frames`, `dropped`, `mediamtx_restarts`) only make
        sense relative to this — surface it on the heartbeat so the
        UI can render "5 dropped over 4h" instead of just "5 dropped"
        forever."""
        return max(0.0, time.time() - self.started)

    def record_infer_ms(self, ms):
        """Update both the recent-value field and the ring buffer that
        feeds `infer_ms_p95()`. Called from the inference loop with the
        wall-clock latency of the most recent `net.Detect()`. Skips the
        very first sample from the ring buffer — see the
        `_cold_cache_sample_skipped` doc comment for why."""
        self.infer_ms_recent = ms
        if not self._cold_cache_sample_skipped:
            self._cold_cache_sample_skipped = True
            return
        self._infer_history.append(ms)

    def record_thumb_ms(self, ms):
        """Update `thumb_ms_recent` after a `save_thumb()` call. iter-187.
        Caller is responsible for the time.time() bookkeeping; this
        keeps the metrics module pure-Python with no I/O of its own.
        """
        self.thumb_ms_recent = ms

    def infer_ms_p95(self):
        """95th-percentile inference latency over the ring buffer, in
        ms. Returns 0.0 until at least `INFER_HISTORY_WARMUP` samples
        have arrived — fewer than that and a single cold-cache TRT
        first-call (~8 s) dominates the result and shows up as
        misleading huge p95 in the UI for the first few heartbeats
        after a worker restart. We round to one decimal to match the
        precision in `infer_ms_recent`. Uses the nearest-rank method
        (no interpolation) — fine at this buffer size and faster than
        numpy/statistics."""
        if len(self._infer_history) < self.INFER_HISTORY_WARMUP:
            return 0.0
        sorted_vals = sorted(self._infer_history)
        # Nearest-rank: int(0.95 * N), clamped to the array bounds.
        idx = int(0.95 * len(sorted_vals))
        idx = min(idx, len(sorted_vals) - 1)
        return round(sorted_vals[idx], 1)

    def snapshot(self):
        return {
            "fps": round(self.fps(), 2),
            "infer_per_s": round(self.infer_per_s(), 2),
            "gear": self.gear,
            "frames": self.frames,
            "inferences": self.inferences,
            "emitted": self.emitted,
            "dropped": self.dropped,
            "infer_ms_recent": round(self.infer_ms_recent, 1),
            "infer_ms_p95": self.infer_ms_p95(),
            "mediamtx_restarts": self.mediamtx_restarts,
            "argus_restarts": self.argus_restarts,
            "last_frame_ts": round(self.last_frame_ts, 1),
            "thumb_ms_recent": round(self.thumb_ms_recent, 1),
            "uptime_s": round(self.uptime_s(), 1),
            "face_recog_names": list(self.face_recog_names),
            "clips_dropped_capacity": self.clips_dropped_capacity,
            "clip_start_failures": self.clip_start_failures,
            "face_recog_failures": self.face_recog_failures,
            "event_post_failures": self.event_post_failures,
            "thumb_save_failures": self.thumb_save_failures,
            "visits_finalized": self.visits_finalized,
            "clips_dropped_disk_floor": self.clips_dropped_disk_floor,
        }
