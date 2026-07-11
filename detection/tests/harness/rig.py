"""Standalone replay rig for the continuous-capture visit pipeline.

Dev-only test infrastructure (detection/tests/harness/ — exempt from the
py36 AST guard, which excludes tests/). Drives the REAL shipped modules —
``visit_runtime.VisitRunner`` (which drives the real ``visit.VisitTracker``),
``preroll.PrerollBuffer.segments_in_range`` / ``copy_new_segments``, and
``recording.ClipRecorder.finalize_visit`` with REAL ffmpeg — against REAL
ring segments captured from the production Jetson. Never reimplementations.

The only simulated piece is the thing a dev box cannot have: the live camera.
``RingSim`` stands in for the segment-recorder ffmpeg subprocess by copying
REAL captured H.264 segment files into the ring directory and re-mtiming
them onto the replay clock (mtime == end-of-segment time, exactly the model
``preroll`` uses), overwriting slot names modulo capacity exactly like
``-segment_wrap`` does. All selection/copy/concat/validate logic downstream
of those files is the real production code.
"""
import os
import shutil
import subprocess
from pathlib import Path

import sys

_DETECTION_DIR = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(_DETECTION_DIR))

import preroll  # noqa: E402
import recording  # noqa: E402
import visit_runtime  # noqa: E402

REPO_ROOT = _DETECTION_DIR.parent
FIXTURES_DIR = REPO_ROOT / ".jetson-snapshot" / "continuous_capture_fixtures"
SEGMENTS_DIR = FIXTURES_DIR / "segments"
JOURNAL_PATH = FIXTURES_DIR / "journal_tonight.log"
EVENTS_PATH = FIXTURES_DIR / "events_tonight.json"

DEFAULT_KEY = "person:front_door"
DEFAULT_BOX = (100.0, 100.0, 220.0, 320.0)
DEFAULT_BOXES = [
    {"label": "person", "x": 0.37, "y": 0.37, "w": 0.2, "h": 0.58,
     "score": 0.95},
]


def fixtures_available():
    return (
        SEGMENTS_DIR.is_dir()
        and JOURNAL_PATH.is_file()
        and EVENTS_PATH.is_file()
        and any(SEGMENTS_DIR.glob("seg_*.mp4"))
    )


def ffmpeg_available():
    return bool(shutil.which("ffmpeg") and shutil.which("ffprobe"))


# --------------------------------------------------------------------------
# real-segment library
# --------------------------------------------------------------------------

_DURATION_CACHE = {}


def probe_duration(path):
    """Real ffprobe format duration of ``path`` (cached per session).
    Returns None when ffprobe can't parse the file (e.g. the moov-less
    in-flight slot the production snapshot inevitably contains)."""
    path = str(path)
    if path in _DURATION_CACHE:
        return _DURATION_CACHE[path]
    out = subprocess.run(
        [
            "ffprobe", "-v", "error",
            "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1",
            path,
        ],
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=15.0,
    )
    try:
        value = float(out.stdout.decode("utf-8", "replace").strip())
    except ValueError:
        value = None
    if out.returncode != 0:
        value = None
    _DURATION_CACHE[path] = value
    return value


_LIBRARY = None


def segment_library():
    """The real captured ring segments as ``[(path, duration_s), ...]`` in
    original capture order, probed once per session. These are genuine
    Jetson NVENC ``-c copy -f segment -reset_timestamps 1`` slots (~1.05s,
    ~290 KB each)."""
    global _LIBRARY
    if _LIBRARY is None:
        paths = sorted(
            SEGMENTS_DIR.glob("seg_*.mp4"), key=lambda p: p.stat().st_mtime,
        )
        lib = []
        for p in paths:
            dur = probe_duration(p)
            # The production snapshot inevitably contains the in-flight
            # slot whose moov isn't written yet — skip it as a RING SOURCE
            # (production's _filter_valid_segments drops it downstream
            # anyway; here we need every simulated slot to carry footage).
            if dur is not None and dur > 0:
                lib.append((str(p), dur))
        _LIBRARY = lib
    return _LIBRARY


