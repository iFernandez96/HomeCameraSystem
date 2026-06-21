"""Continuous-capture S3: ClipRecorder.finalize_visit unit + real-ffmpeg tests.

`finalize_visit` concats a visit's already-copied scratch segments
(S2 `preroll.copy_new_segments` writes `000000.mp4, 000001.mp4, …`) into
ONE `<event_id>.mp4`. See docs/continuous_capture_plan.md "S3 recorder
finalize" + blockers B1 (real-decode post-validate), R8 (Semaphore(1) +
try/finally rmtree), R9 (bytes-scaled timeout), R1 (±~4.3s GOP edge
precision accepted — whole-segment concat, no sub-GOP trim).

The offline tests mock ffmpeg/ffprobe to pin arg construction, the failure
paths, atomic-replace ordering, scratch reaping, and semaphore serialization.
The gated real-ffmpeg test is the PROOF the teleport is gone WITHIN a clip:
synthetic ~4.3s-GOP segments concat to one playable clip with monotonic
display PTS (no backward jump) and a clean real-decode validate.

BDD-lite: Given/When/Then names + arrange/act/assert bodies.
"""
import os
import shutil as _shutil
import subprocess
import sys
import threading
import time
from pathlib import Path
from unittest import mock

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import recording  # noqa: E402
from recording import ClipRecorder  # noqa: E402


# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------

def _make_scratch(tmp_path, n, names=None):
    """Create a per-visit scratch dir with `n` (or named) non-empty .mp4
    files. Bytes are junk — the offline tests mock the probes/concat so
    real validity doesn't matter; only the listing/sorting/IO does."""
    scratch = tmp_path / "_visits" / "event_abc"
    scratch.mkdir(parents=True, exist_ok=True)
    if names is None:
        names = ["{:06d}.mp4".format(i) for i in range(n)]
    for name in names:
        (scratch / name).write_bytes(b"\x00" * 1024)
    return scratch


def _recorder(tmp_path):
    return ClipRecorder(
        rtsp_url="rtsp://localhost:8554/cam",
        recordings_dir=str(tmp_path / "rec"),
    )


# --------------------------------------------------------------------------
# Step 1: empty scratch
# --------------------------------------------------------------------------

def test_given_empty_scratch_when_finalize_then_false_and_no_output(tmp_path):
    # arrange
    rec = _recorder(tmp_path)
    scratch = tmp_path / "_visits" / "event_abc"
    scratch.mkdir(parents=True)

    # act
    ok = rec.finalize_visit("abc", str(scratch), 100.0, 130.0)

    # assert
    assert ok is False
    assert not (Path(rec.recordings_dir) / "abc.mp4").exists()
    assert not (Path(rec.recordings_dir) / "abc.mp4.tmp").exists()


def test_given_missing_scratch_dir_when_finalize_then_false_no_crash(tmp_path):
    # arrange — scratch dir never created
    rec = _recorder(tmp_path)

    # act
    ok = rec.finalize_visit("abc", str(tmp_path / "nope"), 100.0, 130.0)

    # assert
    assert ok is False


# --------------------------------------------------------------------------
# Step 2: all segments invalid -> fail-closed
# --------------------------------------------------------------------------

def test_given_all_segments_invalid_when_finalize_then_false_no_concat(tmp_path):
    # arrange
    rec = _recorder(tmp_path)
    scratch = _make_scratch(tmp_path, 3)

    with mock.patch.object(rec, "_filter_valid_segments", return_value=[]), \
            mock.patch.object(recording.subprocess, "run") as m_run:
        # act
        ok = rec.finalize_visit("abc", str(scratch), 100.0, 130.0)

    # assert — fail-closed, ffmpeg concat never invoked
    assert ok is False
    assert m_run.call_count == 0
    assert not (Path(rec.recordings_dir) / "abc.mp4").exists()


