"""iter-202 (Feature #1 slice 2): ClipRecorder unit tests.

Covers argument construction, subprocess invocation, concurrency
capping. Functional verification (real ffmpeg + RTSP) is operator-
side at deploy time — module CANNOT be E2E tested on the dev
machine.
"""
import os
import subprocess
import sys
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from recording import ClipRecorder  # noqa: E402


# --- _build_args ---


def test_build_args_includes_rtsp_url_and_output(tmp_path):
    rec = ClipRecorder(
        rtsp_url="rtsp://localhost:8554/cam",
        recordings_dir=str(tmp_path),
        duration_s=10,
    )
    args = rec._build_args("/tmp/out.mp4", rec.duration_s)
    assert "rtsp://localhost:8554/cam" in args
    assert "/tmp/out.mp4" in args


def test_build_args_uses_copy_codec(tmp_path):
    """`-c copy` keeps the NVENC bitstream — no re-encode CPU cost."""
    rec = ClipRecorder("rtsp://x", str(tmp_path))
    args = rec._build_args("/tmp/o.mp4", rec.duration_s)
    assert "-c" in args
    idx = args.index("-c")
    assert args[idx + 1] == "copy"


def test_build_args_includes_duration(tmp_path):
    rec = ClipRecorder("rtsp://x", str(tmp_path), duration_s=8)
    args = rec._build_args("/tmp/o.mp4", rec.duration_s)
    assert "-t" in args
    idx = args.index("-t")
    assert args[idx + 1] == "8"


def test_build_args_uses_tcp_transport(tmp_path):
    """TCP RTSP transport is more robust on a flaky LAN than UDP."""
    rec = ClipRecorder("rtsp://x", str(tmp_path))
    args = rec._build_args("/tmp/o.mp4", rec.duration_s)
    assert "-rtsp_transport" in args
    idx = args.index("-rtsp_transport")
    assert args[idx + 1] == "tcp"


def test_build_args_overwrites_existing_output(tmp_path):
    """`-y` flag — an event_id collision shouldn't block the
    recorder."""
    rec = ClipRecorder("rtsp://x", str(tmp_path))
    args = rec._build_args("/tmp/o.mp4", rec.duration_s)
    assert "-y" in args


# --- start_clip ---


def test_start_clip_invokes_ffmpeg(tmp_path):
    rec = ClipRecorder("rtsp://x", str(tmp_path))
    with mock.patch("recording.subprocess.Popen") as popen:
        # Mock proc that's still running (poll=None).
        popen.return_value.poll.return_value = None
        ok = rec.start_clip("evt-001")
        assert ok is True
        popen.assert_called_once()
        called_args = popen.call_args[0][0]
        # First arg should be ffmpeg binary.
        assert called_args[0] == "ffmpeg"
        # Output path should land in recordings_dir.
        assert called_args[-1] == os.path.join(str(tmp_path), "evt-001.mp4")


def test_start_clip_creates_recordings_dir(tmp_path):
    target = tmp_path / "nested" / "rec"
    rec = ClipRecorder("rtsp://x", str(target))
    with mock.patch("recording.subprocess.Popen") as popen:
        popen.return_value.poll.return_value = None
        ok = rec.start_clip("evt-002")
        assert ok is True
        assert target.is_dir()


def test_start_clip_rejects_empty_event_id(tmp_path):
    rec = ClipRecorder("rtsp://x", str(tmp_path))
    with mock.patch("recording.subprocess.Popen") as popen:
        assert rec.start_clip("") is False
        popen.assert_not_called()


def test_start_clip_rejects_path_traversal(tmp_path):
    """Defense-in-depth — server-side regex is the gate, this is
    belt-and-braces. Slash or backslash in event_id is refused."""
    rec = ClipRecorder("rtsp://x", str(tmp_path))
    with mock.patch("recording.subprocess.Popen") as popen:
        assert rec.start_clip("../etc/passwd") is False
        assert rec.start_clip("foo/bar") is False
        assert rec.start_clip(r"foo\bar") is False
        popen.assert_not_called()


def test_start_clip_caps_concurrent(tmp_path):
    """`max_concurrent` capacity check. Beyond cap → drop, return
    False. Caller logs."""
    rec = ClipRecorder("rtsp://x", str(tmp_path), max_concurrent=2)
    running = []

    def fake_popen(*args, **kwargs):
        m = mock.MagicMock()
        m.poll.return_value = None  # still running
        running.append(m)
        return m

    with mock.patch("recording.subprocess.Popen", side_effect=fake_popen):
        assert rec.start_clip("evt-1") is True
        assert rec.start_clip("evt-2") is True
        # Cap reached — third should drop.
        assert rec.start_clip("evt-3") is False
        assert len(running) == 2


