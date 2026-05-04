"""Unit tests for the iter-323 PrerollBuffer.

Run from `detection/`:
    /tmp/homecam-venv/bin/python -m pytest tests/test_preroll.py -q

Pure-Python module — no jetson_inference / jetson_utils imports.
Tests stub subprocess via monkeypatch + use real tmp dirs for the
segment-file logic.

iter-323 (Feature #1 slice 2c, top missing-feature gap from the
iter-322 discovery agent): pre-event video buffer.
"""
import os
import sys
import time
from pathlib import Path
from unittest.mock import MagicMock

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from preroll import (
    DEFAULT_CAPACITY,
    DEFAULT_SEGMENT_S,
    PrerollBuffer,
    run_concat,
    write_concat_list,
)


def test_given_default_construction_then_segment_and_capacity_defaults_apply(tmp_path):
    # arrange + act
    pb = PrerollBuffer(
        rtsp_url="rtsp://localhost:8554/cam",
        buffer_dir=str(tmp_path / "preroll"),
    )

    # assert
    assert pb.segment_s == DEFAULT_SEGMENT_S
    assert pb.capacity == DEFAULT_CAPACITY
    assert pb.is_alive() is False


def test_when_build_args_called_then_segment_muxer_args_present(tmp_path):
    # arrange
    pb = PrerollBuffer(
        rtsp_url="rtsp://localhost:8554/cam",
        buffer_dir=str(tmp_path / "preroll"),
        segment_s=2,
        capacity=8,
    )

    # act
    args = pb._build_args()

    # assert — `-c copy` (no re-encode), segment muxer with the
    # right wrap + reset_timestamps for clean concat.
    assert "-c" in args and "copy" in args
    assert "-f" in args and "segment" in args
    assert "-segment_time" in args
    assert "2" in args  # the segment_s value
    assert "-segment_wrap" in args
    assert "8" in args  # the capacity value
    assert "-reset_timestamps" in args
    # rtsp transport is tcp (matches iter-202 ClipRecorder).
    assert "-rtsp_transport" in args and "tcp" in args


def test_given_start_when_subprocess_spawn_succeeds_then_is_alive_true(
    tmp_path, monkeypatch
):
    # arrange — fake subprocess that "stays alive" (poll returns None).
    fake_proc = MagicMock()
    fake_proc.poll = MagicMock(return_value=None)
    pb = PrerollBuffer(
        rtsp_url="rtsp://localhost:8554/cam",
        buffer_dir=str(tmp_path / "preroll"),
    )
    monkeypatch.setattr(
        "preroll.subprocess.Popen", MagicMock(return_value=fake_proc)
    )

    # act
    ok = pb.start()

    # assert
    assert ok is True
    assert pb.is_alive() is True


def test_given_start_when_ffmpeg_binary_missing_then_start_returns_false(
    tmp_path, monkeypatch
):
    # arrange
    pb = PrerollBuffer(
        rtsp_url="rtsp://localhost:8554/cam",
        buffer_dir=str(tmp_path / "preroll"),
        ffmpeg_bin="/nonexistent/ffmpeg",
    )

    def raise_oserror(*a, **k):
        raise FileNotFoundError("ffmpeg not found")

    monkeypatch.setattr("preroll.subprocess.Popen", raise_oserror)

    # act
    ok = pb.start()

    # assert
    assert ok is False
    assert pb.is_alive() is False


def test_given_already_running_when_start_called_then_returns_true_idempotent(
    tmp_path, monkeypatch
):
    # arrange
    fake_proc = MagicMock()
    fake_proc.poll = MagicMock(return_value=None)
    pb = PrerollBuffer(
        rtsp_url="rtsp://localhost:8554/cam",
        buffer_dir=str(tmp_path / "preroll"),
    )
    popen = MagicMock(return_value=fake_proc)
    monkeypatch.setattr("preroll.subprocess.Popen", popen)
    pb.start()
    assert popen.call_count == 1

    # act — call start again.
    ok = pb.start()

    # assert — no second Popen.
    assert ok is True
    assert popen.call_count == 1


def test_when_stop_called_on_running_then_terminate_invoked(
    tmp_path, monkeypatch
):
    # arrange
    fake_proc = MagicMock()
    fake_proc.poll = MagicMock(return_value=None)
    fake_proc.wait = MagicMock(return_value=0)
    pb = PrerollBuffer(
        rtsp_url="rtsp://localhost:8554/cam",
        buffer_dir=str(tmp_path / "preroll"),
    )
    monkeypatch.setattr(
        "preroll.subprocess.Popen", MagicMock(return_value=fake_proc)
    )
    pb.start()

    # act
    ok = pb.stop()

    # assert
    assert ok is True
    fake_proc.terminate.assert_called_once()


