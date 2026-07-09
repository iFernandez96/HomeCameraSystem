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

import applog


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
            except OSError as e:
                # docs/logging_plan.md §2: buffer_dir makedirs failed
                # (volume unmounted / full / RO). The pre-roll buffer
                # stays empty → every clip loses its pre-roll. ERROR
                # naming the dir + reason.
                applog.emit(
                    "preroll",
                    "ERROR makedirs failed for buffer_dir={!r}: {}: {} — "
                    "pre-roll buffer cannot start".format(
                        self.buffer_dir, type(e).__name__, e,
                    ),
                )
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
            except (OSError, FileNotFoundError) as e:
                # docs/logging_plan.md §2: segment-recorder spawn failed —
                # ffmpeg missing / unexecutable. The caller (detect.py)
                # only said "failed to start" with no reason; name the
                # ffmpeg binary so the operator knows what's missing.
                applog.emit(
                    "preroll",
                    "ERROR ffmpeg spawn failed (bin={!r}): {}: {} — "
                    "pre-roll buffer not running".format(
                        self.ffmpeg_bin, type(e).__name__, e,
                    ),
                )
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
        # docs/logging_plan.md §2: track consecutive restarts so a
        # FLAPPING buffer (RTSP / MediaMTX down — death every tick) is
        # distinguishable from a one-off restart. Reset to 0 on the
        # first tick that finds the process alive.
        self._watchdog_consecutive_restarts = 0

        def _loop():
            while self._watchdog_running:
                if not self.is_alive():
                    # Subprocess died — try to spawn a fresh one.
                    # Failures (ffmpeg missing, RTSP still down) just
                    # leave the next tick to retry.
                    self._watchdog_consecutive_restarts += 1
                    started = False
                    try:
                        started = self.start()
                    except Exception as e:
                        applog.emit(
                            "preroll",
                            "watchdog restart raised ({}: {}) "
                            "[consecutive={}]".format(
                                type(e).__name__, e,
                                self._watchdog_consecutive_restarts,
                            ),
                        )
                    else:
                        applog.emit(
                            "preroll",
                            "watchdog restarting dead segment-recorder "
                            "(start ok={}) [consecutive={}] — flapping "
                            "implies RTSP/MediaMTX down".format(
                                started,
                                self._watchdog_consecutive_restarts,
                            ),
                        )
                else:
                    # Healthy tick — reset the flap counter.
                    self._watchdog_consecutive_restarts = 0
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
            # docs/logging_plan.md §2: SIGTERM didn't land within the
            # grace window — escalate to SIGKILL. WARN so a recurring
            # zombie holding the RTSP source (blocking the next start())
            # is visible.
            applog.emit(
                "preroll",
                "segment-recorder ignored SIGTERM within 2s — escalating "
                "to SIGKILL (zombie may hold RTSP source)",
            )
            try:
                p.kill()
                p.wait(timeout=1.0)
            except Exception as e:
                applog.emit(
                    "preroll",
                    "SIGKILL escalation failed: {}: {}".format(
                        type(e).__name__, e,
                    ),
                )
            return False
        except Exception as e:
            applog.emit(
                "preroll",
                "stop() failed terminating segment-recorder: {}: {}".format(
                    type(e).__name__, e,
                ),
            )
            return False

    # iter-356.61: dynamic ring sizing. Pre-iter-356.61 the ring
    # capacity was fixed at boot (DEFAULT_CAPACITY × DEFAULT_SEGMENT_S
    # = 60 s of history). The Settings "Pre-roll" slider could ask
    # for up to 300 s on the "week" preset — anything past 60 s
    # silently fell back to whatever the ring happened to hold.
    # Now: the worker re-checks the slider against the live ring
    # window and grows the ring (kill + update capacity + restart)
    # when the slider exceeds it. Never shrinks — that would lose
    # history mid-capture.

    def window_seconds(self):
        """Current ring window size in seconds (capacity × segment_s)."""
        return float(self.segment_s) * float(self.capacity)

    def required_capacity_for(self, pre_roll_s, slack_segments=5):
        """Capacity (slot count) needed to cover `pre_roll_s` of history
        plus `slack_segments` of safety. The slack covers (a) the
        actively-being-written slot which the iter-356.60b validator
        will drop, and (b) clock-skew between segment mtime and the
        wall clock. Floor of 1 segment so we never ask for 0.
        """
        try:
            seconds = float(pre_roll_s)
        except (TypeError, ValueError):
            return self.capacity
        if seconds <= 0:
            return self.capacity
        # Round up: ceil(seconds / segment_s) + slack.
        n = int(seconds / float(self.segment_s))
        if n * float(self.segment_s) < seconds:
            n += 1
        return max(1, n + int(slack_segments))

    def ensure_capacity_for(self, pre_roll_s, slack_segments=5):
        """If the live ring is too small to cover `pre_roll_s`, grow it
        by killing + restarting the segment-recorder with a larger
        `-segment_wrap`. Returns True when a resize happened, False
        when no-op (already large enough or pre_roll_s is invalid).

        Never shrinks. Once the user has bumped the slider higher,
        the ring stays at that size until the worker restarts —
        shrinking would discard history segments and could break
        an in-flight pre-roll snapshot.

        During the kill + restart window (~1-2 s) no new segments
        are written. Existing slot files on disk are NOT removed;
        the new ffmpeg instance overwrites them as the ring rotates
        through. A clip starting during the resize window will see
        the existing segments via `segments_in_window()` (mtime
        filter is independent of which ffmpeg wrote the slot).
        """
        needed = self.required_capacity_for(pre_roll_s, slack_segments)
        if needed <= self.capacity:
            return False
        with self._lock:
            self.capacity = needed
            if self._proc is not None and self._proc.poll() is None:
                try:
                    self._proc.kill()
                    self._proc.wait(timeout=2.0)
                except Exception:
                    pass
                self._proc = None
        # Restart out-of-lock so start() can re-acquire it cleanly.
        applog.emit(
            "preroll",
            "resized ring to capacity={} ({}s window) for slider "
            "pre_roll={:.1f}s".format(
                needed, needed * float(self.segment_s), float(pre_roll_s),
            ),
        )
        # docs/logging_plan.md §2: the restart return value was ignored —
        # if start() fails here the buffer is DOWN at the larger size
        # (no segments written until the watchdog or next resize fixes
        # it). WARN naming the new capacity so the gap is observable.
        ok = self.start()
        if not ok:
            applog.emit(
                "preroll",
                "ring resize restart FAILED — buffer DOWN at "
                "capacity={} (no segments until next start)".format(needed),
            )
        return True

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
        except OSError as e:
            # docs/logging_plan.md §2 + §4: buffer dir unreadable
            # (unmounted / perms). Pre-logging this returned [] silently —
            # the clip then has NO pre-roll with no trace. WARN, but
            # once-flagged (re-armed on the next success below) so a
            # persistent failure doesn't flood the journal per call.
            if not getattr(self, "_segwin_listdir_warned", False):
                applog.emit(
                    "preroll",
                    "segments_in_window listdir failed for "
                    "buffer_dir={!r}: {}: {} — pre-roll unavailable "
                    "(buffer dir unmounted?)".format(
                        self.buffer_dir, type(e).__name__, e,
                    ),
                )
                self._segwin_listdir_warned = True
            return []
        # Re-arm the once-flag so a transient failure logs again next time.
        self._segwin_listdir_warned = False
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

    # ---- iter continuous-capture / S2: ring-range API + incremental copy ----
    #
    # The pre-roll `segments_in_window(now, pre_roll_s)` selects a window
    # ENDING at `now`. The continuous-capture finalize layer (S3) instead
    # needs a CLOSED BAND `[start_ts, end_ts]` (the wall-clock window of a
    # whole visit), selected by OVERLAP — segments are GOP-floored to
    # ~4.3s (plan R1), NOT 1s, so equality/granularity assumptions would
    # drop boundary segments. A segment is modelled as covering the window
    # `[mtime - segment_s, mtime]` (mtime ≈ end-of-segment, ffmpeg writes
    # in order then renames). The band [start_ts, end_ts] is CLOSED at
    # both ends; a segment is included iff its window intersects it.

    def segments_in_range(self, start_ts, end_ts):
        """Return segment paths whose recorded time-window OVERLAPS the
        closed band [start_ts, end_ts], in CHRONOLOGICAL (play) order.

        Each segment is treated as covering ``[mtime - segment_s, mtime]``
        (mtime ≈ end-of-segment-window). Overlap with the closed band
        ``[start_ts, end_ts]`` is:

            seg_start <= end_ts  AND  seg_end >= start_ts

        i.e. the boundary segment straddling ``start_ts`` (its window
        reaches past start_ts) and the one straddling ``end_ts`` (its
        window starts before end_ts) are BOTH included — selection is by
        overlap, not exact equality, because the recorded GOP is ~4.3s
        (plan R1), not 1s. Returns ``[]`` if the buffer dir is missing /
        unreadable or no segments have been written yet.

        Like ``segments_in_window`` we tolerate a little clock skew: the
        ``- segment_s`` on the leading edge of each segment's window is the
        skew margin; we don't additionally pad the band itself.
        """
        if end_ts < start_ts:
            # Degenerate band — caller confusion. Don't guess; empty.
            return []
        try:
            entries = os.listdir(self.buffer_dir)
        except OSError as e:
            # docs/logging_plan.md §2: same failure mode as
            # segments_in_window — buffer dir unmounted / perms. Without
            # a log the finalized visit clip would silently lose footage.
            # Once-flagged so a persistent failure doesn't flood.
            if not getattr(self, "_segrange_listdir_warned", False):
                applog.emit(
                    "preroll",
                    "segments_in_range listdir failed for "
                    "buffer_dir={!r}: {}: {} — visit footage unavailable "
                    "(buffer dir unmounted?)".format(
                        self.buffer_dir, type(e).__name__, e,
                    ),
                )
                self._segrange_listdir_warned = True
            return []
        # Re-arm so a transient failure logs again next time.
        self._segrange_listdir_warned = False
        candidates = []
        for name in entries:
            if not (name.startswith("seg_") and name.endswith(".mp4")):
                continue
            path = os.path.join(self.buffer_dir, name)
            try:
                m = os.path.getmtime(path)
            except OSError:
                continue
            # Segment window is [seg_start, seg_end]; mtime ≈ seg_end.
            seg_end = m
            seg_start = m - self.segment_s
            # Closed-band overlap test.
            if seg_start <= end_ts and seg_end >= start_ts:
                candidates.append((m, path))
        candidates.sort(key=lambda t: t[0])
        return [path for _m, path in candidates]

    def _ring_newest_mtime(self):
        """Newest mtime across ALL ring slots, or None on an empty /
        unreadable ring. The slot carrying this mtime is the only one
        ffmpeg could still be writing (slots close strictly in
        sequence), so `copy_new_segments` withholds it until a newer
        slot proves it closed."""
        try:
            entries = os.listdir(self.buffer_dir)
        except OSError:
            return None
        newest = None
        for name in entries:
            if not (name.startswith("seg_") and name.endswith(".mp4")):
                continue
            try:
                m = os.path.getmtime(os.path.join(self.buffer_dir, name))
            except OSError:
                continue
            if newest is None or m > newest:
                newest = m
        return newest

    def copy_new_segments(self, start_ts, until_ts, scratch_dir,
                          already_copied=None):
        """Incremental copy-on-extend (plan B3 / iter-356.51 defense).

        Select ring segments overlapping the closed band
        ``[start_ts, until_ts]`` via ``segments_in_range`` and ``copy2``
        each one whose ``(basename, mtime)`` identity is NOT already in
        ``already_copied`` into ``scratch_dir`` (created if missing).
        Idempotent — an identity already copied is skipped, so repeated
        ticks never re-copy an unchanged slot.

        Meant to run on EVERY extend tick so a completed ring segment is
        copied into per-visit scratch BEFORE the ring's ``-segment_wrap``
        can rewrite that slot. Once copied, ring rotation is harmless to
        the visit's footage (mirrors recording.py:454-466's copy-before-
        wait race fix, but driven incrementally as the visit grows).

        Pure file ops — NO ffmpeg here (concat/validate is S3's job).

        Args:
            start_ts, until_ts: closed wall-clock band so far.
            scratch_dir: per-visit dir to copy completed segments into.
            already_copied: opaque accumulator from a prior call (a set of
                ``(basename, mtime)`` identities) or a list of the same.
                ``None`` => start fresh.

        Returns a 2-tuple ``(newly_copied_dest_paths, already_copied)``:
            - ``newly_copied_dest_paths``: list of dest paths copied THIS
              call, in chronological (play) order.
            - ``already_copied``: the SAME set passed in (mutated in place)
              — or a fresh set when ``None``/a list was passed — now
              holding every ``(basename, mtime)`` copied so far.

        Why ``(basename, mtime)`` and not just the basename: the ring reuses
        slot NAMES (``seg_NNN.mp4``) after a ``-segment_wrap``, so a slot
        freshly OVERWRITTEN with new footage has the SAME name but a new
        mtime. Keying on the name alone would skip that new generation,
        silently dropping footage for any visit that outlasts the ring
        window (max_visit can exceed the wrap span). Keying on (name, mtime)
        copies the new generation instead. Dest files are named by a
        monotonic counter (``000000.mp4`` …) so successive generations
        never collide and sort chronologically — S3's finalize just orders
        the scratch dir by name.

        A slot that vanished mid-copy (the ring already wrapped + the
        finalize hasn't caught up) is logged + skipped — the caller
        tolerates a slightly short clip rather than crashing the worker.
        """
        # Normalise already_copied to a mutable set we own. We keep the
        # caller's object when it's a set (mutate in place, as documented);
        # for a list we copy into a set but ALSO return that set — the
        # caller rebinds to our return value either way.
        if already_copied is None:
            seen = set()
        elif isinstance(already_copied, set):
            seen = already_copied
        else:
            seen = set(already_copied)

        try:
            os.makedirs(scratch_dir, exist_ok=True)
        except OSError as e:
            # docs/logging_plan.md §2: per-visit scratch makedirs failed
            # (volume RO / full). Nothing copies → finalize gets no
            # footage. ERROR naming the dir + reason; return what we have
            # (nothing) so the caller degrades to a short/empty clip
            # rather than crashing.
            applog.emit(
                "preroll",
                "ERROR copy_new_segments makedirs failed for "
                "scratch_dir={!r}: {}: {} — visit footage will be "
                "incomplete".format(scratch_dir, type(e).__name__, e),
            )
            return [], seen

        import shutil

        # Torn-copy guard (2026-07-08, the "dropped N broken segment(s)"
        # WARN storm at every finalize): the slot ffmpeg is CURRENTLY
        # writing sits on disk as a 48-byte ftyp stub until the muxer
        # writes mdat+moov at close — so a copy of it is always torn,
        # and since its mtime then changes at close, the healed
        # generation was re-copied under a NEW identity one tick later.
        # No footage was lost, but every visit accumulated torn scratch
        # files that finalize had to ffprobe-reject. stat-based checks
        # can't catch this (the stub is byte-stable while open), so use
        # the one clock-free signal a sequential segment writer gives:
        # a slot is provably CLOSED once a strictly newer slot exists.
        # Withhold candidates carrying the ring-wide newest mtime; the
        # next tick copies them with their final identity. On the very
        # last (finalize) tick this forfeits at most one segment_s of
        # tail — absence-padding footage by definition.
        ring_newest = self._ring_newest_mtime()

        newly_copied = []
        for src in self.segments_in_range(start_ts, until_ts):
            try:
                mtime = os.path.getmtime(src)
            except OSError:
                # Vanished between listing and stat (ring wrapped it) —
                # skip; a later tick may find a fresh slot under this name.
                continue
            ident = (os.path.basename(src), mtime)
            if ident in seen:
                continue
            if ring_newest is not None and mtime >= ring_newest:
                # Possibly still being written — don't mark seen, so the
                # next tick picks it up once a newer slot supersedes it.
                continue
            # Unique, chronologically-sortable dest name. segments_in_range
            # yields chronological order and we only ever append, so the
            # monotonic counter (= len(seen)) names successive generations
            # in play order. A skipped (failed) copy doesn't grow seen, so
            # the next success reuses the index — no gaps, no collisions.
            dst = os.path.join(scratch_dir, "{:06d}.mp4".format(len(seen)))
            try:
                shutil.copy2(src, dst)
            except (OSError, IOError) as e:
                # The slot vanished / was rewritten mid-copy because the
                # ring already wrapped it (B3 race we lost on this slot),
                # or the dest is unwritable. Skip it — DON'T mark it seen
                # (a later tick may find a fresh, intact slot under the
                # same name + new mtime). The caller tolerates a short clip.
                applog.emit(
                    "preroll",
                    "copy_new_segments skipped {!r} -> {!r}: {}: {} — "
                    "ring likely wrapped the slot mid-copy".format(
                        src, dst, type(e).__name__, e,
                    ),
                )
                continue
            seen.add(ident)
            newly_copied.append(dst)
        return newly_copied, seen


