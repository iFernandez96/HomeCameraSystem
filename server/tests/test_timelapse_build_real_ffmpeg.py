"""Real-ffmpeg regression tests for the timelapse builder.

These exercise the ACTUAL `ffmpeg -f concat -c copy` stitch (no mocking
of subprocess) and validate the produced mp4 with `ffprobe`, because the
failure that shipped to the user was: a 0-byte / truncated clip on disk
makes the concat demuxer return rc=0 while silently dropping that clip AND
every clip after it — so `build()` reported `ok=True` for a video missing
most captures. A mocked test can never catch that; only running real
ffmpeg + probing the output does.

Skips cleanly when ffmpeg/ffprobe aren't installed (same convention as
the detection-side `test_*_real_ffmpeg_*` tests), so CI without the codec
stack stays green.
"""
from __future__ import annotations

import shutil
import subprocess
import time
from pathlib import Path

import pytest

_HAVE_FFMPEG = shutil.which("ffmpeg") is not None and shutil.which("ffprobe") is not None
pytestmark = pytest.mark.skipif(
    not _HAVE_FFMPEG, reason="ffmpeg/ffprobe not installed"
)


def _import_timelapse():
    from app.services import timelapse
    return timelapse


def _make_clip(
    path: Path, seconds: int = 2, size: str = "320x240", gop: int | None = None
) -> None:
    """Write a real H.264-in-MP4 clip via ffmpeg — mirrors the on-disk
    shape of a per-event recording (video-only H.264, yuv420p).

    `gop=1` forces an all-keyframe (intra-only) clip so the concat demuxer's
    `inpoint` front-trim lands frame-precisely — the recommended setup for
    stream-copy trimming, and what the deployed clips approximate via their
    dense `iframeinterval=8`. Default (None) leaves x264's normal GOP."""
    cmd = [
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
        "-f", "lavfi", "-i",
        "testsrc=duration={0}:size={1}:rate=30".format(seconds, size),
        "-c:v", "libx264", "-pix_fmt", "yuv420p",
    ]
    if gop is not None:
        cmd += ["-g", str(gop), "-keyint_min", str(gop)]
    cmd.append(str(path))
    subprocess.run(cmd, check=True)


def _probe_duration(path: Path) -> float:
    out = subprocess.run(
        [
            "ffprobe", "-v", "error", "-show_entries", "format=duration",
            "-of", "csv=p=0", str(path),
        ],
        capture_output=True, text=True,
    )
    try:
        return float(out.stdout.strip())
    except ValueError:
        return 0.0


def _has_video_stream(path: Path) -> bool:
    out = subprocess.run(
        [
            "ffprobe", "-v", "error", "-select_streams", "v",
            "-show_entries", "stream=codec_type", "-of", "csv=p=0", str(path),
        ],
        capture_output=True, text=True,
    )
    return "video" in out.stdout


def _redecodes_cleanly(path: Path) -> bool:
    """A browser-playable file must decode end-to-end without error."""
    out = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(path), "-f", "null", "-"],
        capture_output=True, text=True,
    )
    return out.returncode == 0 and out.stderr.strip() == ""