def test_when_segments_in_window_called_with_no_dir_then_returns_empty(tmp_path):
    # arrange — buffer dir doesn't exist yet.
    pb = PrerollBuffer(
        rtsp_url="rtsp://localhost:8554/cam",
        buffer_dir=str(tmp_path / "missing"),
    )

    # act
    result = pb.segments_in_window(now=time.time(), pre_roll_s=5)

    # assert
    assert result == []


def test_when_segments_in_window_called_with_real_files_then_returns_those_in_range(tmp_path):
    # arrange — write 5 fake segments with mtimes spread across 10 s.
    buffer = tmp_path / "preroll"
    buffer.mkdir()
    pb = PrerollBuffer(
        rtsp_url="rtsp://localhost:8554/cam",
        buffer_dir=str(buffer),
        segment_s=1,
    )
    now = time.time()
    # mtimes: now-10, now-7, now-4, now-2, now-0.5
    times = [now - 10, now - 7, now - 4, now - 2, now - 0.5]
    for i, m in enumerate(times):
        p = buffer / "seg_{:03d}.mp4".format(i)
        p.write_bytes(b"fake")
        os.utime(str(p), (m, m))

    # act — request the last 5 s of pre-roll.
    result = pb.segments_in_window(now=now, pre_roll_s=5)

    # assert — segments at now-4, now-2, now-0.5 are in window;
    # over-include at the boundary so segments within `segment_s`
    # of the cutoff are included too. now-7 is OUTSIDE the
    # cutoff-segment_s = now-6 boundary so it's excluded.
    names = [os.path.basename(p) for p in result]
    assert "seg_002.mp4" in names  # now-4 (in window)
    assert "seg_003.mp4" in names  # now-2 (in window)
    assert "seg_004.mp4" in names  # now-0.5 (in window)
    assert "seg_001.mp4" not in names  # now-7 (older than cutoff)
    assert "seg_000.mp4" not in names  # now-10 (way older)


def test_when_segments_in_window_returns_paths_then_sorted_chronologically(tmp_path):
    # arrange — write segments with deliberately-out-of-order mtimes
    # to verify the sort step (filesystem listing order is undefined).
    buffer = tmp_path / "preroll"
    buffer.mkdir()
    pb = PrerollBuffer(
        rtsp_url="rtsp://localhost:8554/cam",
        buffer_dir=str(buffer),
        segment_s=1,
    )
    now = time.time()
    # Names assigned out of mtime order on purpose.
    (buffer / "seg_010.mp4").write_bytes(b"a"); os.utime(str(buffer / "seg_010.mp4"), (now - 0.5, now - 0.5))
    (buffer / "seg_005.mp4").write_bytes(b"b"); os.utime(str(buffer / "seg_005.mp4"), (now - 2, now - 2))
    (buffer / "seg_007.mp4").write_bytes(b"c"); os.utime(str(buffer / "seg_007.mp4"), (now - 1, now - 1))

    # act
    result = pb.segments_in_window(now=now, pre_roll_s=5)

    # assert — chronological by mtime, so seg_005 (oldest) first.
    names = [os.path.basename(p) for p in result]
    assert names == ["seg_005.mp4", "seg_007.mp4", "seg_010.mp4"]


def test_when_segments_in_window_filters_non_segment_files(tmp_path):
    # arrange — drop a non-segment file alongside real segments.
    buffer = tmp_path / "preroll"
    buffer.mkdir()
    pb = PrerollBuffer(
        rtsp_url="rtsp://localhost:8554/cam",
        buffer_dir=str(buffer),
    )
    now = time.time()
    (buffer / "seg_001.mp4").write_bytes(b"real")
    os.utime(str(buffer / "seg_001.mp4"), (now - 1, now - 1))
    (buffer / "README.txt").write_bytes(b"junk")
    (buffer / "subdir").mkdir()

    # act
    result = pb.segments_in_window(now=now, pre_roll_s=5)

    # assert — only the seg_*.mp4 file.
    assert len(result) == 1
    assert "seg_001.mp4" in result[0]


def test_when_write_concat_list_called_then_file_format_correct(tmp_path):
    # arrange
    list_path = tmp_path / "list.txt"
    paths = [
        str(tmp_path / "a.mp4"),
        str(tmp_path / "b.mp4"),
    ]

    # act
    write_concat_list(str(list_path), paths)

    # assert — ffmpeg concat-demuxer format: one `file '<path>'`
    # line per input.
    content = list_path.read_text()
    assert "file '" in content
    assert "a.mp4" in content
    assert "b.mp4" in content