class RingSim(object):
    """Stand-in for the segment-recorder ffmpeg: writes REAL segment bytes
    into ring slot files (``seg_%03d.mp4`` modulo ``capacity``, like
    ``-segment_wrap``) with mtimes tiled onto the replay clock. Each written
    segment's mtime is its end-of-window time; consecutive segments tile at
    each file's REAL probed duration so wall-clock coverage equals actual
    footage duration (the property finalize's window/duration check needs).
    """

    def __init__(self, ring_dir, library, capacity, start_ts):
        self.ring_dir = str(ring_dir)
        os.makedirs(self.ring_dir, exist_ok=True)
        self.library = library
        self.capacity = capacity
        # cursor == end time of the last written segment.
        self.cursor = float(start_ts)
        self._slot = 0
        self._lib_i = 0
        self.total_written = 0

    def advance_to(self, t):
        """Write every segment whose window completes at or before ``t``.
        Monotonic; a no-op for t <= cursor."""
        while True:
            src, dur = self.library[self._lib_i % len(self.library)]
            end = self.cursor + dur
            if end > t:
                break
            name = "seg_%03d.mp4" % (self._slot % self.capacity)
            dst = os.path.join(self.ring_dir, name)
            shutil.copyfile(src, dst)
            os.utime(dst, (end, end))
            self.cursor = end
            self._slot += 1
            self._lib_i += 1
            self.total_written += 1


# --------------------------------------------------------------------------
# replay rig
# --------------------------------------------------------------------------

class ReplayRig(object):
    """Real ``VisitRunner`` wired to the real preroll copy API and the real
    ffmpeg finalize, over a ``RingSim``-backed ring of real segments.

    Side-effect callables mirror ``detect._build_visit_runner``'s adapters
    but capture their traffic for assertions:
      * ``posts``      — open-event POST payload captures
                         (visit_id, key, start_ts, boxes, segment_index)
      * ``copies``     — (visit_id, start_ts, until_ts, n_newly_copied)
      * ``finalizes``  — dicts with visit_id/start_ts/end_ts/ok/path

    Finalize runs SYNCHRONOUSLY (injected spawn) so replay assertions are
    deterministic; the finalize itself is the real ``recording.finalize_visit``
    with real ffmpeg. Free space is injected huge so the disk floor never
    gates a replay (the floor has its own offline tests).
    """

    def __init__(self, root, start_ts, ring_capacity=200, lead_s=5.0):
        self.recordings_dir = os.path.join(str(root), "rec")
        os.makedirs(self.recordings_dir, exist_ok=True)
        ring_dir = os.path.join(self.recordings_dir, "_preroll")
        self.buffer = preroll.PrerollBuffer(
            rtsp_url="rtsp://unused-in-replay",
            buffer_dir=ring_dir,
            segment_s=1,
            capacity=ring_capacity,
        )
        self.ring = RingSim(
            ring_dir, segment_library(), capacity=ring_capacity,
            start_ts=float(start_ts) - lead_s,
        )
        self.recorder = recording.ClipRecorder(
            rtsp_url="rtsp://unused-in-replay",
            recordings_dir=self.recordings_dir,
        )
        self.posts = []
        self.copies = []
        self.finalizes = []

        def _post_event(visit_id, key, start_ts, boxes, segment_index=0,
                        root_visit_id=None, **_kwargs):
            self.posts.append({
                "visit_id": visit_id,
                "root_visit_id": root_visit_id,
                "key": key,
                "start_ts": start_ts,
                "boxes": boxes,
                "segment_index": segment_index,
            })

        def _copy_segments(visit_id, start_ts, until_ts, scratch, already):
            newly, acc = self.buffer.copy_new_segments(
                start_ts, until_ts, scratch, already_copied=already,
            )
            self.copies.append((visit_id, start_ts, until_ts, len(newly)))
            return newly, acc

        def _finalize(visit_id, scratch, start_ts, end_ts):
            ok = self.recorder.finalize_visit(
                visit_id, scratch, start_ts, end_ts,
                recordings_dir=self.recordings_dir,
            )
            self.finalizes.append({
                "visit_id": visit_id,
                "start_ts": start_ts,
                "end_ts": end_ts,
                "ok": ok,
                "path": os.path.join(
                    self.recordings_dir, "{}.mp4".format(visit_id),
                ),
            })
            return ok

        self.runner = visit_runtime.VisitRunner(
            recordings_dir=self.recordings_dir,
            post_event=_post_event,
            copy_segments=_copy_segments,
            finalize_visit=_finalize,
            spawn=lambda target, _vid: target(),
            free_space=lambda _p: 10 ** 12,
        )

    # -- drivers -----------------------------------------------------------

    def step_tick(self, t, absence_s, max_visit_s):
        self.ring.advance_to(t)
        self.runner.tick(t, absence_s, max_visit_s)

    def step_observe(self, t, absence_s, max_visit_s, key=DEFAULT_KEY,
                     box=DEFAULT_BOX, boxes=None, pre_roll_s=0.0):
        self.ring.advance_to(t)
        self.runner.tick(t, absence_s, max_visit_s)
        self.runner.observe(
            key, box, t, pre_roll_s, absence_s, max_visit_s,
            boxes=(boxes if boxes is not None else DEFAULT_BOXES),
        )

    def fresh_visit_posts(self):
        return [p for p in self.posts if p["segment_index"] == 0]