@pytest.fixture
def tl_env(tmp_path, monkeypatch):
    """Point the timelapse service at temp recordings/timelapses/events-db,
    and return a seeding helper bound to a fixed local-time day."""
    from app.config import settings
    from app.services import events_db

    rec_dir = tmp_path / "recordings"
    rec_dir.mkdir()
    tl_dir = tmp_path / "timelapses"
    tl_dir.mkdir()
    db_path = tmp_path / "events.db"

    monkeypatch.setattr(settings, "recordings_dir", rec_dir)
    monkeypatch.setattr(settings, "timelapses_dir", tl_dir)
    monkeypatch.setattr(settings, "events_db_path", db_path)
    events_db.init_db(db_path)

    day = "2026-06-15"
    # noon local-time inside `day` — comfortably within the build()'s
    # mktime-derived [midnight, next_midnight) window.
    base_ts = time.mktime((2026, 6, 15, 12, 0, 0, 0, 0, -1))

    state = {"n": 0}

    def seed_event(event_id: str, at: float | None = None) -> None:
        """Insert an event row whose clip_url points at
        recordings_dir/<event_id>.mp4 (the file is created separately).

        `at` overrides the event's offset (seconds from base_ts) so a test
        can place OVERLAPPING events precisely. The default spaces events
        5 s apart — wider than the 2 s test clips, so the de-overlap pass
        keeps every clip whole (matching the pre-de-overlap behaviour these
        bad-clip-skipping tests assert)."""
        state["n"] += 1
        offset = state["n"] * 5 if at is None else at
        events_db.insert_event(
            db_path,
            {
                "id": event_id,
                "ts": base_ts + offset,  # chronological; non-overlapping by default
                "camera_id": "cam1",
                "label": "person",
                "score": 0.9,
                "clip_url": "/api/events/{0}/clip".format(event_id),
                "boxes": [],
                "v": 1,
                "type": "detection",
            },
        )

    return {
        "rec_dir": rec_dir,
        "tl_dir": tl_dir,
        "day": day,
        "seed_event": seed_event,
    }


def test_given_valid_clips_when_build_then_output_is_a_playable_mp4(tl_env):
    """Given several valid per-event clips for a day, When build() stitches
    them, Then the output is a real, playable mp4 whose duration is the sum
    of the inputs (no captures dropped)."""
    # arrange — 3 × 2s clips = 6s expected.
    timelapse = _import_timelapse()
    rec_dir, seed = tl_env["rec_dir"], tl_env["seed_event"]
    for cid in ("clipa", "clipb", "clipc"):
        _make_clip(rec_dir / "{0}.mp4".format(cid), seconds=2)
        seed(cid)

    # act
    result = timelapse.build(tl_env["day"])

    # assert
    assert result.ok is True, result.error
    assert result.clip_count == 3
    out = result.output_path
    assert out.exists() and out.stat().st_size > 0
    assert _has_video_stream(out)
    assert _redecodes_cleanly(out)
    assert _probe_duration(out) == pytest.approx(6.0, abs=0.5)


def test_given_a_zero_byte_clip_when_build_then_it_is_skipped_and_rest_stitched(
    tl_env,
):
    """THE regression. A 0-byte clip (recording created the file but never
    wrote the moov atom) must NOT silently truncate the reel: it is skipped,
    and every VALID capture still makes it into the output."""
    # arrange — valid, ZERO-BYTE, valid. Naively concatenated, the bad clip
    # makes ffmpeg drop itself AND the clip after it → 2s output, ok=True.
    timelapse = _import_timelapse()
    rec_dir, seed = tl_env["rec_dir"], tl_env["seed_event"]
    _make_clip(rec_dir / "good1.mp4", seconds=2)
    seed("good1")
    (rec_dir / "stub0.mp4").write_bytes(b"")  # 0-byte, .exists() is True
    seed("stub0")
    _make_clip(rec_dir / "good2.mp4", seconds=2)
    seed("good2")

    # act
    result = timelapse.build(tl_env["day"])

    # assert — both GOOD clips present (4s), the stub excluded, success.
    assert result.ok is True, result.error
    out = result.output_path
    assert out.exists() and _has_video_stream(out)
    assert _redecodes_cleanly(out)
    assert _probe_duration(out) == pytest.approx(4.0, abs=0.5), (
        "the 0-byte clip silently truncated the reel — only the clips "
        "before it survived"
    )