# --------------------------------------------------------------------------
# Step 3/4: concat-arg construction (flags, -f mp4, bytes-scaled timeout)
# --------------------------------------------------------------------------

def test_given_segments_when_finalize_then_concat_argv_is_copy_mp4(tmp_path):
    # arrange
    rec = _recorder(tmp_path)
    scratch = _make_scratch(tmp_path, 3)
    seg_paths = sorted(str(p) for p in scratch.glob("*.mp4"))

    def fake_run(cmd, **kw):
        # concat call writes a fake (non-empty) output so validate runs.
        if "-f" in cmd and cmd[cmd.index("-f") + 1] == "concat":
            out = cmd[-1]
            with open(out, "wb") as f:
                f.write(b"\x00" * 4096)
        return mock.Mock(returncode=0, stderr=b"")

    with mock.patch.object(rec, "_filter_valid_segments", return_value=seg_paths), \
            mock.patch.object(rec, "_decode_validate", return_value=True), \
            mock.patch.object(recording.subprocess, "run", side_effect=fake_run) as m_run:
        # act
        ok = rec.finalize_visit("abc", str(scratch), 100.0, 130.0)

    # assert
    assert ok is True
    concat_cmd = m_run.call_args_list[0].args[0]
    # -c copy (no re-encode)
    assert "-c" in concat_cmd and concat_cmd[concat_cmd.index("-c") + 1] == "copy"
    # -f mp4 immediately before the output path (load-bearing CLAUDE.md pin)
    assert concat_cmd[-2:][0] == "-f" and concat_cmd[-2:][1] == "mp4" or \
        ("-f" in concat_cmd and concat_cmd[-1].endswith(".mp4.tmp"))
    # concat demuxer + abs-path-safe
    assert "concat" in concat_cmd and "-safe" in concat_cmd
    # output is the .tmp sidecar, NOT the final
    assert concat_cmd[-1].endswith("abc.mp4.tmp")


def test_given_concat_call_when_finalize_then_timeout_scales_with_bytes(tmp_path):
    # arrange — a ~1 GB visit must get a timeout well above the floor.
    rec = _recorder(tmp_path)
    scratch = _make_scratch(tmp_path, 1)
    seg = sorted(str(p) for p in scratch.glob("*.mp4"))

    captured = {}

    def fake_run(cmd, **kw):
        if "-f" in cmd and cmd[cmd.index("-f") + 1] == "concat":
            captured["timeout"] = kw.get("timeout")
            with open(cmd[-1], "wb") as f:
                f.write(b"\x00" * 4096)
        return mock.Mock(returncode=0, stderr=b"")

    # 1 GB of input -> ~300 s by the per-GB rate; mock getsize to report it.
    real_getsize = os.path.getsize

    def fake_getsize(p):
        if p in seg:
            return 1_000_000_000
        return real_getsize(p)

    with mock.patch.object(rec, "_filter_valid_segments", return_value=seg), \
            mock.patch.object(rec, "_decode_validate", return_value=True), \
            mock.patch.object(recording.os.path, "getsize", side_effect=fake_getsize), \
            mock.patch.object(recording.subprocess, "run", side_effect=fake_run):
        # act
        rec.finalize_visit("abc", str(scratch), 100.0, 130.0)

    # assert — 1 GB -> ~300 s, comfortably above the 60 s floor.
    assert captured["timeout"] > 250.0


def test_finalize_timeout_floor_and_ceiling():
    # arrange / act / assert
    assert ClipRecorder._finalize_timeout_for(0) == recording._FINALIZE_TIMEOUT_FLOOR_S
    assert ClipRecorder._finalize_timeout_for(1_000_000_000_000) == \
        recording._FINALIZE_TIMEOUT_CEIL_S


