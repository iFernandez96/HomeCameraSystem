"""Pre-event video buffer (iter-323, Feature #1 slice 2c).

The iter-202 ClipRecorder captures POST-roll only — by the time a
person triggers detection, they're already mid-stride and the
clip starts a frame too late. Real doorbell systems (Ring, Nest
Wired, Frigate) keep a continuous N-second rolling buffer so the
saved clip can include the moments BEFORE the trigger.

Strategy: long-running ffmpeg subprocess writes the live RTSP
stream to a directory of small segments using the segment muxer:

    ffmpeg -i <rtsp> -c copy -f segment \
        -segment_time <SEG_S> -segment_wrap <CAPACITY> \
        -reset_timestamps 1 \
        <buffer_dir>/seg_%03d.mp4

`-segment_wrap N` makes ffmpeg cycle through N file slots, so disk
use is bounded. `-c copy` means no re-encode (NVENC stays untouched
on the Nano). `-reset_timestamps 1` produces self-contained MP4
files that concat cleanly via the demuxer.

On a detection event, the caller asks for segments overlapping the
window `[now - pre_roll_s, now]`, then concats those + the post-roll
output via the iter-202 ClipRecorder's existing path.

This module CANNOT be functionally tested on the dev machine — the
ffmpeg subprocess against a real RTSP stream needs the Jetson camera
pipeline live. Unit tests cover argument construction, segment
selection by mtime, lifecycle (start/stop), failure handling.

Must stay Python 3.6 compatible — JetPack 4.x ships 3.6 on the
host where detect.py imports this module. Don't add `from __future__
import annotations`, PEP-604 unions, walrus, or match.
"""
import os
import subprocess
import threading
import time


# Per-segment duration. 1 s is small enough to give precise pre-roll
# windows (1 s rounding error on a typical 5 s pre-roll = 20 % off, which
# is acceptable for the doorbell intercept use-case). 30 fps × 1 s × ~30
# kbit/frame at 720p H.264 ≈ 90 KB per segment.
DEFAULT_SEGMENT_S = 1
# Capacity = how many segments ffmpeg cycles through. iter-356.51
# bumped 15 → 60 (~60 s of history) to give the merge thread headroom
# above any reasonable post-roll setting. The earlier 15 was a race-
# floor: when `clip_post_roll_s` exceeded 15 s, the merge thread's
# wait outlasted the ring's wrap window — by the time `run_concat`
# read the segment paths, the ring had rewritten those slots with
# post-event content (recording.py's iter-356.51 scratch-copy is the
# primary defense; this bump is belt-and-suspenders for the live ring
# so the copy doesn't race the wrap on long post-roll captures).
# At ~90 KB per segment that's ~5.4 MB on disk — still negligible vs
# the 64 GB SD card.
DEFAULT_CAPACITY = 60