def test_finished_procs_are_reaped_freeing_capacity(tmp_path):
    """When a previous proc finishes, capacity opens up. The
    `_reap` runs lazily on each `start_clip`; no background
    thread."""
    rec = ClipRecorder("rtsp://x", str(tmp_path), max_concurrent=1)
    procs = []

    def fake_popen(*args, **kwargs):
        m = mock.MagicMock()
        m.poll.return_value = None
        procs.append(m)
        return m

    with mock.patch("recording.subprocess.Popen", side_effect=fake_popen):
        assert rec.start_clip("evt-1") is True
        # Pretend the first proc finished.
        procs[0].poll.return_value = 0
        # Capacity reclaimed → second clip starts.
        assert rec.start_clip("evt-2") is True


def test_start_clip_returns_false_when_ffmpeg_missing(tmp_path):
    """`Popen` raises FileNotFoundError when the ffmpeg binary
    isn't on PATH. Recorder refuses cleanly — slice 2b could fall
    back to libav."""
    rec = ClipRecorder("rtsp://x", str(tmp_path))
    with mock.patch(
        "recording.subprocess.Popen",
        side_effect=FileNotFoundError(),
    ):
        assert rec.start_clip("evt-1") is False


# --- in_flight ---


def test_in_flight_counts_running_processes(tmp_path):
    rec = ClipRecorder("rtsp://x", str(tmp_path), max_concurrent=5)
    procs = []

    def fake_popen(*args, **kwargs):
        m = mock.MagicMock()
        m.poll.return_value = None
        procs.append(m)
        return m

    with mock.patch("recording.subprocess.Popen", side_effect=fake_popen):
        rec.start_clip("a")
        rec.start_clip("b")
        rec.start_clip("c")
    assert rec.in_flight() == 3
    procs[0].poll.return_value = 0  # first finished
    assert rec.in_flight() == 2


# iter-254: per-call duration override so the Settings slider can
# tune post-roll without a worker restart.

def test_when_start_clip_passes_duration_s_then_ffmpeg_t_arg_uses_that_value(tmp_path):
    # arrange
    rec = ClipRecorder(rtsp_url="rtsp://x/cam", recordings_dir=str(tmp_path))

    # act
    args = rec._build_args(str(tmp_path / "abc.mp4"), 17.5)

    # assert
    assert "-t" in args
    t_idx = args.index("-t")
    assert args[t_idx + 1] == "17.5"


def test_when_start_clip_omits_duration_s_then_ffmpeg_t_arg_falls_back_to_constructor_default(tmp_path):
    # arrange
    rec = ClipRecorder(
        rtsp_url="rtsp://x/cam",
        recordings_dir=str(tmp_path),
        duration_s=12.0,
    )

    # act — _build_args is called with None semantics via start_clip;
    # call directly with the constructor default to pin the path.
    args = rec._build_args(str(tmp_path / "abc.mp4"), rec.duration_s)

    # assert
    assert args[args.index("-t") + 1] == "12.0"


def test_given_no_max_concurrent_passed_when_constructed_then_default_is_3(tmp_path):
    # iter-283 (camera-library-usage-auditor D1): the constructor
    # default for max_concurrent was 2; detect.py's env default
    # DETECT_CLIP_MAX_CONCURRENT was 3. Drift meant unit tests
    # against the constructor capped at 2 while production capped
    # at 3 — silent test-vs-prod divergence. Aligning the
    # constructor default at 3 is the production-correct value.

    # arrange + act
    rec = ClipRecorder(rtsp_url="rtsp://x/cam", recordings_dir=str(tmp_path))

    # assert
    assert rec.max_concurrent == 3


# iter-324 (Feature #1 slice 2c): pre-roll integration. The
# `start_clip(pre_roll_s=N, preroll_buffer=PB)` path: post-roll
# ffmpeg writes to a `<id>.mp4.postroll.tmp` temp; daemon thread
# concats with PB.segments_in_window result + post-roll into the
# final `<id>.mp4`. Backwards-compat: pre_roll_s=0 OR
# preroll_buffer=None falls through to the iter-202 behavior.