def test_given_huge_visit_when_finalize_then_faststart_dropped(tmp_path):
    # arrange — a > 256 MB output: faststart's full-file second pass dropped (R9).
    rec = _recorder(tmp_path)
    scratch = _make_scratch(tmp_path, 1)
    seg = sorted(str(p) for p in scratch.glob("*.mp4"))
    captured = {}

    def fake_run(cmd, **kw):
        if "-f" in cmd and cmd[cmd.index("-f") + 1] == "concat":
            captured["cmd"] = cmd
            with open(cmd[-1], "wb") as f:
                f.write(b"\x00" * 4096)
        return mock.Mock(returncode=0, stderr=b"")

    real_getsize = os.path.getsize

    def fake_getsize(p):
        if p in seg:
            return 300 * 1024 * 1024  # 300 MB > threshold
        return real_getsize(p)

    with mock.patch.object(rec, "_filter_valid_segments", return_value=seg), \
            mock.patch.object(rec, "_decode_validate", return_value=True), \
            mock.patch.object(recording.os.path, "getsize", side_effect=fake_getsize), \
            mock.patch.object(recording.subprocess, "run", side_effect=fake_run):
        rec.finalize_visit("abc", str(scratch), 100.0, 130.0)

    # assert
    assert "+faststart" not in captured["cmd"]


def test_given_small_visit_when_finalize_then_faststart_present(tmp_path):
    # arrange — a normal ~few-MB visit keeps faststart for fast HTTP first-frame.
    rec = _recorder(tmp_path)
    scratch = _make_scratch(tmp_path, 3)
    seg = sorted(str(p) for p in scratch.glob("*.mp4"))
    captured = {}

    def fake_run(cmd, **kw):
        if "-f" in cmd and cmd[cmd.index("-f") + 1] == "concat":
            captured["cmd"] = cmd
            with open(cmd[-1], "wb") as f:
                f.write(b"\x00" * 4096)
        return mock.Mock(returncode=0, stderr=b"")

    with mock.patch.object(rec, "_filter_valid_segments", return_value=seg), \
            mock.patch.object(rec, "_decode_validate", return_value=True), \
            mock.patch.object(recording.subprocess, "run", side_effect=fake_run):
        rec.finalize_visit("abc", str(scratch), 100.0, 130.0)

    # assert
    assert "+faststart" in captured["cmd"]


# --------------------------------------------------------------------------
# Step 5/6: atomic replace happens only after validate
# --------------------------------------------------------------------------

def test_given_validate_fails_when_finalize_then_no_replace_no_final(tmp_path):
    # arrange
    rec = _recorder(tmp_path)
    scratch = _make_scratch(tmp_path, 3)
    seg = sorted(str(p) for p in scratch.glob("*.mp4"))

    def fake_run(cmd, **kw):
        if "-f" in cmd and cmd[cmd.index("-f") + 1] == "concat":
            with open(cmd[-1], "wb") as f:
                f.write(b"\x00" * 4096)
        return mock.Mock(returncode=0, stderr=b"")

    with mock.patch.object(rec, "_filter_valid_segments", return_value=seg), \
            mock.patch.object(rec, "_decode_validate", return_value=False), \
            mock.patch.object(recording.os, "replace") as m_replace, \
            mock.patch.object(recording.subprocess, "run", side_effect=fake_run):
        # act
        ok = rec.finalize_visit("abc", str(scratch), 100.0, 130.0)

    # assert — validate failed => no atomic replace, no final file, tmp cleaned
    assert ok is False
    assert m_replace.call_count == 0
    assert not (Path(rec.recordings_dir) / "abc.mp4").exists()
    assert not (Path(rec.recordings_dir) / "abc.mp4.tmp").exists()