def run_timeline(rig, instants, t_start, t_end, absence_s, max_visit_s,
                 key=DEFAULT_KEY, box=DEFAULT_BOX, pre_roll_s=0.0, step=1.0):
    """Replay a presence timeline through the rig: absent-frame ticks on a
    fixed grid (like the detect loop's per-frame tick, plan B5) plus an
    observe at every presence instant, all in monotonic time order. Runs the
    grid ``absence_s + 5`` past ``t_end`` so the final visit's grace deadline
    fires and finalizes."""
    events = [t for t in instants if t_start <= t <= t_end]
    drain_end = t_end + absence_s + 5.0
    grid = []
    g = float(t_start)
    while g <= drain_end:
        grid.append(g)
        g += step
    points = [(t, False) for t in grid] + [(t, True) for t in events]
    # Sort by time; at equal times run the plain tick first, then observe
    # (mirrors the loop: tick at loop top, observe below).
    points.sort(key=lambda p: (p[0], p[1]))
    for t, is_observe in points:
        if is_observe:
            rig.step_observe(t, absence_s, max_visit_s, key=key, box=box,
                             pre_roll_s=pre_roll_s)
        else:
            rig.step_tick(t, absence_s, max_visit_s)


# --------------------------------------------------------------------------
# real-decode helpers (mirror recording.py's B1 validate)
# --------------------------------------------------------------------------

def decode_null(path, timeout=180.0):
    """Run the plan-B1 real decode pass (``ffmpeg -v error -i <p> -f null -``)
    and return ``(returncode, stderr_text_lower)``."""
    result = subprocess.run(
        ["ffmpeg", "-nostdin", "-hide_banner", "-v", "error",
         "-i", str(path), "-f", "null", "-"],
        stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=timeout,
    )
    return result.returncode, result.stderr.decode("utf-8", "replace").lower()


def decode_is_clean(path):
    """True iff a real decode pass shows none of the FATAL corruption markers
    that ``recording.finalize_visit`` greps for (imported from the shipped
    module so this stays in lock-step). The documented plan-B1 exception —
    "non monotonic dts to muxer" at NVENC GOP joins — is deliberately
    allowed, mirroring ``recording._FINALIZE_DECODE_BAD_MARKERS``."""
    rc, text = decode_null(path)
    if rc != 0:
        return False
    for marker in recording._FINALIZE_DECODE_BAD_MARKERS:
        if marker in text:
            return False
    return True