def test_given_a_truncated_clip_when_build_then_skipped_not_silently_dropped(
    tl_env,
):
    """A header-only / partially-written clip (moov atom missing) is also
    skipped rather than poisoning the concat."""
    # arrange
    timelapse = _import_timelapse()
    rec_dir, seed = tl_env["rec_dir"], tl_env["seed_event"]
    _make_clip(rec_dir / "ok1.mp4", seconds=2)
    seed("ok1")
    # truncate a real clip to its first 400 bytes — no moov atom.
    _make_clip(rec_dir / "full.mp4", seconds=2)
    (rec_dir / "trunc.mp4").write_bytes((rec_dir / "full.mp4").read_bytes()[:400])
    (rec_dir / "full.mp4").unlink()
    seed("trunc")
    _make_clip(rec_dir / "ok2.mp4", seconds=2)
    seed("ok2")

    # act
    result = timelapse.build(tl_env["day"])

    # assert — the two valid clips survive; output is valid + ~4s.
    assert result.ok is True, result.error
    out = result.output_path
    assert _has_video_stream(out) and _redecodes_cleanly(out)
    assert _probe_duration(out) == pytest.approx(4.0, abs=0.5)


def test_given_all_clips_invalid_when_build_then_not_ok_no_false_success(tl_env):
    """If every clip on disk is unusable, build() must report failure — NOT
    claim success on an empty/broken output."""
    # arrange — two 0-byte stubs only.
    timelapse = _import_timelapse()
    rec_dir, seed = tl_env["rec_dir"], tl_env["seed_event"]
    (rec_dir / "z1.mp4").write_bytes(b"")
    seed("z1")
    (rec_dir / "z2.mp4").write_bytes(b"")
    seed("z2")

    # act
    result = timelapse.build(tl_env["day"])

    # assert — no false success, and no broken output left behind claiming ok.
    assert result.ok is False
    if result.output_path.exists():
        assert not _has_video_stream(result.output_path)


# --- hardening: the bug must never recur, in ANY arrangement ----------------


def test_given_bad_clip_FIRST_when_build_then_later_clips_not_eaten(tl_env):
    """Worst position: a 0-byte clip at index 0. Naive concat would yield a
    near-empty reel (this is the 2026-05-05 / 2026-05-01 production case —
    a busy day whose reel collapsed). The pre-filter must drop it so the
    two good clips still stitch to full length."""
    # arrange
    timelapse = _import_timelapse()
    rec_dir, seed = tl_env["rec_dir"], tl_env["seed_event"]
    (rec_dir / "stubfirst.mp4").write_bytes(b"")
    seed("stubfirst")
    _make_clip(rec_dir / "g1.mp4", seconds=2)
    seed("g1")
    _make_clip(rec_dir / "g2.mp4", seconds=2)
    seed("g2")

    # act
    result = timelapse.build(tl_env["day"])

    # assert
    assert result.ok is True, result.error
    assert _redecodes_cleanly(result.output_path)
    assert _probe_duration(result.output_path) == pytest.approx(4.0, abs=0.5)


def test_given_many_interspersed_bad_clips_when_build_then_all_good_survive(tl_env):
    """good, 0-byte, good, truncated, good → exactly the 3 good clips (6s)
    survive, in order. No bad clip at any position eats its neighbours."""
    # arrange
    timelapse = _import_timelapse()
    rec_dir, seed = tl_env["rec_dir"], tl_env["seed_event"]
    _make_clip(rec_dir / "a.mp4", seconds=2)
    seed("a")
    (rec_dir / "z.mp4").write_bytes(b"")
    seed("z")
    _make_clip(rec_dir / "b.mp4", seconds=2)
    seed("b")
    _make_clip(rec_dir / "ftmp.mp4", seconds=2)
    (rec_dir / "t.mp4").write_bytes((rec_dir / "ftmp.mp4").read_bytes()[:300])
    (rec_dir / "ftmp.mp4").unlink()
    seed("t")
    _make_clip(rec_dir / "c.mp4", seconds=2)
    seed("c")

    # act
    result = timelapse.build(tl_env["day"])

    # assert — 3 good × 2s, valid + playable.
    assert result.ok is True, result.error
    assert _redecodes_cleanly(result.output_path)
    assert _probe_duration(result.output_path) == pytest.approx(6.0, abs=0.6)