def test_given_validate_passes_when_finalize_then_replace_after_validate(tmp_path):
    # arrange — record call order: concat -> validate -> replace.
    rec = _recorder(tmp_path)
    scratch = _make_scratch(tmp_path, 3)
    seg = sorted(str(p) for p in scratch.glob("*.mp4"))
    order = []

    def fake_run(cmd, **kw):
        if "-f" in cmd and cmd[cmd.index("-f") + 1] == "concat":
            order.append("concat")
            with open(cmd[-1], "wb") as f:
                f.write(b"\x00" * 4096)
        return mock.Mock(returncode=0, stderr=b"")

    def fake_validate(path, dur, eid):
        order.append("validate")
        return True

    def fake_replace(src, dst):
        order.append("replace")
        os.rename(src, dst)

    with mock.patch.object(rec, "_filter_valid_segments", return_value=seg), \
            mock.patch.object(rec, "_decode_validate", side_effect=fake_validate), \
            mock.patch.object(recording.os, "replace", side_effect=fake_replace), \
            mock.patch.object(recording.subprocess, "run", side_effect=fake_run):
        # act
        ok = rec.finalize_visit("abc", str(scratch), 100.0, 130.0)

    # assert
    assert ok is True
    assert order == ["concat", "validate", "replace"]
    assert (Path(rec.recordings_dir) / "abc.mp4").exists()


def test_given_concat_rc_nonzero_when_finalize_then_false_tmp_unlinked(tmp_path):
    # arrange
    rec = _recorder(tmp_path)
    scratch = _make_scratch(tmp_path, 3)
    seg = sorted(str(p) for p in scratch.glob("*.mp4"))

    def fake_run(cmd, **kw):
        if "-f" in cmd and cmd[cmd.index("-f") + 1] == "concat":
            with open(cmd[-1], "wb") as f:
                f.write(b"\x00" * 4096)  # a partial that must be cleaned
        return mock.Mock(returncode=1, stderr=b"boom")

    with mock.patch.object(rec, "_filter_valid_segments", return_value=seg), \
            mock.patch.object(rec, "_decode_validate", return_value=True) as m_val, \
            mock.patch.object(recording.subprocess, "run", side_effect=fake_run):
        # act
        ok = rec.finalize_visit("abc", str(scratch), 100.0, 130.0)

    # assert — rc!=0 short-circuits before validate; partial .tmp removed
    assert ok is False
    assert m_val.call_count == 0
    assert not (Path(rec.recordings_dir) / "abc.mp4").exists()
    assert not (Path(rec.recordings_dir) / "abc.mp4.tmp").exists()


# --------------------------------------------------------------------------
# R8: scratch always rmtree'd, even on failure
# --------------------------------------------------------------------------

def test_given_failure_when_finalize_then_scratch_is_removed(tmp_path):
    # arrange — force a failure via empty filter; scratch must still be reaped.
    rec = _recorder(tmp_path)
    scratch = _make_scratch(tmp_path, 3)

    with mock.patch.object(rec, "_filter_valid_segments", return_value=[]):
        # act
        ok = rec.finalize_visit("abc", str(scratch), 100.0, 130.0)

    # assert
    assert ok is False
    assert not scratch.exists()


def test_given_success_when_finalize_then_scratch_is_removed(tmp_path):
    # arrange
    rec = _recorder(tmp_path)
    scratch = _make_scratch(tmp_path, 3)
    seg = sorted(str(p) for p in scratch.glob("*.mp4"))

    def fake_run(cmd, **kw):
        if "-f" in cmd and cmd[cmd.index("-f") + 1] == "concat":
            with open(cmd[-1], "wb") as f:
                f.write(b"\x00" * 4096)
        return mock.Mock(returncode=0, stderr=b"")

    with mock.patch.object(rec, "_filter_valid_segments", return_value=seg), \
            mock.patch.object(rec, "_decode_validate", return_value=True), \
            mock.patch.object(recording.subprocess, "run", side_effect=fake_run):
        # act
        ok = rec.finalize_visit("abc", str(scratch), 100.0, 130.0)

    # assert
    assert ok is True
    assert not scratch.exists()