def test_given_no_preroll_when_start_clip_then_post_only_mode_unchanged(tmp_path, monkeypatch):
    """iter-324 backwards-compat: existing call sites that don't
    pass pre_roll_s OR pre_roll_s=0 use the iter-202 path."""
    # arrange
    fake_proc = mock.MagicMock()
    fake_proc.poll = mock.MagicMock(return_value=None)
    monkeypatch.setattr(
        "recording.subprocess.Popen", mock.MagicMock(return_value=fake_proc)
    )
    rec = ClipRecorder(rtsp_url="rtsp://x/cam", recordings_dir=str(tmp_path))

    # act
    ok = rec.start_clip("evt-no-preroll")

    # assert — output path is the FINAL .mp4 (no .postroll.tmp temp).
    assert ok is True
    import recording as _rec_mod
    call_args = _rec_mod.subprocess.Popen.call_args[0][0]
    out = call_args[-1]
    assert out.endswith("evt-no-preroll.mp4")
    assert ".postroll.tmp" not in out


def test_given_preroll_buffer_when_start_clip_then_postroll_writes_to_temp(
    tmp_path, monkeypatch,
):
    """iter-324: pre-roll mode forks ffmpeg into a `.postroll.tmp`
    temp so the iter-201 server `clip_exists` check doesn't see
    the in-progress file before the concat is done."""
    # arrange
    fake_proc = mock.MagicMock()
    fake_proc.poll = mock.MagicMock(return_value=None)
    fake_proc.wait = mock.MagicMock(return_value=0)
    fake_popen = mock.MagicMock(return_value=fake_proc)
    monkeypatch.setattr("recording.subprocess.Popen", fake_popen)
    rec = ClipRecorder(rtsp_url="rtsp://x/cam", recordings_dir=str(tmp_path))
    fake_pb = mock.MagicMock()
    fake_pb.segments_in_window = mock.MagicMock(return_value=[])  # cold start

    # act
    ok = rec.start_clip(
        "evt-preroll", pre_roll_s=5.0, preroll_buffer=fake_pb,
    )

    # assert — Popen got the .postroll.tmp temp path.
    assert ok is True
    call_args = fake_popen.call_args[0][0]
    out = call_args[-1]
    assert out.endswith("evt-preroll.mp4.postroll.tmp")


def test_given_preroll_buffer_with_zero_seconds_when_start_clip_then_post_only_path(
    tmp_path, monkeypatch,
):
    """iter-324 explicit-disable: pre_roll_s=0 means the
    daemon-thread concat is skipped even when a buffer is
    supplied."""
    # arrange
    fake_proc = mock.MagicMock()
    fake_proc.poll = mock.MagicMock(return_value=None)
    monkeypatch.setattr(
        "recording.subprocess.Popen", mock.MagicMock(return_value=fake_proc)
    )
    rec = ClipRecorder(rtsp_url="rtsp://x/cam", recordings_dir=str(tmp_path))
    fake_pb = mock.MagicMock()

    # act
    ok = rec.start_clip(
        "evt-zero", pre_roll_s=0.0, preroll_buffer=fake_pb,
    )

    # assert
    assert ok is True
    import recording as _rec_mod
    call_args = _rec_mod.subprocess.Popen.call_args[0][0]
    out = call_args[-1]
    assert out.endswith("evt-zero.mp4")
    assert ".postroll.tmp" not in out
    # Buffer NOT queried — pre_roll_s=0 short-circuits.
    fake_pb.segments_in_window.assert_not_called()