def write_concat_list(list_path, segment_paths):
    """Write the ffmpeg concat-demuxer input file. Mirrors the
    services/timelapse._write_concat_list helper's escape rules. Used
    by the caller after segments_in_window returns the pre-roll set,
    plus the post-roll capture from ClipRecorder.

    docs/logging_plan.md §2: the open()/write() OSError (list_path's dir
    full / RO) had no guard and propagated up into recording.py's silent
    merge `finally` — the clip then vanished with no trace. Log the
    reason at ERROR before re-raising so the merge failure is
    attributable; the caller's try/finally still cleans up."""
    try:
        with open(list_path, "w") as f:
            for p in segment_paths:
                escaped = os.path.abspath(p).replace(
                    "'", "'" + chr(92) + "''"
                )
                f.write("file '" + escaped + "'\n")
    except (OSError, IOError) as e:
        applog.emit(
            "preroll",
            "ERROR write_concat_list failed for {!r}: {}: {} — clip "
            "merge will fail".format(list_path, type(e).__name__, e),
        )
        raise


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
        # docs/logging_plan.md §2 + §4: this is a SYNCHRONOUS
        # ``subprocess.run`` WITH a timeout, which means stderr=PIPE is
        # deadlock-SAFE here — run() spawns a reader and drains the pipe
        # itself, and the timeout bounds the call. (The iter-350 DEVNULL
        # was over-cautious: that deadlock pin applies to the ASYNC
        # long-lived recorder/post-roll subprocesses, NOT this bounded
        # run.) Capturing stderr lets us log WHY a concat failed (missing
        # segment, malformed MP4) instead of an opaque False.
        result = subprocess.run(
            cmd,
            timeout=timeout_s,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
        )
    except subprocess.TimeoutExpired:
        applog.emit(
            "preroll",
            "ERROR run_concat TIMED OUT after {}s ({} -> {}) — clip "
            "merge failed".format(timeout_s, list_path, output_path),
        )
        return False
    except OSError as e:
        applog.emit(
            "preroll",
            "ERROR run_concat spawn failed (bin={!r}): {}: {} — clip "
            "merge failed".format(ffmpeg_bin, type(e).__name__, e),
        )
        return False
    if result.returncode != 0:
        # Non-zero rc: log the stderr tail so the reason (missing input,
        # moov atom, etc.) is in the journal instead of a silent False.
        stderr = getattr(result, "stderr", None)
        tail = ""
        if stderr:
            try:
                tail = stderr.decode("utf-8", "replace").strip()
                tail = tail.replace("\n", " | ")[-1500:]
            except (AttributeError, UnicodeError):
                tail = ""
        applog.emit(
            "preroll",
            "ERROR run_concat ffmpeg exited rc={} ({} -> {}){} — clip "
            "merge failed".format(
                result.returncode, list_path, output_path,
                (" stderr_tail=" + tail) if tail else "",
            ),
        )
        return False
    return True


# Smoke test for `time` import — keeps the linter happy when no
# call site yet uses the module's `time` re-export. The detect.py
# wiring iter will call `preroll.start()` at boot + use os.path
# helpers for the pre-roll concat.
_ = time