def test_given_a_skipped_bad_clip_when_build_then_a_warning_names_the_event(
    tl_env, caplog,
):
    """Never silent: skipping a broken clip must log a WARNING naming the
    event id, so a corrupt recording is operator-visible rather than a
    mystery short reel."""
    # arrange
    import logging as _logging
    timelapse = _import_timelapse()
    rec_dir, seed = tl_env["rec_dir"], tl_env["seed_event"]
    _make_clip(rec_dir / "okclip.mp4", seconds=2)
    seed("okclip")
    (rec_dir / "badone.mp4").write_bytes(b"")
    seed("badone")

    # act
    with caplog.at_level(_logging.WARNING, logger="app.services.timelapse"):
        result = timelapse.build(tl_env["day"])

    # assert — built from the good clip, AND the skip was logged loudly.
    assert result.ok is True, result.error
    warns = [r.getMessage() for r in caplog.records if r.levelno >= _logging.WARNING]
    assert any("badone" in m and "unreadable" in m for m in warns), warns


def test_given_ffmpeg_rc0_but_empty_output_when_build_then_not_ok(
    tl_env, monkeypatch,
):
    """Defense-in-depth: even if every input passes the pre-filter AND
    ffmpeg exits 0, a non-playable output must flip build() to ok=False.
    This is the belt to the pre-filter's braces — build() must NEVER
    report success on a file that won't play."""
    # arrange — one valid clip, but ffmpeg "succeeds" leaving a 0-byte file.
    timelapse = _import_timelapse()
    rec_dir, seed = tl_env["rec_dir"], tl_env["seed_event"]
    _make_clip(rec_dir / "valid.mp4", seconds=2)
    seed("valid")

    def fake_concat(list_path, output_path, timeout_s=120.0):
        Path(output_path).write_bytes(b"")  # rc=0 but garbage
        return True, ""

    monkeypatch.setattr(timelapse, "_run_ffmpeg_concat", fake_concat)

    # act
    result = timelapse.build(tl_env["day"])

    # assert
    assert result.ok is False
    assert "validation" in (result.error or "").lower()
    # and the broken .tmp must NOT be published to the final path.
    assert not (tl_env["tl_dir"] / "{0}.mp4".format(tl_env["day"])).exists()


def test_given_concat_fails_when_build_then_no_partial_left_at_final_path(
    tl_env, monkeypatch,
):
    """A failed / timed-out concat must leave NOTHING at the final
    <day>.mp4 path — the build writes to a `.tmp` sidecar and only
    atomic-renames on success, so the GET route can never serve a
    half-written / broken video. (Before this, a 120 s timeout on a big
    day left a 1.2 GB partial the route happily served.)"""
    # arrange — ffmpeg "writes" a partial .tmp then reports timeout.
    timelapse = _import_timelapse()
    rec_dir, seed = tl_env["rec_dir"], tl_env["seed_event"]
    _make_clip(rec_dir / "v.mp4", seconds=2)
    seed("v")

    def fake_concat(list_path, output_path, timeout_s=120.0):
        Path(output_path).write_bytes(b"partial-garbage-bytes")
        return False, "ffmpeg timed out after 684s"

    monkeypatch.setattr(timelapse, "_run_ffmpeg_concat", fake_concat)

    # act
    result = timelapse.build(tl_env["day"])

    # assert — failure reported, and NO file (final or .tmp) left behind.
    assert result.ok is False
    assert "timed out" in (result.error or "")
    final = tl_env["tl_dir"] / "{0}.mp4".format(tl_env["day"])
    tmp = tl_env["tl_dir"] / "{0}.mp4.tmp".format(tl_env["day"])
    assert not final.exists(), "failed build left a partial at the final path"
    assert not tmp.exists(), "failed build leaked a .tmp file"