def test_when_run_concat_invokes_ffmpeg_then_returns_true_on_success(
    tmp_path, monkeypatch
):
    # arrange
    list_path = tmp_path / "list.txt"
    list_path.write_text("file 'foo.mp4'\n")
    out = tmp_path / "out.mp4"
    fake_result = MagicMock()
    fake_result.returncode = 0
    monkeypatch.setattr(
        "preroll.subprocess.run", MagicMock(return_value=fake_result)
    )

    # act
    ok = run_concat("ffmpeg", str(list_path), str(out))

    # assert
    assert ok is True


def test_when_run_concat_ffmpeg_missing_then_returns_false(tmp_path, monkeypatch):
    # arrange
    list_path = tmp_path / "list.txt"
    list_path.write_text("file 'foo.mp4'\n")
    out = tmp_path / "out.mp4"
    monkeypatch.setattr(
        "preroll.subprocess.run",
        MagicMock(side_effect=FileNotFoundError("ffmpeg")),
    )

    # act
    ok = run_concat("ffmpeg", str(list_path), str(out))

    # assert
    assert ok is False


def test_when_run_concat_ffmpeg_returns_nonzero_then_returns_false(
    tmp_path, monkeypatch
):
    # arrange
    list_path = tmp_path / "list.txt"
    list_path.write_text("file 'foo.mp4'\n")
    out = tmp_path / "out.mp4"
    fake_result = MagicMock()
    fake_result.returncode = 1
    fake_result.stderr = b"bad input"
    monkeypatch.setattr(
        "preroll.subprocess.run", MagicMock(return_value=fake_result)
    )

    # act
    ok = run_concat("ffmpeg", str(list_path), str(out))

    # assert
    assert ok is False


# iter-325 (Feature #1 slice 2c follow-up): start_watchdog spawns a
# daemon thread that polls is_alive() and re-spawns the subprocess
# when it has died (e.g. mediamtx restart drops the RTSP source).

def test_when_start_watchdog_called_then_re_starts_dead_subprocess(
    tmp_path, monkeypatch,
):
    """Simulate a dead subprocess + wait briefly + verify the
    watchdog called start() to spawn a fresh one."""
    # arrange — first Popen returns a "dead" proc (poll != None);
    # second Popen returns a live one. The watchdog should fire on
    # the first poll-check and call start() → second Popen.
    import time as _time
    dead_proc = MagicMock()
    dead_proc.poll = MagicMock(return_value=1)  # already exited
    live_proc = MagicMock()
    live_proc.poll = MagicMock(return_value=None)
    popen_mock = MagicMock(side_effect=[dead_proc, live_proc])
    monkeypatch.setattr("preroll.subprocess.Popen", popen_mock)
    pb = PrerollBuffer(
        rtsp_url="rtsp://localhost:8554/cam",
        buffer_dir=str(tmp_path / "preroll"),
    )
    pb.start()  # spawns dead_proc
    assert pb.is_alive() is False  # dead immediately

    # act — start the watchdog with a fast cadence + wait for one poll
    pb.start_watchdog(interval_s=1.0)
    deadline = _time.time() + 4.0
    while _time.time() < deadline:
        if popen_mock.call_count >= 2:
            break
        _time.sleep(0.1)

    # assert — Popen called a second time (the restart).
    assert popen_mock.call_count >= 2
    # Cleanup so the daemon thread doesn't keep polling.
    pb.stop()


def test_when_start_watchdog_called_twice_then_only_one_thread_started(
    tmp_path, monkeypatch,
):
    """Idempotent — re-arming the watchdog is a no-op."""
    # arrange
    fake_proc = MagicMock()
    fake_proc.poll = MagicMock(return_value=None)
    monkeypatch.setattr(
        "preroll.subprocess.Popen", MagicMock(return_value=fake_proc)
    )
    pb = PrerollBuffer(
        rtsp_url="rtsp://localhost:8554/cam",
        buffer_dir=str(tmp_path / "preroll"),
    )
    pb.start()

    # act
    t1 = pb.start_watchdog(interval_s=10.0)
    t2 = pb.start_watchdog(interval_s=10.0)

    # assert — second call returns None (no new thread).
    assert t1 is not None
    assert t2 is None
    pb.stop()


def test_when_stop_called_then_watchdog_thread_exits(tmp_path, monkeypatch):
    """The watchdog daemon thread polls every interval — when stop()
    flips _watchdog_running, the loop must exit promptly. Tests the
    coordinated-shutdown contract."""
    # arrange
    import time as _time
    fake_proc = MagicMock()
    fake_proc.poll = MagicMock(return_value=None)
    fake_proc.wait = MagicMock(return_value=0)
    monkeypatch.setattr(
        "preroll.subprocess.Popen", MagicMock(return_value=fake_proc)
    )
    pb = PrerollBuffer(
        rtsp_url="rtsp://localhost:8554/cam",
        buffer_dir=str(tmp_path / "preroll"),
    )
    pb.start()
    t = pb.start_watchdog(interval_s=0.5)
    assert t is not None
    _time.sleep(0.2)
    assert t.is_alive() is True

    # act
    pb.stop()
    # Wait up to 2 s for the thread to notice + exit.
    t.join(timeout=2.0)

    # assert
    assert t.is_alive() is False