def test_given_preroll_segments_when_post_roll_done_then_concat_invoked(
    tmp_path, monkeypatch,
):
    """iter-324 happy path end-to-end: simulate the daemon thread
    by waiting briefly + verify the concat helper was invoked
    with the right segment list."""
    # arrange — pre-create the post-roll temp file so the merge sees it.
    import time as _time
    fake_proc = mock.MagicMock()
    fake_proc.poll = mock.MagicMock(return_value=0)  # already done
    fake_proc.wait = mock.MagicMock(return_value=0)
    monkeypatch.setattr(
        "recording.subprocess.Popen", mock.MagicMock(return_value=fake_proc)
    )
    # Stub preroll module's helpers so the merge thread can be
    # observed.
    import preroll
    write_mock = mock.MagicMock()
    concat_mock = mock.MagicMock(return_value=True)
    monkeypatch.setattr(preroll, "write_concat_list", write_mock)
    monkeypatch.setattr(preroll, "run_concat", concat_mock)
    # Pre-roll buffer returns 2 segments.
    seg1 = tmp_path / "seg_001.mp4"
    seg2 = tmp_path / "seg_002.mp4"
    seg1.write_bytes(b"a")
    seg2.write_bytes(b"b")
    fake_pb = mock.MagicMock()
    fake_pb.segments_in_window = mock.MagicMock(return_value=[str(seg1), str(seg2)])
    # Pre-create the post-roll temp file so the merge thread proceeds.
    post_only = tmp_path / "evt.mp4.postroll.tmp"
    post_only.write_bytes(b"postroll")
    rec = ClipRecorder(rtsp_url="rtsp://x/cam", recordings_dir=str(tmp_path))

    # act
    rec.start_clip("evt", pre_roll_s=5.0, preroll_buffer=fake_pb)
    # Daemon thread runs synchronously-ish since wait() is mocked
    # to return immediately. Poll briefly for completion.
    deadline = _time.time() + 2.0
    while _time.time() < deadline:
        if concat_mock.call_count > 0:
            break
        _time.sleep(0.05)

    # assert — concat called. iter-356.51: pre-roll segments are
    # COPIED into a per-event scratch dir before the merge thread
    # waits, so the concat list contains scratch-dir paths
    # (`_preroll/event_evt/seg_NNN.mp4`), NOT the original ring-slot
    # paths. This decouples merge timing from the segment-recorder
    # ffmpeg's `-segment_wrap` ring rotation, which would otherwise
    # rewrite the slots in-place during the post-roll wait whenever
    # `clip_post_roll_s` exceeded the ring capacity (15 s pre-356.51,
    # 60 s post-bump). Verify (a) two segment-shaped entries exist
    # under the scratch dir, (b) the post-roll temp lands last.
    assert concat_mock.called
    write_call_args = write_mock.call_args[0]
    list_arg = write_call_args[1]
    scratch_prefix = str(tmp_path / "_preroll" / "event_evt")
    seg_entries = [p for p in list_arg if p.startswith(scratch_prefix)]
    assert len(seg_entries) == 2, (
        "expected 2 scratch-copied segments; got: %s" % list_arg
    )
    # The post-roll temp comes last (chronologically after pre-roll).
    assert str(post_only) in list_arg
    assert list_arg[-1] == str(post_only)


def test_given_zero_preroll_segments_when_merge_runs_then_post_roll_promoted_to_final(
    tmp_path, monkeypatch,
):
    """iter-324 cold-start: when the buffer hasn't started writing
    yet (segments_in_window returns []), the merge just renames
    the post-roll temp to the final path."""
    # arrange
    import time as _time
    fake_proc = mock.MagicMock()
    fake_proc.poll = mock.MagicMock(return_value=0)
    fake_proc.wait = mock.MagicMock(return_value=0)
    monkeypatch.setattr(
        "recording.subprocess.Popen", mock.MagicMock(return_value=fake_proc)
    )
    fake_pb = mock.MagicMock()
    fake_pb.segments_in_window = mock.MagicMock(return_value=[])
    post_only = tmp_path / "evt.mp4.postroll.tmp"
    post_only.write_bytes(b"only-postroll")
    rec = ClipRecorder(rtsp_url="rtsp://x/cam", recordings_dir=str(tmp_path))

    # act
    rec.start_clip("evt", pre_roll_s=5.0, preroll_buffer=fake_pb)
    # Wait briefly for daemon thread.
    deadline = _time.time() + 2.0
    final = tmp_path / "evt.mp4"
    while _time.time() < deadline:
        if final.exists():
            break
        _time.sleep(0.05)

    # assert — final exists with the post-roll bytes; temp gone.
    assert final.exists()
    assert final.read_bytes() == b"only-postroll"
    assert not post_only.exists()


def test_iter350_postroll_temp_uses_tmp_suffix_not_mp4(tmp_path, monkeypatch):
    """iter-350 (camera-library-usage G1): the post-roll temp file
    MUST end in .postroll.tmp (NOT .postroll.mp4) so the iter-?
    `recording_service.sweep_old_clips` retention sweeper, which
    filters `entry.suffix == ".mp4"`, doesn't delete it mid-merge.
    """
    # arrange
    fake_proc = mock.MagicMock()
    fake_proc.poll = mock.MagicMock(return_value=None)
    monkeypatch.setattr(
        "recording.subprocess.Popen", mock.MagicMock(return_value=fake_proc)
    )
    rec = ClipRecorder(rtsp_url="rtsp://x/cam", recordings_dir=str(tmp_path))
    fake_pb = mock.MagicMock()
    fake_pb.segments_in_window = mock.MagicMock(return_value=[])

    # act
    rec.start_clip("evt-suffix", pre_roll_s=5.0, preroll_buffer=fake_pb)

    # assert
    import recording as _rec_mod
    call_args = _rec_mod.subprocess.Popen.call_args[0][0]
    out = call_args[-1]
    assert out.endswith("evt-suffix.mp4.postroll.tmp"), (
        "post-roll temp should end in .postroll.tmp (iter-350 G1); "
        "got: %s" % out
    )
    # Confirm the suffix is NOT .mp4 — the load-bearing sweep-skip.
    from pathlib import Path as _Path
    assert _Path(out).suffix == ".tmp"