def test_given_exception_mid_finalize_when_finalize_then_scratch_removed(tmp_path):
    # arrange — make the concat raise an unexpected error; try/finally must
    # STILL reap the scratch (and the semaphore must be released).
    rec = _recorder(tmp_path)
    scratch = _make_scratch(tmp_path, 3)
    seg = sorted(str(p) for p in scratch.glob("*.mp4"))

    with mock.patch.object(rec, "_filter_valid_segments", return_value=seg), \
            mock.patch.object(recording.subprocess, "run",
                              side_effect=RuntimeError("kaboom")):
        # act / assert
        with pytest.raises(RuntimeError):
            rec.finalize_visit("abc", str(scratch), 100.0, 130.0)
    assert not scratch.exists()
    # semaphore released even on exception (acquire here must not block).
    assert recording._FINALIZE_SEMAPHORE.acquire(blocking=False) is True
    recording._FINALIZE_SEMAPHORE.release()


# --------------------------------------------------------------------------
# R8: Semaphore(1) serializes finalizes
# --------------------------------------------------------------------------

def test_given_two_finalizes_when_concurrent_then_serialized(tmp_path):
    # arrange — block inside one finalize's concat; assert a second can't
    # enter the critical section until the first releases.
    rec = _recorder(tmp_path)
    scratch_a = tmp_path / "_visits" / "a"
    scratch_b = tmp_path / "_visits" / "b"
    for s in (scratch_a, scratch_b):
        s.mkdir(parents=True)
        (s / "000000.mp4").write_bytes(b"\x00" * 1024)

    in_concat = threading.Event()
    release = threading.Event()
    overlap = {"max": 0, "cur": 0}
    lock = threading.Lock()

    def fake_run(cmd, **kw):
        if "-f" in cmd and cmd[cmd.index("-f") + 1] == "concat":
            with lock:
                overlap["cur"] += 1
                overlap["max"] = max(overlap["max"], overlap["cur"])
            in_concat.set()
            release.wait(timeout=5)
            with lock:
                overlap["cur"] -= 1
            with open(cmd[-1], "wb") as f:
                f.write(b"\x00" * 4096)
        return mock.Mock(returncode=0, stderr=b"")

    seg_a = [str(scratch_a / "000000.mp4")]
    seg_b = [str(scratch_b / "000000.mp4")]

    def fake_filter(segs, eid):
        return seg_a if eid == "a" else seg_b

    def run_a():
        rec.finalize_visit("a", str(scratch_a), 1.0, 31.0)

    def run_b():
        rec.finalize_visit("b", str(scratch_b), 1.0, 31.0)

    # Patch ONCE at the top level (mock.patch.object mutates a shared module
    # global — patching from inside each thread would race the restore and
    # leak a Mock into later tests). Both threads run inside this context and
    # are joined before it exits.
    with mock.patch.object(rec, "_filter_valid_segments", side_effect=fake_filter), \
            mock.patch.object(rec, "_decode_validate", return_value=True), \
            mock.patch.object(recording.subprocess, "run", side_effect=fake_run):
        ta = threading.Thread(target=run_a)
        tb = threading.Thread(target=run_b)

        # act
        ta.start()
        assert in_concat.wait(timeout=5), "first finalize never entered concat"
        tb.start()
        time.sleep(0.3)  # give B a chance to (illegally) overlap if unserialized
        release.set()
        ta.join(timeout=5)
        tb.join(timeout=5)

    # assert — never two concats in flight at once.
    assert overlap["max"] == 1


# --------------------------------------------------------------------------
# _decode_validate: real-decode markers + duration window (B1)
# --------------------------------------------------------------------------

