"""Per-event MP4 clip recorder (iter-202, Feature #1 slice 2).

Pure stdlib + Python 3.6 compatible — runs on the Jetson host.

Strategy chosen for slice 2: **post-roll-only via single ffmpeg
subprocess per event.** ffmpeg reads the live RTSP stream from
MediaMTX (the same source NVDEC hands the detection worker) and
copies the H.264 bitstream into an MP4 container for the next
``duration_s`` seconds — NO re-encode, so CPU cost is ~5 % per
process vs ~30 % if we re-encoded. NVDEC stays untouched.

The "5 s pre-roll + 5 s post-roll" pitch in
``feature_ideas_iter177.md`` requires a continuous segment-
recording ffmpeg writing 30 s rolling fragments, with on-event
``copy_segment_for_event_id``. That's the natural slice 2b. The
slice 2 we ship here gets the user a 10 s post-roll clip end-to-
end; the pre-roll upgrade is a /loop iter when operator wants it.

Concurrency:
    Detection events can burst (door cycles, weather false
    positives). Each clip is its own ffmpeg process; we cap the
    in-flight count so a sustained burst doesn't fork-bomb the
    Jetson. Excess requests log + drop rather than queue —
    queueing extends the post-roll window past usefulness.

Lifecycle:
    Each ``start_clip`` returns immediately after spawning the
    subprocess; ``_reap`` runs lazily on each call to retire
    finished processes. Slice 3's client-side modal handles the
    "clip not yet ready" case via the iter-201 route's 404 +
    a brief retry.

This module CANNOT be functionally tested on the dev machine —
ffmpeg subprocesses against a real RTSP stream need the Jetson
camera pipeline live. Unit tests cover argument construction,
subprocess invocation, and concurrency capping via mock; the
operator verifies end-to-end on a slice-2 deploy.
"""
import os
import subprocess
import threading

import applog