class PrerollBuffer(object):
    """Manages a continuous segment-recording ffmpeg subprocess that
    writes the most-recent N seconds of camera footage to a small
    rotating set of MP4 files.

    Lifecycle:
        - `start()` spawns the ffmpeg subprocess.
        - `is_alive()` polls; caller's monitor thread restarts on death.
        - `segments_in_window(now, pre_roll_s)` returns the segment
          file paths whose mtime overlaps the pre-roll window.
        - `stop()` SIGKILLs the subprocess.

    Threading:
        Single producer (ffmpeg writes segment files), single consumer
        (caller reads file paths on detection). No shared state mutation
        beyond `self._proc`, which is guarded by `_lock` for restart
        safety. CPython GIL covers list reads.
    """

    def __init__(self,
                 rtsp_url,
                 buffer_dir,
                 segment_s=DEFAULT_SEGMENT_S,
                 capacity=DEFAULT_CAPACITY,
                 ffmpeg_bin="ffmpeg"):
        self.rtsp_url = rtsp_url
        self.buffer_dir = buffer_dir
        self.segment_s = segment_s
        self.capacity = capacity
        self.ffmpeg_bin = ffmpeg_bin
        self._proc = None
        self._lock = threading.Lock()

    def _build_args(self):
        """ffmpeg argv. `-segment_wrap` cycles through capacity slots;
        `-reset_timestamps 1` makes each slot a self-contained MP4
        that the concat demuxer accepts without re-encoding.
        `-rtsp_transport tcp` mirrors the iter-202 ClipRecorder's
        choice (more robust on flaky LAN than the default UDP)."""
        out_pattern = os.path.join(
            self.buffer_dir,
            "seg_%03d.mp4",
        )
        return [
            self.ffmpeg_bin,
            "-y",
            "-loglevel", "warning",
            "-rtsp_transport", "tcp",
            "-i", self.rtsp_url,
            "-c", "copy",
            "-f", "segment",
            "-segment_time", str(self.segment_s),
            "-segment_wrap", str(self.capacity),
            "-segment_format", "mp4",
            "-reset_timestamps", "1",
            out_pattern,
        ]

    def start(self):
        """Spawn the segment-recorder subprocess. Returns True if
        already running OR newly started; False if the spawn failed
        (e.g. ffmpeg binary missing).

        Idempotent: calling start() on an already-running buffer is
        a no-op + returns True.
        """
        with self._lock:
            if self._proc is not None and self._proc.poll() is None:
                return True
            try:
                os.makedirs(self.buffer_dir, exist_ok=True)
            except OSError:
                return False
            try:
                self._proc = subprocess.Popen(
                    self._build_args(),
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.DEVNULL,
                    # Same iter-263 reasoning as ClipRecorder: PIPE
                    # risks pipe-buffer-fill hang on sustained ffmpeg
                    # warnings (RTSP keyframe-not-found loops). Drop
                    # stderr; the watchdog detects death via poll().
                    stderr=subprocess.DEVNULL,
                )
            except (OSError, FileNotFoundError):
                self._proc = None
                return False
            return True

    def is_alive(self):
        """Subprocess running."""
        with self._lock:
            return self._proc is not None and self._proc.poll() is None

    def start_watchdog(self, interval_s=10.0):
        """iter-325: spawn a daemon thread that polls `is_alive()`
        every `interval_s` seconds and re-spawns the subprocess
        when it has died. Closes the iter-324 follow-up: the pre-
        roll ffmpeg silently exits when its RTSP connection drops
        (e.g. MediaMTX restart from the iter-26 watchdog), and
        without a restarter the buffer stays empty until the
        worker process itself restarts.

        Idempotent — calling twice is a no-op (the thread loop
        polls `_watchdog_running` which only flips false on
        `stop()`).

        Returns the thread object (handy for tests). Logs nothing —
        the module stays log-free per the iter-202 design choice.
        """
        # Re-entrancy guard. _watchdog_started is the cheap flag.
        if getattr(self, "_watchdog_started", False):
            return None
        self._watchdog_started = True
        self._watchdog_running = True

        def _loop():
            while self._watchdog_running:
                if not self.is_alive():
                    # Subprocess died — try to spawn a fresh one.
                    # Failures (ffmpeg missing, RTSP still down) just
                    # leave the next tick to retry.
                    try:
                        self.start()
                    except Exception:
                        pass
                # Sleep in small chunks so stop() can wake us within
                # ~1 second instead of waiting the full interval.
                slept = 0.0
                while self._watchdog_running and slept < interval_s:
                    time.sleep(min(1.0, interval_s - slept))
                    slept += 1.0

        t = threading.Thread(target=_loop, daemon=True)
        t.start()
        return t

    def stop(self):
        """SIGTERM the subprocess + wait briefly. Returns True if the
        process exited cleanly within the grace window. Idempotent."""
        # iter-325: also signal the watchdog thread to stop.
        self._watchdog_running = False
        with self._lock:
            p = self._proc
            self._proc = None
        if p is None:
            return True
        if p.poll() is not None:
            return True
        try:
            p.terminate()
            p.wait(timeout=2.0)
            return True
        except subprocess.TimeoutExpired:
            try:
                p.kill()
                p.wait(timeout=1.0)
            except Exception:
                pass
            return False
        except Exception:
            return False

    def segments_in_window(self, now, pre_roll_s):
        """Return a chronologically-sorted list of segment paths whose
        mtime falls within [now - pre_roll_s, now]. Returns [] if
        the buffer dir is missing or no segments have been written
        yet (cold start race window).

        We use mtime as the segment-completion timestamp. ffmpeg
        writes each segment in order, then renames atomically (on
        Linux); the file's mtime ≈ the segment's end-of-window time.
        We over-include by one segment to cover the boundary jitter
        (segment N+1 may have just opened when the event fires).
        """
        try:
            entries = os.listdir(self.buffer_dir)
        except OSError:
            return []
        candidates = []
        cutoff = now - pre_roll_s
        for name in entries:
            if not (name.startswith("seg_") and name.endswith(".mp4")):
                continue
            path = os.path.join(self.buffer_dir, name)
            try:
                m = os.path.getmtime(path)
            except OSError:
                continue
            # Include segments whose mtime is within the window.
            # Over-include by one segment_s on the leading edge so
            # the boundary segment isn't missed. Drop anything more
            # than `segment_s` seconds in the future (file clock skew
            # / NTP step) — those aren't real history.
            if m >= cutoff - self.segment_s and m <= now + self.segment_s:
                candidates.append((m, path))
        # Sort chronologically by mtime.
        candidates.sort(key=lambda t: t[0])
        return [path for _m, path in candidates]