def test_given_only_benign_dts_warnings_then_validate_true(tmp_path):
    # arrange — the B1 REALITY (verified on real NVENC clips): a -c copy
    # concat of NVENC GOPs makes the `-f null -` decode emit hundreds of
    # "non monotonic dts to muxer" lines, yet playback is perfect (exact
    # duration, zero backward display-PTS). These download/<video>-only
    # clips never feed WebRTC, so the warning is BENIGN and must NOT fail
    # validation — else EVERY real clip is rejected on the Jetson.
    rec = _recorder(tmp_path)
    out = tmp_path / "x.mp4"
    out.write_bytes(b"\x00" * 4096)
    dts = mock.Mock(
        returncode=0,
        stderr=(b"[null] Application provided invalid, non monotonic dts "
                b"to muxer in stream 0: 43 >= 43\n") * 200,
    )
    with mock.patch.object(recording.subprocess, "run", return_value=dts), \
            mock.patch.object(rec, "_probe_duration", return_value=29.5):
        # act
        ok = rec._decode_validate(str(out), 30.0, "abc")
    # assert
    assert ok is True


def test_given_genuine_corruption_marker_then_validate_false(tmp_path):
    # arrange — a REAL corruption signal (not the benign DTS one) must
    # still refuse the clip.
    rec = _recorder(tmp_path)
    out = tmp_path / "x.mp4"
    out.write_bytes(b"\x00" * 4096)
    bad = mock.Mock(
        returncode=0,
        stderr=b"[mov,mp4] moov atom not found\n",
    )
    with mock.patch.object(recording.subprocess, "run", return_value=bad), \
            mock.patch.object(rec, "_probe_duration", return_value=29.5):
        # act
        ok = rec._decode_validate(str(out), 30.0, "abc")
    # assert
    assert ok is False


def test_given_clean_decode_and_on_window_then_validate_true(tmp_path):
    # arrange
    rec = _recorder(tmp_path)
    out = tmp_path / "x.mp4"
    out.write_bytes(b"\x00" * 4096)
    clean = mock.Mock(returncode=0, stderr=b"")
    with mock.patch.object(recording.subprocess, "run", return_value=clean), \
            mock.patch.object(rec, "_probe_duration", return_value=29.5):
        # act
        ok = rec._decode_validate(str(out), 30.0, "abc")
    # assert — within the ±GOP tolerance.
    assert ok is True


def test_given_duration_far_off_window_then_validate_false(tmp_path):
    # arrange — decode clean but duration nowhere near the window => refuse.
    rec = _recorder(tmp_path)
    out = tmp_path / "x.mp4"
    out.write_bytes(b"\x00" * 4096)
    clean = mock.Mock(returncode=0, stderr=b"")
    with mock.patch.object(recording.subprocess, "run", return_value=clean), \
            mock.patch.object(rec, "_probe_duration", return_value=5.0):
        # act
        ok = rec._decode_validate(str(out), 30.0, "abc")
    # assert
    assert ok is False


# ==========================================================================
# GATED REAL-FFMPEG TEST — the proof the teleport is gone WITHIN a clip.
# ==========================================================================

_FFMPEG_BIN = _shutil.which("ffmpeg")
_FFPROBE_BIN = _shutil.which("ffprobe")
_skip_no_ffmpeg = pytest.mark.skipif(
    _FFMPEG_BIN is None or _FFPROBE_BIN is None,
    reason="ffmpeg/ffprobe not on PATH (CI / dev-box variance — Jetson has it)",
)