def test_given_tmp_output_path_when_run_concat_then_forces_mp4_muxer(
    tmp_path, monkeypatch
):
    """iter-356.43 regression pin: the concat output is
    `<final>.tmp` (iter-350 G2's atomic-rename merge target); ffmpeg
    cannot infer the muxer from `.tmp` and would exit RC=1 with
    "Unable to find a suitable output format". `-f mp4` immediately
    before the output path forces the muxer. Note `run_concat`
    already passes `-f concat` for the input demuxer; the SECOND
    `-f mp4` (after `-i list_path`) binds to the OUTPUT.
    """
    # arrange
    list_path = tmp_path / "list.txt"
    list_path.write_text("file 'foo.mp4'\n")
    out = tmp_path / "evt.mp4.tmp"
    fake_result = MagicMock()
    fake_result.returncode = 0
    captured = MagicMock(return_value=fake_result)
    monkeypatch.setattr("preroll.subprocess.run", captured)

    # act
    run_concat("ffmpeg", str(list_path), str(out))

    # assert
    cmd = captured.call_args[0][0]
    # Two `-f` flags expected: `-f concat` for input, `-f mp4` for output.
    f_indices = [i for i, a in enumerate(cmd) if a == "-f"]
    assert len(f_indices) == 2, (
        "expected two -f flags (input concat + output mp4); got: %s" % cmd
    )
    # The second `-f` must be `mp4` and sit immediately before the output.
    assert cmd[f_indices[1] + 1] == "mp4"
    assert cmd[-1] == str(out), (
        "output path must be the last argv element; got: %s" % cmd[-1]
    )
    assert cmd[-2] == "mp4", (
        "-f mp4 must immediately precede the output path; argv tail: %s"
        % cmd[-3:]
    )


# --- iter-356.43 real-ffmpeg integration ---
# Same rationale as test_recording.py's integration block: the mocked
# argv test above only proves the flag is in the list. Below, we run
# the real `run_concat` against real ffmpeg with real lavfi-generated
# segments, writing to a `.tmp` output path. Pre-fix this fails
# (returncode=1, no file) — exactly how the production bug manifested.

import shutil as _shutil  # noqa: E402
import subprocess  # noqa: E402

_FFMPEG_BIN = _shutil.which("ffmpeg")
_skip_no_ffmpeg = pytest.mark.skipif(
    _FFMPEG_BIN is None,
    reason="ffmpeg not on PATH (CI / dev-box variance — Jetson always has it)",
)


@_skip_no_ffmpeg
def test_given_real_ffmpeg_and_tmp_output_when_run_concat_then_writes_mp4(
    tmp_path,
):
    """End-to-end: generate two tiny MP4 segments via lavfi, write a
    concat list, call `run_concat` with a `.tmp` output — pre-iter-
    356.43 ffmpeg can't infer the muxer from `.tmp` and the merge
    silently fails, leaving every detection event clipless.
    """
    # arrange — make two real 0.5 s mp4 segments via lavfi.
    seg_paths = []
    for i in range(2):
        seg_path = tmp_path / ("seg_{:03d}.mp4".format(i))
        gen = subprocess.run(
            [
                _FFMPEG_BIN, "-y", "-hide_banner", "-loglevel", "error",
                "-f", "lavfi",
                "-i", "testsrc=duration=0.5:size=64x64:rate=10",
                "-c:v", "libx264", "-preset", "ultrafast",
                "-pix_fmt", "yuv420p",
                "-f", "mp4",
                str(seg_path),
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            timeout=15,
        )
        assert gen.returncode == 0, (
            "lavfi seg generation failed: %s"
            % gen.stderr.decode("utf-8", "replace")[:300]
        )
        seg_paths.append(str(seg_path))
    list_path = tmp_path / "concat.txt"
    write_concat_list(str(list_path), seg_paths)
    # The output uses the production `.tmp` suffix exactly as
    # `recording.py` constructs it for the merge target.
    output_path = tmp_path / "evt.mp4.tmp"

    # act
    ok = run_concat(_FFMPEG_BIN, str(list_path), str(output_path))

    # assert
    assert ok is True, "run_concat returned False — ffmpeg rejected the argv"
    assert output_path.exists(), "concat output file not written"
    assert output_path.stat().st_size > 0, "concat output file is empty"
    with open(str(output_path), "rb") as f:
        head_bytes = f.read(12)
    assert head_bytes[4:8] == b"ftyp", (
        "output is not a valid MP4 (no ftyp atom at offset 4); got: %r"
        % head_bytes
    )