class ClipRecorder(object):
    """Forks an ffmpeg subprocess per detection event to capture a
    short MP4 clip. Caps concurrent in-flight processes so an event
    burst can't fork-bomb the host.

    Defaults match the iter-201 server-side regex:
    ``recordings_dir / "{event_id}.mp4"``.
    """

    def __init__(self,
                 rtsp_url,
                 recordings_dir,
                 duration_s=10,
                 max_concurrent=3,
                 ffmpeg_bin="ffmpeg"):
        # iter-283 (camera-library-usage-auditor D1): default lifted
        # from 2 to 3 to match `detect.py::DETECT_CLIP_MAX_CONCURRENT`.
        # Pre-iter-283 the constructor's `=2` default and the worker's
        # `=3` default drifted silently — unit tests against the
        # constructor capped at 2; production capped at 3. The docstring
        # below was written against the lower cap. Aligning at the
        # production-correct value (the worker passes the env-overridden
        # value explicitly when constructed, so 3 is what's been live
        # since iter-247 — the constructor default just wasn't matching).
        self.rtsp_url = rtsp_url
        self.recordings_dir = recordings_dir
        self.duration_s = duration_s
        self.max_concurrent = max_concurrent
        self.ffmpeg_bin = ffmpeg_bin
        self._procs = []
        self._lock = threading.Lock()

    def _reap(self):
        """Drop finished subprocesses from `_procs`. Called lazily
        on each `start_clip` invocation; no background thread.

        Structural observability fix (docs/logging_plan.md §2): a
        finished ffmpeg's ``returncode`` is the ONLY signal that a clip
        was written truncated / not at all. Pre-logging this returned
        ``None`` was discarded and a non-zero rc (clip missing/truncated)
        was invisible — the user saw a 404-forever clip with no journal
        trace. On rc!=0 we log WHY at WARNING, naming the event_id and
        the tail of the per-event stderr temp file (see ``start_clip``),
        then unlink the temp so it can't accumulate."""
        live = []
        for p in self._procs:
            if p.poll() is None:
                live.append(p)
                continue
            # Finished — inspect the returncode so a failed clip is
            # observable. `returncode` is set by poll() above.
            rc = getattr(p, "returncode", None)
            stderr_path = getattr(p, "_homecam_stderr_path", None)
            event_id = getattr(p, "_homecam_event_id", "?")
            if rc is not None and rc != 0:
                tail = self._read_stderr_tail(stderr_path)
                applog.emit(
                    "recording",
                    "clip ffmpeg exited rc={} for event_id={}{}".format(
                        rc, event_id,
                        (" stderr_tail=" + tail) if tail else "",
                    ),
                )
            self._unlink_stderr_temp(stderr_path)
        self._procs = live

    @staticmethod
    def _read_stderr_tail(stderr_path, max_bytes=2000):
        """Read the tail of a per-event stderr temp file (bounded).
        Returns a short single-line string, or "" on any failure / when
        no temp file was attached. Fail-quiet: a logging helper must
        never raise into the reap path."""
        if not stderr_path:
            return ""
        try:
            if not os.path.exists(stderr_path):
                return ""
            size = os.path.getsize(stderr_path)
            with open(stderr_path, "rb") as f:
                if size > max_bytes:
                    f.seek(size - max_bytes)
                data = f.read()
        except (OSError, IOError):
            return ""
        text = data.decode("utf-8", "replace").strip()
        # Collapse to one journal-friendly line.
        return text.replace("\n", " | ")[-max_bytes:]

    @staticmethod
    def _unlink_stderr_temp(stderr_path):
        """Remove the per-event stderr temp file. Fail-quiet."""
        if not stderr_path:
            return
        try:
            if os.path.exists(stderr_path):
                os.remove(stderr_path)
        except OSError:
            pass

    def in_flight(self):
        """Return current count of running ffmpeg subprocesses."""
        with self._lock:
            self._reap()
            return len(self._procs)

    def _filter_valid_segments(self, segments, event_id):
        """iter-356.60b (HANDOFF.md §4 root cause): keep only
        segments whose MP4 has a parseable moov atom. Drops the
        actively-being-written segment that the segment-recorder
        ffmpeg has not yet finalized — without this filter the
        concat demuxer hits `[mov,mp4,m4a,3gp,3g2,mj2] moov atom
        not found`, exits rc=0, and silently truncates the merged
        clip BEFORE reaching the post-roll input.

        Uses ffprobe (already on PATH because ClipRecorder requires
        ffmpeg). One subprocess per segment; ~30-80ms each. We're
        in the daemon merge thread so this latency is invisible to
        the user-facing emit path.

        Returns the filtered list. Logs how many were dropped so
        a future spike of broken segments is visible in journalctl.
        """
        import os as _os
        valid = []
        dropped = []
        # ffprobe argv: cheapest possible — just enough to parse
        # the container. -show_entries format= ensures it has to
        # touch the moov; -v error suppresses non-error output.
        ffprobe_bin = self.ffmpeg_bin
        if ffprobe_bin.endswith("ffmpeg"):
            ffprobe_bin = ffprobe_bin[:-len("ffmpeg")] + "ffprobe"
        for seg in segments:
            if not _os.path.exists(seg):
                dropped.append((seg, "missing"))
                continue
            try:
                rc = subprocess.run(
                    [
                        ffprobe_bin,
                        "-v", "error",
                        "-show_entries", "format=duration",
                        "-of", "default=noprint_wrappers=1",
                        seg,
                    ],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    timeout=5.0,
                ).returncode
                if rc == 0:
                    valid.append(seg)
                else:
                    dropped.append((seg, "ffprobe rc={}".format(rc)))
            except (OSError, subprocess.TimeoutExpired) as e:
                dropped.append((seg, type(e).__name__))
        if dropped:
            # docs/logging_plan.md §2: distinguish "all segments dropped
            # because ffprobe is missing" (a deploy/PATH failure — the
            # ffprobe binary doesn't exist) from the normal in-flight-moov
            # drops. When EVERY segment failed with an OSError-class reason
            # (FileNotFoundError / OSError name), ffprobe itself is the
            # suspect, not the segments.
            os_reasons = ("FileNotFoundError", "OSError", "PermissionError")
            all_os_failures = (
                segments
                and len(dropped) == len(segments)
                and all(r in os_reasons for _p, r in dropped)
            )
            applog.emit(
                "recording",
                "event_id={} dropped {} broken segment(s): {}{}".format(
                    event_id, len(dropped),
                    ", ".join(
                        "{}({})".format(_os.path.basename(p), reason)
                        for p, reason in dropped
                    ),
                    " (ALL via OSError — ffprobe '{}' likely missing/"
                    "unexecutable)".format(ffprobe_bin)
                    if all_os_failures else "",
                ),
            )
        return valid

    def _build_args(self, output_path, duration_s):
        """ffmpeg arg list. ``-c copy`` avoids re-encode (cheap CPU,
        keeps NVENC output bitstream-identical). ``-t duration``
        bounds the clip; ``-y`` overwrites if the path already
        exists (an event_id collision is a worker-side bug worth
        noting in logs but shouldn't crash the recorder).

        iter-254: duration is now per-call, threaded from the live
        runtime config (user-tunable in Settings). Falls back to
        the constructor default when caller passes None.
        """
        # iter-356.43: explicit `-f mp4`. ffmpeg infers the muxer from
        # the output filename's extension; the iter-350 G1 change put a
        # `.tmp` suffix on the post-roll temp path (and the iter-350 G2
        # concat also writes to `<final>.tmp`), which ffmpeg cannot map
        # to a muxer ("Unable to find a suitable output format" in <1 s,
        # subprocess exits RC=1, no clip file written). Forcing the
        # muxer here makes the argv extension-independent so future
        # suffix changes can't regress this. Defense-in-depth: also
        # patched in `preroll.run_concat`.
        return [
            self.ffmpeg_bin,
            "-y",                    # overwrite output without prompting
            "-loglevel", "warning",  # suppress per-frame chatter
            "-rtsp_transport", "tcp",  # mediamtx supports both; tcp is more
                                       # robust on flaky LAN
            "-i", self.rtsp_url,
            "-t", str(duration_s),
            "-c", "copy",
            "-f", "mp4",
            output_path,
        ]

    def start_clip(self, event_id, duration_s=None,
                   pre_roll_s=0.0, preroll_buffer=None):
        """Fork ffmpeg to write `recordings_dir/{event_id}.mp4`.
        Returns True if the subprocess was started, False if
        capacity was full or the event_id was malformed.

        Non-blocking — caller continues immediately; the clip lands
        in `duration_s` seconds. Caller should NOT wait on the
        returned process; this method takes care of cleanup via
        the next `start_clip`'s `_reap`.

        Charset matches `recording_service._VALID_EVENT_ID` on the
        server side: alphanumeric + dash + underscore. We accept a
        broader set here (anything that's safe in a filename) and
        let the server's regex be the strict gate; the worker
        emits the canonical ids the server defined.

        iter-324 (Feature #1 slice 2c, pre-roll): when
        `pre_roll_s > 0` AND `preroll_buffer` is supplied, the
        post-roll ffmpeg subprocess runs as before; a daemon
        thread waits for it to finish, then ffmpeg-concats the
        pre-roll segments + post-roll output into the FINAL
        `<event_id>.mp4` (the post-roll is written to a temp
        path during the wait).

        When `pre_roll_s == 0` OR `preroll_buffer is None`: no
        change from the iter-202 post-roll-only behavior. New
        callers can opt in without breaking old call sites.
        """
        if not event_id or "/" in event_id or "\\" in event_id:
            # docs/logging_plan.md §2: malformed event_id is a caller-side
            # (worker id-gen) bug — log it so the resulting /clips 404 is
            # attributable rather than silent.
            applog.emit(
                "recording",
                "refusing clip: malformed event_id={!r} (empty or path "
                "separator) — worker id-gen bug".format(event_id),
            )
            return False
        # iter-254: per-call duration_s overrides the constructor
        # default. Caller (detect.py emit path) passes the live
        # `runtime.clip_post_roll_s` so changes from the Settings
        # slider take effect on the NEXT detection without a worker
        # restart. None falls back to the constructor's default.
        effective_duration = (
            duration_s if duration_s is not None else self.duration_s
        )
        # iter-283 (camera-library-usage-auditor D1): the cap check
        # serializes through `self._lock` (cheap), but `os.makedirs`
        # and `subprocess.Popen` ran INSIDE the lock too —
        # makedirs on an NFS-backed recordings_dir or a slow eMMC
        # under contention blocks the lock for 10s of ms, which
        # blocks the next detection's start_clip call (and therefore
        # the worker's emit path). The fix is two phases: capacity
        # check + reservation under the lock; spawn + insert outside.
        # If the subprocess fails to launch, we don't bump the live
        # count — but we DO have to budget capacity for the moment
        # we're trying to start one. Easier shape: check + spawn
        # outside, append under lock at the end. The downside is two
        # parallel start_clip calls might both race past the cap
        # (each sees N < max_concurrent). On a 3-cap deployment with
        # ~1 detection/s burst rate, racing past the cap by 1 is
        # acceptable — net effect: one extra ffmpeg fork during a
        # spike. The benefit is the emit path no longer waits
        # behind makedirs / Popen on a slow disk.
        with self._lock:
            self._reap()
            if len(self._procs) >= self.max_concurrent:
                # docs/logging_plan.md §2: capacity-cap drop. Previously
                # "logging is the caller's job" and detect.py only caught
                # exceptions, so this `False` return (clip silently
                # dropped during a burst) was invisible. Log it here at
                # WARNING naming in_flight/max so a sustained burst that
                # eats clips is greppable.
                applog.emit(
                    "recording",
                    "dropping clip event_id={}: at capacity "
                    "({}/{} in flight)".format(
                        event_id, len(self._procs), self.max_concurrent,
                    ),
                )
                return False
        output_path = os.path.join(
            self.recordings_dir,
            "{}.mp4".format(event_id),
        )
        try:
            # Ensure dir exists; harmless if already there. Outside
            # the lock — makedirs on a slow filesystem is the worst
            # offender for emit-path latency.
            os.makedirs(self.recordings_dir, exist_ok=True)
        except OSError as e:
            # docs/logging_plan.md §2: recordings_dir makedirs failed —
            # volume unmounted / disk full / read-only. Every clip will
            # fail until fixed; name the dir + reason at ERROR.
            applog.emit(
                "recording",
                "ERROR makedirs failed for recordings_dir={!r} event_id={}"
                ": {}: {} — clip cannot be written".format(
                    self.recordings_dir, event_id, type(e).__name__, e,
                ),
            )
            return False
        # iter-324: pre-roll mode forks ffmpeg to a TEMP path so the
        # final `<event_id>.mp4` only appears once the concat-merge
        # is done. Otherwise the iter-201 server route's `clip_exists`
        # check would pick up an in-progress post-roll-only file
        # before the pre-roll segments are stitched in.
        # iter-350 (camera-library-usage G1 from iter-333 broad audit):
        # changed temp suffix from `.postroll.mp4` to `.postroll.tmp`
        # because `recording_service.sweep_old_clips` filters
        # `entry.suffix == ".mp4"` — a long-running merge (ffmpeg
        # wedged > retention_days * 86400s) could see its temp file
        # deleted by the sweep. `.tmp` suffix is invisible to the sweep.
        use_preroll = (
            pre_roll_s and pre_roll_s > 0 and preroll_buffer is not None
        )
        post_only_path = (
            output_path + ".postroll.tmp" if use_preroll else output_path
        )
        # docs/logging_plan.md §2 + §4 (CLAUDE.md deadlock pin): the
        # post-roll ffmpeg is an ASYNC long-lived subprocess; PIPE on its
        # stderr risks the ~64 KB pipe-buffer-fill hang (RTSP
        # keyframe-not-found loop) because nothing drains it until
        # _reap(). So instead of PIPE we redirect stderr to a BOUNDED
        # per-event TEMP FILE. The OS writes directly to the fd (no pipe
        # buffer, no hang), _reap() reads its tail on rc!=0, then unlinks.
        stderr_path = post_only_path + ".stderr"
        stderr_fh = None
        try:
            stderr_fh = open(stderr_path, "wb")
        except (OSError, IOError):
            # Could not open the stderr temp (disk full / RO). Fall back
            # to DEVNULL so the clip can still be attempted; we just lose
            # the stderr tail on failure.
            stderr_path = None
        try:
            proc = subprocess.Popen(
                self._build_args(post_only_path, effective_duration),
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=(stderr_fh if stderr_fh is not None
                        else subprocess.DEVNULL),
            )
        except (OSError, FileNotFoundError) as e:
            # docs/logging_plan.md §2: the #1 deploy failure — ffmpeg not
            # on the host PATH / unexecutable. Pre-logging this was a
            # silent `return False`. Name the ffmpeg binary so the
            # operator knows exactly what's missing.
            applog.emit(
                "recording",
                "ERROR ffmpeg spawn failed (bin={!r}) for event_id={}: "
                "{}: {} — clip not recorded".format(
                    self.ffmpeg_bin, event_id, type(e).__name__, e,
                ),
            )
            if stderr_fh is not None:
                try:
                    stderr_fh.close()
                except (OSError, IOError):
                    pass
                self._unlink_stderr_temp(stderr_path)
            return False
        # The parent keeps no use for the write fd once Popen dup'd it.
        if stderr_fh is not None:
            try:
                stderr_fh.close()
            except (OSError, IOError):
                pass
        # Attach the per-event identifiers so _reap() can log WHY a clip
        # failed (rc + stderr tail) and clean up the temp file.
        proc._homecam_event_id = event_id
        proc._homecam_stderr_path = stderr_path
        with self._lock:
            self._procs.append(proc)

        if use_preroll:
            # iter-324: snapshot pre-roll segments NOW (before the
            # post-roll subprocess writes anything) so we don't
            # accidentally include the post-roll's own output. Then
            # spawn a daemon thread that waits for the post-roll
            # ffmpeg to finish + runs the concat merge.
            import time as _time
            # iter-324: detection/ isn't a package (no __init__.py),
            # so `from . import` fails. detect.py + tests put the
            # detection/ dir on sys.path; bare module import resolves.
            import preroll as _preroll
            now = _time.time()
            pre_segments = preroll_buffer.segments_in_window(
                now=now, pre_roll_s=pre_roll_s,
            )
            # iter-356.51 (race fix): the segment-recorder ffmpeg uses
            # `-segment_wrap N` which OVERWRITES segment slots in-place
            # as the ring rotates. The merge thread holds segment
            # PATHS (not bytes) and waits up to clip_post_roll_s for
            # the post-roll ffmpeg to finish — during that wait, the
            # live recorder cycles past the wrap point and rewrites
            # those slots with post-event content. By the time
            # `run_concat` reads the paths, the bytes are no longer
            # pre-event. Confirmed via frame-sampling: a 25.5 s clip
            # captured during a continuous person-emit burst contained
            # zero people in any frame. Fix: copy segments out of the
            # ring NOW, before the merge thread waits. The merge
            # thread reads from the per-event scratch dir; ring
            # rotation is harmless. Scratch dir cleaned in `finally`
            # of the merge thread.
            import shutil as _shutil
            scratch_dir = os.path.join(
                self.recordings_dir, "_preroll", "event_" + event_id,
            )
            copied_segments = []
            try:
                os.makedirs(scratch_dir, exist_ok=True)
                for i, seg_src in enumerate(pre_segments):
                    seg_dst = os.path.join(
                        scratch_dir, "seg_{:03d}.mp4".format(i),
                    )
                    try:
                        _shutil.copy2(seg_src, seg_dst)
                        copied_segments.append(seg_dst)
                    except (OSError, IOError):
                        # A segment that vanished mid-copy (ring
                        # rotation already rewrote it OR ffmpeg held
                        # the slot open) is skipped, not fatal — the
                        # merge can still produce a useful pre-roll
                        # from whatever copied successfully.
                        pass
                # docs/logging_plan.md §2: per-segment copy shortfall.
                # When fewer segments copied than were requested, the
                # pre-roll is shorter than the user expects (ring rotation
                # raced the copy). INFO so the truncation is attributable
                # without alarming.
                if len(copied_segments) < len(pre_segments):
                    applog.emit(
                        "recording",
                        "event_id={} pre-roll copy shortfall: {}/{} "
                        "segments copied (ring rotated mid-copy)".format(
                            event_id, len(copied_segments),
                            len(pre_segments),
                        ),
                    )
            except OSError as e:
                # docs/logging_plan.md §2: Scratch-dir creation failed
                # (disk full, perms). The live-ring fallback re-exposes
                # the iter-356.51 frame-corruption race (-segment_wrap
                # rewrites slots during the merge wait), so WARN — the
                # clip may end up with post-event content in the pre-roll.
                applog.emit(
                    "recording",
                    "event_id={} scratch-dir create failed (dir={!r}): "
                    "{}: {} — falling back to live ring (iter-356.51 "
                    "frame-corruption race re-exposed)".format(
                        event_id, scratch_dir, type(e).__name__, e,
                    ),
                )
                copied_segments = list(pre_segments)
                scratch_dir = None
            t = threading.Thread(
                target=self._merge_preroll,
                args=(proc, copied_segments, post_only_path, output_path,
                      _preroll, event_id, scratch_dir),
                daemon=True,
            )
            t.start()
        return True

    def _merge_preroll(self, proc, pre_segments, post_only_path,
                       final_path, preroll_module, event_id,
                       scratch_dir=None):
        """iter-324 daemon-thread: wait for the post-roll ffmpeg to
        finish, then ffmpeg-concat the pre-roll segments with the
        post-roll output into `final_path`. Cleanup the temp post-
        roll file.

        iter-356.51: `pre_segments` is a list of paths inside
        `scratch_dir` (a per-event copy of the live ring), not the
        live ring itself. `scratch_dir` is rmtree'd in the outer
        `finally` so post-merge cleanup is bounded.

        Failure modes (defensive — log-free, fail-quiet):
        - post-roll ffmpeg returned non-zero: still try to concat
          whatever exists; an empty post-roll plus pre-roll segments
          is still a useful clip.
        - 0 pre-roll segments (cold start): just rename the post-
          roll temp to the final path — same as no-preroll mode.
        - concat ffmpeg failed: leave the post-roll temp file at the
          final path so the clip isn't lost.
        """
        try:
            # Bound wait: the post-roll duration plus a generous
            # buffer for ffmpeg startup + flush.
            proc.wait(timeout=120.0)
        except Exception as _e:
            # docs/logging_plan.md §2: post-roll wait(120s) timed out (or
            # raised) — the ffmpeg is wedged on a stalled RTSP/MediaMTX
            # source. Force-kill it. WARN so a recurring stall (camera
            # pipeline down) is visible; the concat may still produce a
            # partial clip from the temp file.
            applog.emit(
                "recording",
                "event_id={} post-roll wait timed out/failed ({}: {}) — "
                "force-killing wedged ffmpeg (RTSP/MediaMTX stall?)".format(
                    event_id, type(_e).__name__, _e,
                ),
            )
            try:
                proc.kill()
            except Exception:
                pass
        import os as _os
        import time as _time
        # iter-356.60 (HANDOFF.md §4 fix — pre-roll clip-duration
        # regression): bridge the kernel-flush race between the
        # post-roll ffmpeg's exit and the merge thread's existence
        # check. Symptom: ffmpeg writes 17 s of MP4 to
        # `<id>.mp4.postroll.tmp` cleanly, proc.wait() returns, but
        # `os.path.exists(post_only_path)` returns False at line ~360
        # below — the merge falls into the cold-start "pre-roll only"
        # branch and the user sees a 7-8 s clip instead of 24 s.
        #
        # Two-step bridge:
        #   1. fsync the parent directory FD so any pending dirent
        #      metadata is flushed. Best-effort: some filesystems
        #      reject directory fsync (vfat / network mounts) with
        #      EBADF or EINVAL — wrapped in try/except so we just
        #      fall through to the retry on rejection.
        #   2. bounded retry on os.path.exists — up to 1.5 s polling
        #      at 50 ms intervals. Worst case the loop returns at the
        #      timeout and we still hit the cold-start branch (no
        #      regression vs today). Best case the dirent appears
        #      within 1-2 retries (≤ 100 ms), invisible to the user.
        #
        # Tests pre-create the post-roll temp file before merge runs,
        # so the loop returns at iteration 0 and adds zero latency to
        # the test path.
        _parent_dir = _os.path.dirname(post_only_path) or "."
        try:
            _dirfd = _os.open(_parent_dir, _os.O_RDONLY)
            try:
                _os.fsync(_dirfd)
            finally:
                _os.close(_dirfd)
        except OSError:
            pass
        _retries = 0
        _MAX_RETRIES = 30  # 30 × 50 ms = 1.5 s total
        _RETRY_SLEEP_S = 0.05
        while not _os.path.exists(post_only_path) and _retries < _MAX_RETRIES:
            _time.sleep(_RETRY_SLEEP_S)
            _retries += 1
        # iter-356.60a (HANDOFF.md §4 follow-up): structured per-merge
        # diagnostic so the regression is observable. Logs the branch
        # we're about to take + the post_only_path size — when post-
        # roll lands as a 0-byte file (concat-runs-but-keeps-pre-roll-
        # only symptom), this line surfaces it without needing a
        # journal-side print() in every failure mode.
        try:
            _exists = _os.path.exists(post_only_path)
            _size = _os.path.getsize(post_only_path) if _exists else 0
            _rc = getattr(proc, "returncode", "?")
            applog.emit(
                "recording-merge",
                "event_id={} retries={} ({}ms) post_only exists={} "
                "size={}B proc_rc={} pre_segs={}".format(
                    event_id, _retries,
                    int(_retries * _RETRY_SLEEP_S * 1000),
                    _exists, _size, _rc, len(pre_segments),
                ),
            )
        except OSError:
            pass
        # iter-356.60b (HANDOFF.md §4 root cause): drop pre-roll
        # segments whose MP4 moov atom isn't yet written. Symptom:
        # concat ffmpeg hits "[mov,mp4,m4a,3gp,3g2,mj2] moov atom
        # not found" on the actively-being-written segment, prints
        # "Invalid data found when processing input", exits with
        # rc=0 anyway, and the output contains only the segments
        # processed BEFORE the broken one — pre-roll truncated and
        # post-roll never reached.
        #
        # Reproduction (this morning's session):
        #   inputs = 9 pre-roll segs + 17 s post-roll
        #   broken seg: seg_008 (moov atom missing — being written)
        #   ffmpeg output: 7.78 s (stops at seg_007), rc=0, post-roll dropped
        #
        # The segment-recorder ffmpeg uses `-f segment` muxer, which
        # writes the moov atom on segment ROTATION (when the next
        # segment starts). So the most-recent slot in
        # `preroll_buffer.segments_in_window()` is reliably broken
        # whenever the wall-clock falls between segment boundaries.
        # iter-356.51 scratch-copy decoupled merge from `-segment_wrap`
        # rotation but didn't address the in-flight-moov case.
        #
        # Fix: ffprobe each segment before adding it to the concat
        # list. Drop ones that fail. Cost: ~30-80ms per segment ×
        # 9 segs ≈ 0.3-0.7s extra merge latency. Merge thread is
        # already daemon + post-event so this is invisible to the
        # user-facing emit path.
        pre_segments = self._filter_valid_segments(pre_segments, event_id)
        # iter-350 (camera-library-usage G2 from iter-333 broad audit):
        # write concat to `final_path + ".tmp"` then atomic
        # `os.rename` to `final_path`. Pre-iter-350 the concat
        # ffmpeg wrote DIRECTLY to `final_path` — the iter-330
        # /api/events/export route reading `clip_path()` mid-write
        # could grab a truncated MP4. POSIX rename is atomic on
        # the same filesystem (which `recordings_dir` always is),
        # so the export sees either the old missing file (404 +
        # manifest clip_included=false) or the complete final.
        tmp_path = final_path + ".tmp"
        # Cold start (no segments yet) → just promote the post-roll.
        if not pre_segments:
            try:
                if _os.path.exists(post_only_path):
                    _os.rename(post_only_path, final_path)
            except OSError as _e:
                # docs/logging_plan.md §2: atomic-rename failure here
                # means the post-roll clip never lands at final_path —
                # the /clips route 404s FOREVER. ERROR naming event_id.
                applog.emit(
                    "recording",
                    "ERROR clip lost: post-roll promote rename failed for "
                    "event_id={} ({} -> {}): {}: {} — /clips 404-forever"
                    .format(
                        event_id, post_only_path, final_path,
                        type(_e).__name__, _e,
                    ),
                )
            return
        # Cold start (post-roll never wrote anything) → write the
        # pre-roll only via tmp + atomic rename.
        if not _os.path.exists(post_only_path):
            list_path = final_path + ".concat.txt"
            try:
                preroll_module.write_concat_list(list_path, pre_segments)
                ok = preroll_module.run_concat(
                    self.ffmpeg_bin, list_path, tmp_path,
                )
                if ok:
                    try:
                        _os.rename(tmp_path, final_path)
                    except OSError as _e:
                        # docs/logging_plan.md §2: pre-roll-only rename
                        # failed → clip 404-forever. ERROR naming event_id.
                        applog.emit(
                            "recording",
                            "ERROR clip lost: pre-roll-only rename failed "
                            "for event_id={} ({} -> {}): {}: {} — /clips "
                            "404-forever".format(
                                event_id, tmp_path, final_path,
                                type(_e).__name__, _e,
                            ),
                        )
                else:
                    # docs/logging_plan.md §2: pre-roll-only concat
                    # returned False — no post-roll existed to fall back
                    # to, so the clip is lost entirely. WARN naming
                    # event_id.
                    applog.emit(
                        "recording",
                        "event_id={} pre-roll-only concat failed (no "
                        "post-roll fallback) — clip not produced".format(
                            event_id,
                        ),
                    )
            finally:
                try:
                    _os.remove(list_path)
                except OSError:
                    pass
                # Defensive: if tmp_path still exists (concat failed
                # or rename failed), remove it so a stale .tmp
                # doesn't accumulate on disk.
                try:
                    if _os.path.exists(tmp_path):
                        _os.remove(tmp_path)
                except OSError:
                    pass
            return
        # Normal path: concat segments + post-roll into tmp, then
        # atomic rename to final.
        list_path = final_path + ".concat.txt"
        try:
            preroll_module.write_concat_list(
                list_path, list(pre_segments) + [post_only_path],
            )
            ok = preroll_module.run_concat(
                self.ffmpeg_bin, list_path, tmp_path,
            )
            # iter-356.60a diagnostic: log the concat outcome + the
            # output size so we can see whether post-roll content
            # actually made it into the merged clip.
            try:
                _tmp_size = (
                    _os.path.getsize(tmp_path)
                    if _os.path.exists(tmp_path) else 0
                )
                applog.emit(
                    "recording-merge",
                    "event_id={} concat ok={} tmp_size={}B "
                    "post_only_size={}B".format(
                        event_id, ok, _tmp_size,
                        _os.path.getsize(post_only_path)
                        if _os.path.exists(post_only_path) else 0,
                    ),
                )
            except OSError:
                pass
            if ok:
                try:
                    _os.rename(tmp_path, final_path)
                except OSError as _e:
                    # docs/logging_plan.md §2: normal-merge rename failed
                    # → the merged clip is lost entirely. ERROR naming
                    # event_id.
                    applog.emit(
                        "recording",
                        "ERROR clip lost: merged-clip rename failed for "
                        "event_id={} ({} -> {}): {}: {} — /clips "
                        "404-forever".format(
                            event_id, tmp_path, final_path,
                            type(_e).__name__, _e,
                        ),
                    )
            else:
                # docs/logging_plan.md §2: concat failed but a post-roll
                # exists — fall back to the post-roll-only output so the
                # user doesn't lose the clip. WARN: the pre-roll is
                # silently dropped (clip shorter than expected) but the
                # event is still served.
                applog.emit(
                    "recording",
                    "event_id={} concat failed — falling back to "
                    "post-roll-only (pre-roll dropped)".format(event_id),
                )
                try:
                    _os.rename(post_only_path, final_path)
                except OSError as _e:
                    # The fallback rename ALSO failed → clip lost entirely.
                    applog.emit(
                        "recording",
                        "ERROR clip lost: post-roll fallback rename failed "
                        "for event_id={} ({} -> {}): {}: {} — /clips "
                        "404-forever".format(
                            event_id, post_only_path, final_path,
                            type(_e).__name__, _e,
                        ),
                    )
        finally:
            try:
                _os.remove(list_path)
            except OSError:
                pass
            # Cleanup leftovers: tmp from failed concat, post-roll
            # temp from successful concat.
            try:
                if _os.path.exists(tmp_path):
                    _os.remove(tmp_path)
            except OSError:
                pass
            try:
                if _os.path.exists(post_only_path) and post_only_path != final_path:
                    _os.remove(post_only_path)
            except OSError:
                pass
        # Note on event_id: kept for future iter that might log the
        # merge outcome via a metric. Currently unused — the recorder
        # module stays log-free per its iter-202 design.
        _ = event_id
        # iter-356.51: tear down the per-event scratch dir holding
        # the copied pre-roll segments. Fail-quiet: a partial cleanup
        # leaves bytes on disk but the next event's scratch dir is
        # uniquely keyed (`event_<id>`), so old debris never blocks
        # a new merge.
        if scratch_dir is not None:
            try:
                import shutil as _shutil
                _shutil.rmtree(scratch_dir, ignore_errors=True)
                # docs/logging_plan.md §2: scratch cleanup incomplete is a
                # slow disk leak. rmtree(ignore_errors=True) never raises,
                # so probe directly: if the dir survives, log at DEBUG so
                # a recurring leak is visible under triage without
                # alarming in the common (clean) case.
                if _os.path.exists(scratch_dir):
                    applog.emit(
                        "recording",
                        "DEBUG event_id={} scratch dir not fully removed: "
                        "{} (slow-disk leak?)".format(event_id, scratch_dir),
                    )
            except OSError:
                pass