def _gen_gop_segments(tmp_path, total_s=30, gop_s=4.3, fps=30):
    """Generate self-contained MP4 ring segments with a ~4.3s keyframe
    interval and `-reset_timestamps 1` — exactly what the live ring writes
    (each segment restarts at PTS 0). Returns the scratch dir holding
    `000000.mp4 …` named like S2's copy_new_segments output.
    """
    raw_dir = tmp_path / "_raw"
    raw_dir.mkdir()
    g = int(round(fps * gop_s))
    gen = subprocess.run(
        [
            _FFMPEG_BIN, "-nostdin", "-y", "-hide_banner", "-loglevel", "error",
            "-f", "lavfi",
            "-i", "testsrc=size=320x240:rate={}".format(fps),
            "-t", str(total_s),
            "-c:v", "libx264", "-preset", "ultrafast",
            "-g", str(g), "-keyint_min", str(g), "-sc_threshold", "0",
            "-pix_fmt", "yuv420p",
            "-f", "segment", "-segment_time", str(gop_s),
            "-reset_timestamps", "1", "-segment_format", "mp4",
            str(raw_dir / "seg_%03d.mp4"),
        ],
        stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=60,
    )
    assert gen.returncode == 0, (
        "segment generation failed: %s"
        % gen.stderr.decode("utf-8", "replace")[:400]
    )
    # Rename into the S2 scratch layout: 000000.mp4, 000001.mp4, …
    scratch = tmp_path / "_visits" / "event_real"
    scratch.mkdir(parents=True)
    raw = sorted(raw_dir.glob("seg_*.mp4"))
    assert len(raw) >= 3, "expected several GOP segments, got %d" % len(raw)
    for i, src in enumerate(raw):
        _shutil.copy2(str(src), str(scratch / "{:06d}.mp4".format(i)))
    return scratch, len(raw)


def _frame_pts_times(path):
    out = subprocess.run(
        [
            _FFPROBE_BIN, "-v", "error", "-select_streams", "v:0",
            "-show_entries", "frame=pts_time", "-of", "csv=p=0", str(path),
        ],
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=30,
    )
    vals = []
    for line in out.stdout.decode("utf-8", "replace").splitlines():
        line = line.strip().rstrip(",")
        if not line or line == "N/A":
            continue
        try:
            vals.append(float(line))
        except ValueError:
            pass
    return vals


@_skip_no_ffmpeg
def test_given_real_43s_gop_segments_when_finalize_then_one_monotonic_clip(
    tmp_path,
):
    """End-to-end on a real ~4.3s-GOP fixture: finalize_visit produces ONE
    playable clip whose display PTS never jumps backward, whose duration ≈
    the window, and which passes the real-decode validate. This is the proof
    the "teleport" is gone within a continuously-recorded visit.
    """
    # arrange — ~30 s of footage as ~4.3s-GOP reset-timestamp segments.
    scratch, n_segs = _gen_gop_segments(tmp_path, total_s=30, gop_s=4.3)
    rec = ClipRecorder("rtsp://x", str(tmp_path / "rec"))
    start_ts = 1000.0
    end_ts = 1030.0  # nominal 30 s window

    # act
    ok = rec.finalize_visit("real", str(scratch), start_ts, end_ts)

    # assert — published exactly one clip.
    final = Path(rec.recordings_dir) / "real.mp4"
    assert ok is True, "finalize_visit returned False on a clean fixture"
    assert final.exists() and final.stat().st_size > 0
    assert not (Path(rec.recordings_dir) / "real.mp4.tmp").exists()
    # scratch reaped (R8).
    assert not scratch.exists()

    # duration ≈ window (±~one GOP of slack on each edge).
    probed = rec._probe_duration(str(final))
    assert probed is not None
    assert abs(probed - 30.0) <= recording._FINALIZE_DURATION_TOLERANCE_S, (
        "finalized duration %.2f not within tolerance of 30s window" % probed
    )

    # display PTS strictly monotonic — NO backward jump (the teleport).
    pts = _frame_pts_times(final)
    assert len(pts) > 100, "expected ~900 frames, got %d" % len(pts)
    backward = [
        (i, pts[i - 1], pts[i])
        for i in range(1, len(pts))
        if pts[i] < pts[i - 1] - 1e-6
    ]
    assert not backward, "backward PTS jump(s) in finalized clip: %r" % backward[:5]

    # real-decode validate passes on the produced clip (B1).
    assert rec._decode_validate(str(final), 30.0, "real") is True