def write_concat_list(list_path, segment_paths):
    """Write the ffmpeg concat-demuxer input file. Mirrors the
    services/timelapse._write_concat_list helper's escape rules. Used
    by the caller after segments_in_window returns the pre-roll set,
    plus the post-roll capture from ClipRecorder."""
    with open(list_path, "w") as f:
        for p in segment_paths:
            escaped = os.path.abspath(p).replace("'", "'" + chr(92) + "''")
            f.write("file '" + escaped + "'\n")


def run_concat(ffmpeg_bin, list_path, output_path, timeout_s=30.0):
    """Run `ffmpeg -f concat -safe 0 -i <list> -c copy <output>`.
    Returns True on success, False otherwise. Synchronous — the
    pre-roll concat is tiny (<1 s for ~10 segments at -c copy).
    `-safe 0` allows absolute paths; `+faststart` for inline play.
    """
    # iter-356.43: explicit output `-f mp4`. The concat output is the
    # `<final>.tmp` path used by `recording.py`'s atomic-rename merge;
    # ffmpeg cannot infer the muxer from a `.tmp` extension and would
    # exit RC=1 with "Unable to find a suitable output format". The
    # input `-f concat` (above) describes the demuxer; the second
    # `-f mp4` (below, immediately before output_path) forces the
    # muxer.
    cmd = [
        ffmpeg_bin,
        "-y",
        "-hide_banner",
        "-loglevel", "error",
        "-f", "concat",
        "-safe", "0",
        "-i", list_path,
        "-c", "copy",
        "-movflags", "+faststart",
        "-f", "mp4",
        output_path,
    ]
    try:
        # iter-350 (camera-library-usage D1 from iter-333 broad audit):
        # stdout/stderr were both PIPE; subprocess.run reads them only
        # AFTER wait() but wait() blocks on the child, and the child
        # blocks on the pipe once the OS pipe (~64 KB) fills. A large
        # ffmpeg error message (missing segment, malformed MP4) could
        # deadlock the synchronous concat indefinitely. DEVNULL on
        # both eliminates the trap; loglevel=error already suppresses
        # most non-error chatter so we lose nothing actionable.
        result = subprocess.run(
            cmd,
            timeout=timeout_s,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except (OSError, subprocess.TimeoutExpired):
        return False
    return result.returncode == 0


# Smoke test for `time` import — keeps the linter happy when no
# call site yet uses the module's `time` re-export. The detect.py
# wiring iter will call `preroll.start()` at boot + use os.path
# helpers for the pre-roll concat.
_ = time