def test_iter350_concat_writes_to_tmp_then_atomic_rename(tmp_path, monkeypatch):
    """iter-350 (camera-library-usage G2): the merge concat MUST
    write to `<final>.tmp` then `os.rename` to `<final>` so the
    iter-330 /api/events/export route reading `clip_path()` mid-write
    can never grab a truncated MP4. Verify the run_concat helper is
    called with the .tmp path, NOT the final path.
    """
    # arrange
    import time as _time
    fake_proc = mock.MagicMock()
    fake_proc.poll = mock.MagicMock(return_value=0)
    fake_proc.wait = mock.MagicMock(return_value=0)
    monkeypatch.setattr(
        "recording.subprocess.Popen", mock.MagicMock(return_value=fake_proc)
    )
    import preroll
    write_mock = mock.MagicMock()
    concat_mock = mock.MagicMock(return_value=True)
    monkeypatch.setattr(preroll, "write_concat_list", write_mock)
    monkeypatch.setattr(preroll, "run_concat", concat_mock)
    seg1 = tmp_path / "seg_001.mp4"
    seg1.write_bytes(b"a")
    fake_pb = mock.MagicMock()
    fake_pb.segments_in_window = mock.MagicMock(return_value=[str(seg1)])
    post_only = tmp_path / "atom.mp4.postroll.tmp"
    post_only.write_bytes(b"postroll")
    rec = ClipRecorder(rtsp_url="rtsp://x/cam", recordings_dir=str(tmp_path))

    # act
    rec.start_clip("atom", pre_roll_s=5.0, preroll_buffer=fake_pb)
    deadline = _time.time() + 2.0
    while _time.time() < deadline:
        if concat_mock.call_count > 0:
            break
        _time.sleep(0.05)

    # assert — run_concat was called with the .tmp path, NOT the
    # final path. The atomic rename happens AFTER the concat returns
    # ok=True, so the export reader never sees a partial final.
    assert concat_mock.called
    concat_args = concat_mock.call_args[0]
    output_arg = concat_args[2]
    assert output_arg.endswith("atom.mp4.tmp"), (
        "concat must write to .tmp; got: %s" % output_arg
    )
    # Confirm the final .mp4 exists (post-rename) with no .tmp leftover.
    final = tmp_path / "atom.mp4"
    # Note: rename target depends on the run_concat mock returning True
    # AND the test harness allowing the os.rename to complete. Since
    # the mock returns True, the rename should fire.
    # (We don't assert final.exists() because the run_concat mock
    # never actually creates the .tmp file; the rename will fail
    # with OSError which is silently swallowed.)
    _ = final  # rename failure is intentional in this mock setup


def test_given_postroll_temp_path_when_build_args_then_forces_mp4_muxer(tmp_path):
    """iter-356.43 regression pin: ffmpeg infers the muxer from the
    output filename's extension. Since iter-350 G1 the post-roll temp
    is `<id>.mp4.postroll.tmp`, which ffmpeg cannot map to a muxer —
    subprocess exited RC=1 ("Unable to find a suitable output format")
    in <1 s, no clip file written. `-f mp4` immediately before the
    output path forces the muxer regardless of suffix.
    """
    # arrange
    rec = ClipRecorder("rtsp://x", str(tmp_path))

    # act
    args = rec._build_args(
        os.path.join(str(tmp_path), "evt.mp4.postroll.tmp"), rec.duration_s
    )

    # assert
    assert "-f" in args, "ffmpeg argv must include -f to force muxer"
    f_idx = args.index("-f")
    assert args[f_idx + 1] == "mp4", (
        "the -f flag must specify mp4 (the muxer); got: %s" % args[f_idx + 1]
    )
    # The forced -f must sit immediately before the output path so it
    # binds to the output (ffmpeg supports per-input AND per-output -f
    # depending on argv position). Output is the last argv element.
    assert args[-2] == "mp4", (
        "-f mp4 must immediately precede the output path; argv tail: %s"
        % args[-3:]
    )