def test_ffmpeg_timeout_scales_with_input_size_not_just_count(tl_env):
    """The concat timeout must grow with total INPUT BYTES, not just clip
    count. The shipped bug (user-hit 2026-06-20): a few-but-HUGE-clip day —
    32 clips of ~90 s / ~45 MB = 1.44 GB — scored 32 clips → floored to 120 s
    and TIMED OUT, though the real build needs 212 s. Days with many small
    clips were fine; days with few large clips silently failed."""
    # arrange + act + assert
    timelapse = _import_timelapse()
    GB = 1_000_000_000
    # tiny day → floor.
    assert timelapse._ffmpeg_timeout_for(3, 30_000_000) == 120.0
    # THE regression: 32 clips alone is only 32 s, but 1.44 GB must buy a
    # timeout comfortably above the measured 212 s build time.
    t = timelapse._ffmpeg_timeout_for(32, int(1.44 * GB))
    assert t > 212.0, "1.44 GB day must out-budget its 212 s real build time"
    assert t == pytest.approx(1.44 * 300 + 32, abs=1.0)
    # pathological all-day camera → 30-min ceiling.
    assert timelapse._ffmpeg_timeout_for(100000, 50 * GB) == 1800.0


def test_clip_has_video_classifies_valid_zero_byte_truncated_and_missing(tmp_path):
    """Unit pin on the probe that both the pre-filter and the output
    post-validate rely on — the single chokepoint that makes the whole
    guarantee hold."""
    # arrange
    timelapse = _import_timelapse()
    good = tmp_path / "good.mp4"
    _make_clip(good, seconds=1)
    zero = tmp_path / "zero.mp4"
    zero.write_bytes(b"")
    trunc = tmp_path / "trunc.mp4"
    trunc.write_bytes(good.read_bytes()[:200])
    missing = tmp_path / "missing.mp4"

    # act + assert
    assert timelapse._clip_has_video(good) is True
    assert timelapse._clip_has_video(zero) is False
    assert timelapse._clip_has_video(trunc) is False
    assert timelapse._clip_has_video(missing) is False


# --- de-overlap: the "teleporting back in time" bug ------------------------


def test_given_overlapping_refire_clips_when_build_then_reel_deduplicated(tl_env):
    """THE timelapse bug. Given a continuous presence's re-fire clips that
    heavily OVERLAP in wall-clock time (each ~3 s clip only 1 s after the
    last — the production pattern where a lingering subject re-fires every
    cooldown and each clip's pre/post-roll window overlaps its neighbours),
    When build() stitches them, Then the reel runs strictly FORWARD: the
    already-shown prefix of each later clip is front-trimmed so total
    duration ≈ the union window, NOT the naive sum that replays the same
    seconds and jumps the playhead backward ("teleporting back in time")."""
    # arrange — 4 × 3 s clips, events 1 s apart → windows overlap 2 s each.
    # Naive concat = 12 s with 3 backward jumps; de-overlapped = ~6 s forward.
    timelapse = _import_timelapse()
    rec_dir, seed = tl_env["rec_dir"], tl_env["seed_event"]
    for i, cid in enumerate(("r0", "r1", "r2", "r3")):
        _make_clip(rec_dir / "{0}.mp4".format(cid), seconds=3, gop=1)
        seed(cid, at=float(i))  # ts = base+0, +1, +2, +3 → union [0, 6]

    # act
    result = timelapse.build(tl_env["day"])

    # assert — built, playable, and de-duplicated to ~the union length.
    assert result.ok is True, result.error
    assert _redecodes_cleanly(result.output_path)
    dur = _probe_duration(result.output_path)
    assert dur == pytest.approx(6.0, abs=1.0), (
        "reel is {0:.2f}s — expected ~6 s union, not the 12 s naive sum "
        "(overlapping footage was replayed instead of trimmed)".format(dur)
    )