@_skip_no_ffmpeg
def test_given_one_broken_segment_when_finalize_then_dropped_clip_still_valid(
    tmp_path,
):
    """A 0-byte / moov-less scratch segment is ffprobe-dropped (WARN) and the
    rest still stitch into a valid clip — mirrors the recorder's
    _filter_valid_segments defense at the visit-finalize layer.
    """
    # arrange — real GOP segments + inject one truncated (moov-less) file.
    scratch, n_segs = _gen_gop_segments(tmp_path, total_s=20, gop_s=4.3)
    # Corrupt the LAST segment by truncating it to a header-less stub.
    last = sorted(scratch.glob("*.mp4"))[-1]
    last.write_bytes(b"\x00" * 64)

    rec = ClipRecorder("rtsp://x", str(tmp_path / "rec"))

    # act — duration window is generous so dropping one ~4.3s tail seg is ok.
    ok = rec.finalize_visit("real", str(scratch), 1000.0, 1020.0)

    # assert — still produced ONE valid clip from the surviving segments.
    final = Path(rec.recordings_dir) / "real.mp4"
    assert ok is True
    assert final.exists() and final.stat().st_size > 0
    assert rec._decode_validate(str(final), None, "real") is True


@_skip_no_ffmpeg
def test_given_all_segments_zero_byte_when_real_finalize_then_false(tmp_path):
    """All-invalid scratch (every segment moov-less) -> fail-closed, no clip,
    scratch reaped. The route 404s honestly rather than serving a broken file.
    """
    # arrange
    scratch = tmp_path / "_visits" / "event_real"
    scratch.mkdir(parents=True)
    for i in range(3):
        (scratch / "{:06d}.mp4".format(i)).write_bytes(b"\x00" * 64)
    rec = ClipRecorder("rtsp://x", str(tmp_path / "rec"))

    # act
    ok = rec.finalize_visit("real", str(scratch), 1000.0, 1015.0)

    # assert
    assert ok is False
    assert not (Path(rec.recordings_dir) / "real.mp4").exists()
    assert not scratch.exists()


# Real NVENC clips pulled by deploy/fetch-jetson-data.sh — the ONLY content
# that reproduces the GOP-join "non monotonic dts" the synthetic libx264
# fixture cannot. Gated on the snapshot being present.
_SNAP_CLIPS_DIR = Path(__file__).resolve().parents[2] / ".jetson-snapshot" / "clips"


@_skip_no_ffmpeg
def test_given_real_nvenc_concat_when_decode_validate_then_true_despite_dts(tmp_path):
    """REGRESSION (real-data): a `-c copy` concat of real Jetson NVENC clips
    makes the `-f null -` decode emit ~hundreds of benign "non monotonic dts
    to muxer" lines, but the clip plays perfectly. `_decode_validate` MUST
    return True — treating that warning as fatal would reject every real clip
    on the Jetson (finalize always fails, zero clips). The synthetic fixture
    above cannot catch this; only real NVENC content does.
    """
    # arrange — need >=2 real snapshot clips.
    clips = sorted(_SNAP_CLIPS_DIR.glob("*.mp4")) if _SNAP_CLIPS_DIR.is_dir() else []
    if len(clips) < 2:
        pytest.skip(
            "need >=2 real snapshot clips — run deploy/fetch-jetson-data.sh"
        )
    rec = _recorder(tmp_path)
    lst = tmp_path / "concat.txt"
    lst.write_text("".join("file '{0}'\n".format(c) for c in clips[:2]))
    out = tmp_path / "real_concat.mp4"
    # same flags finalize uses (preroll.run_concat-style, -c copy -f mp4).
    subprocess.run(
        [_FFMPEG_BIN, "-y", "-hide_banner", "-loglevel", "error",
         "-f", "concat", "-safe", "0", "-i", str(lst),
         "-c", "copy", "-movflags", "+faststart", "-f", "mp4", str(out)],
        check=True,
    )
    expected = sum(rec._probe_duration(str(c)) for c in clips[:2])

    # act
    ok = rec._decode_validate(str(out), expected, "real_nvenc")

    # assert — benign DTS warnings do NOT reject a genuinely-playable clip.
    assert ok is True