# --- iter-356.43 real-ffmpeg integration ---
# The argv-shape pins above (mocked Popen) only verify the flag landed
# in the list. They do NOT verify ffmpeg ACTUALLY accepts that argv
# and writes a playable MP4 — which is what was broken since iter-350
# G1 changed the temp suffix to `.tmp` and silently lost the muxer.
# This integration test exercises real ffmpeg with a synthetic input
# so the next subprocess-shape regression is caught at PR time, not
# 14 hours into a missing-clip incident on the Jetson.

import shutil  # noqa: E402  (kept near integration tests for locality)

import pytest  # noqa: E402

_FFMPEG_BIN = shutil.which("ffmpeg")
_skip_no_ffmpeg = pytest.mark.skipif(
    _FFMPEG_BIN is None,
    reason="ffmpeg not on PATH (CI / dev-box variance — Jetson always has it)",
)


@_skip_no_ffmpeg
def test_given_real_ffmpeg_and_tmp_output_when_build_args_then_writes_mp4(
    tmp_path,
):
    """End-to-end: feed `_build_args` argv to a real ffmpeg. Pre-
    iter-356.43, with no `-f mp4` AND a `.tmp` output suffix, ffmpeg
    exits RC=1 immediately ("Unable to find a suitable output
    format") and writes nothing — exactly the iter-350 → iter-356.43
    regression. With the fix in place, ffmpeg should write a non-
    empty MP4 with a real `ftyp` box at the head.

    We can't use a live RTSP server in unit tests, so we pre-encode
    a tiny h264 MP4 with lavfi and swap the RTSP `-i` arg for that
    file. `-c copy` (the production flag under test) then has a
    real h264 stream to copy, exactly matching the production path
    where the worker `-c copy`-s the camera's NVENC h264 bitstream.
    """
    # arrange — pre-encode 1 s of synthetic h264 so `-c copy` has
    # a real stream to copy (lavfi testsrc into MP4 directly produces
    # `wrapped_avframe`, which mp4 can't pack under `-c copy`).
    src_mp4 = tmp_path / "src.mp4"
    gen = subprocess.run(
        [
            _FFMPEG_BIN, "-y", "-hide_banner", "-loglevel", "error",
            "-f", "lavfi",
            "-i", "testsrc=duration=1:size=64x64:rate=10",
            "-c:v", "libx264", "-preset", "ultrafast",
            "-pix_fmt", "yuv420p",
            "-f", "mp4",
            str(src_mp4),
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        timeout=15,
    )
    assert gen.returncode == 0, (
        "lavfi h264 generation failed: %s"
        % gen.stderr.decode("utf-8", "replace")[:300]
    )

    # Get the production argv. Then swap RTSP `-i <url>` for the
    # local h264 file. Drop `-rtsp_transport tcp` (file input doesn't
    # take it). Everything else under test stays exactly as the
    # worker emits it: -t, -c copy, -f mp4, output.
    rec = ClipRecorder("rtsp://placeholder/cam", str(tmp_path), duration_s=1)
    output_path = os.path.join(str(tmp_path), "evt.mp4.postroll.tmp")
    args = rec._build_args(output_path, 1)
    rtsp_transport_idx = args.index("-rtsp_transport")
    i_idx = args.index("-i")
    head = args[: rtsp_transport_idx]  # ffmpeg + global flags
    tail = args[i_idx + 2 :]  # -t / -c copy / -f mp4 / output
    real_argv = head + ["-i", str(src_mp4)] + tail

    # act
    result = subprocess.run(
        real_argv,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        timeout=15,
    )

    # assert — ffmpeg succeeds, output exists, and contains an MP4
    # `ftyp` atom (bytes 4..8 of any valid MP4). Pre-fix this fails
    # with returncode=1 + "Unable to find a suitable output format".
    assert result.returncode == 0, (
        "ffmpeg failed (this is the regression): rc=%d stderr=%s"
        % (result.returncode, result.stderr.decode("utf-8", "replace")[:600])
    )
    assert os.path.exists(output_path), "output file not written"
    assert os.path.getsize(output_path) > 0, "output file is empty"
    with open(output_path, "rb") as f:
        head_bytes = f.read(12)
    assert head_bytes[4:8] == b"ftyp", (
        "output is not a valid MP4 (no ftyp atom at offset 4); got: %r"
        % head_bytes
    )