def test_given_overlapping_clips_when_build_then_no_backward_time_jump(tl_env):
    """Tighter pin: the de-overlapped reel must be SHORTER than the naive
    sum of its inputs — proof that redundant footage was removed rather than
    concatenated. (A reel equal to the input sum means every overlapping
    clip was replayed in full — the exact regression.)"""
    # arrange — 5 × 4 s clips, 1 s apart → union [0, 8], naive sum = 20 s.
    timelapse = _import_timelapse()
    rec_dir, seed = tl_env["rec_dir"], tl_env["seed_event"]
    for i, cid in enumerate(("o0", "o1", "o2", "o3", "o4")):
        _make_clip(rec_dir / "{0}.mp4".format(cid), seconds=4, gop=1)
        seed(cid, at=float(i))

    # act
    result = timelapse.build(tl_env["day"])

    # assert — union ≈ 8 s, comfortably under the 20 s naive sum.
    assert result.ok is True, result.error
    dur = _probe_duration(result.output_path)
    assert dur == pytest.approx(8.0, abs=1.5)
    assert dur < 15.0, "overlapping clips were replayed, not de-overlapped"


def test_given_separate_visits_when_build_then_both_kept_whole(tl_env):
    """De-overlap must NOT eat genuinely-separate events. Two clips minutes
    apart (no wall-clock overlap) are both kept at full length — the reel is
    the sum of the two, not a single trimmed clip."""
    # arrange — two 2 s clips 600 s apart (separate visits).
    timelapse = _import_timelapse()
    rec_dir, seed = tl_env["rec_dir"], tl_env["seed_event"]
    _make_clip(rec_dir / "v1.mp4", seconds=2)
    seed("v1", at=0.0)
    _make_clip(rec_dir / "v2.mp4", seconds=2)
    seed("v2", at=600.0)

    # act
    result = timelapse.build(tl_env["day"])

    # assert — both full clips survive (4 s), nothing trimmed.
    assert result.ok is True, result.error
    assert result.clip_count == 2
    assert _probe_duration(result.output_path) == pytest.approx(4.0, abs=0.5)


# --- timestamp sidecar -----------------------------------------------------


def test_given_a_build_when_complete_then_timestamp_sidecar_maps_offsets(tl_env):
    """The build writes a `<day>.json` sidecar mapping each reel segment's
    start offset to its original capture time, so the client can paint a
    forward-ticking wall-clock overlay. Offsets and capture times both
    increase monotonically and the first offset is 0."""
    # arrange — 3 non-overlapping clips.
    import json as _json
    timelapse = _import_timelapse()
    rec_dir, seed = tl_env["rec_dir"], tl_env["seed_event"]
    for cid in ("s1", "s2", "s3"):
        _make_clip(rec_dir / "{0}.mp4".format(cid), seconds=2)
        seed(cid)

    # act
    result = timelapse.build(tl_env["day"])

    # assert
    assert result.ok is True, result.error
    sidecar = tl_env["tl_dir"] / "{0}.json".format(tl_env["day"])
    assert sidecar.exists(), "build did not write the timestamp sidecar"
    data = _json.loads(sidecar.read_text())
    assert data["v"] == 1
    assert data["date"] == tl_env["day"]
    segs = data["segments"]
    assert len(segs) == 3
    offsets = [s["offset_s"] for s in segs]
    caps = [s["capture_ts"] for s in segs]
    assert offsets[0] == 0.0
    assert offsets == sorted(offsets), "reel offsets not monotonic"
    assert caps == sorted(caps), "capture times not chronological"
    # non-overlapping 2 s clips → offsets advance ~2 s.
    assert offsets[1] == pytest.approx(2.0, abs=0.3)
    assert offsets[2] == pytest.approx(4.0, abs=0.3)


def test_given_no_clips_when_build_then_no_sidecar_written(tl_env):
    """A failed/empty build must not leave a stale sidecar — the GET route
    would otherwise advertise a manifest for a reel that doesn't exist."""
    # arrange — no events seeded at all.
    timelapse = _import_timelapse()

    # act
    result = timelapse.build(tl_env["day"])

    # assert
    assert result.ok is False
    assert not (tl_env["tl_dir"] / "{0}.json".format(tl_env["day"])).exists()
