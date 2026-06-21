"""Unit tests for the continuous-capture S2 ring-range API.

Run from `detection/`:
    /tmp/homecam-venv/bin/python -m pytest tests/test_preroll_range.py -q

Covers the two new PrerollBuffer primitives the finalize layer (S3)
will use:

  - `segments_in_range(start_ts, end_ts)` — closed-band OVERLAP
    selection, chronological order. Segments are GOP-floored to ~4.3s
    (plan R1), so we space synthetic mtimes by ~4.3s (NOT 1s) and assert
    boundary segments (straddling start_ts / end_ts) are included.
  - `copy_new_segments(start_ts, until_ts, scratch_dir, already_copied)`
    — incremental copy-on-extend (plan B3): copies only overlapping,
    not-yet-copied slots; idempotent across ticks; survives a simulated
    ring wrap (an uncopied slot disappearing between calls); creates the
    scratch dir.

Pure-Python module — no jetson_inference / jetson_utils. Real tmp dirs +
os.utime mtimes, same fixture style as test_preroll.py.

Python 3.6 compatible (detection/ is pinned by test_py36_compat.py).
"""
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from preroll import PrerollBuffer


# Real recorded GOP ~4.3s (plan R1), so model segments at that spacing.
GOP_S = 4.3


def _make_buffer(buffer_dir):
    # arrange helper — a buffer whose segment_s reflects the real ~4.3s
    # GOP, so each segment covers [mtime - 4.3, mtime].
    return PrerollBuffer(
        rtsp_url="rtsp://localhost:8554/cam",
        buffer_dir=str(buffer_dir),
        segment_s=GOP_S,
    )


def _write_seg(buffer_dir, slot, mtime):
    # arrange helper — create a synthetic ring slot with a set mtime.
    p = Path(buffer_dir) / "seg_{:03d}.mp4".format(slot)
    p.write_bytes(b"x" * 16)
    os.utime(str(p), (mtime, mtime))
    return p


# --------------------------------------------------------------------------
# segments_in_range
# --------------------------------------------------------------------------

def test_given_no_buffer_dir_when_segments_in_range_then_empty():
    # Given a buffer whose dir does not exist
    pb = PrerollBuffer(
        rtsp_url="rtsp://localhost:8554/cam",
        buffer_dir="/nonexistent/preroll/dir",
        segment_s=GOP_S,
    )

    # When asked for a range
    result = pb.segments_in_range(100.0, 200.0)

    # Then it returns [] without raising
    assert result == []


def test_given_inverted_band_when_segments_in_range_then_empty(tmp_path):
    # Given a band where end < start (caller confusion)
    buf = tmp_path / "preroll"
    buf.mkdir()
    pb = _make_buffer(buf)
    _write_seg(buf, 0, 100.0)

    # When asked with an inverted band
    result = pb.segments_in_range(200.0, 100.0)

    # Then it returns [] (don't guess)
    assert result == []


def test_given_gop_spaced_segments_when_segments_in_range_then_overlap_selected(tmp_path):
    # Given ring slots whose ~4.3s windows tile a stretch of wall-clock.
    # mtime = segment END; window = [mtime - 4.3, mtime].
    buf = tmp_path / "preroll"
    buf.mkdir()
    pb = _make_buffer(buf)
    base = 1000.0
    # seg windows: s0 [995.7,1000], s1 [1000,1004.3], s2 [1004.3,1008.6],
    #              s3 [1008.6,1012.9], s4 [1012.9,1017.2]
    for i in range(5):
        _write_seg(buf, i, base + i * GOP_S)

    # When the band falls INSIDE s2..s3 but its edges straddle s2/s3
    #   start_ts = 1006.0  (inside s2's window [1004.3,1008.6])
    #   end_ts   = 1010.0  (inside s3's window [1008.6,1012.9])
    result = pb.segments_in_range(1006.0, 1010.0)

    # Then the boundary segments straddling each edge are BOTH included,
    # in chronological order, and segments wholly outside are excluded.
    names = [os.path.basename(p) for p in result]
    # s1 window [1000,1004.3] ends before start 1006 -> excluded
    # s4 window [1012.9,1017.2] starts after end 1010 -> excluded
    assert names == ["seg_002.mp4", "seg_003.mp4"]


def test_given_band_spanning_many_when_segments_in_range_then_all_overlapping(tmp_path):
    # Given a longer run of slots
    buf = tmp_path / "preroll"
    buf.mkdir()
    pb = _make_buffer(buf)
    base = 5000.0
    for i in range(6):
        _write_seg(buf, i, base + i * GOP_S)

    # When the band straddles from inside s0 to inside s4
    #   start_ts inside s0 window [4995.7,5000]; end_ts inside s4 window
    result = pb.segments_in_range(4998.0, base + 4 * GOP_S - 1.0)

    # Then every overlapping slot is returned chronologically (s0..s4),
    # s5 excluded (its window starts after end_ts).
    names = [os.path.basename(p) for p in result]
    assert names == [
        "seg_000.mp4", "seg_001.mp4", "seg_002.mp4",
        "seg_003.mp4", "seg_004.mp4",
    ]


def test_given_band_before_all_segments_when_segments_in_range_then_empty(tmp_path):
    # Given slots all AFTER the band
    buf = tmp_path / "preroll"
    buf.mkdir()
    pb = _make_buffer(buf)
    for i in range(3):
        _write_seg(buf, i, 2000.0 + i * GOP_S)

    # When the band is entirely before the earliest segment window
    result = pb.segments_in_range(100.0, 200.0)

    # Then nothing overlaps
    assert result == []


def test_given_non_segment_files_when_segments_in_range_then_filtered(tmp_path):
    # Given a segment plus noise files in the buffer dir
    buf = tmp_path / "preroll"
    buf.mkdir()
    pb = _make_buffer(buf)
    _write_seg(buf, 1, 3000.0)
    (buf / "not_a_seg.txt").write_bytes(b"junk")
    (buf / "seg_002.mov").write_bytes(b"junk")  # wrong ext

    # When asked for a band overlapping seg_001
    result = pb.segments_in_range(2999.0, 3000.0)

    # Then only the real seg_NNN.mp4 is returned
    names = [os.path.basename(p) for p in result]
    assert names == ["seg_001.mp4"]


def test_given_out_of_order_slots_when_segments_in_range_then_chronological(tmp_path):
    # Given slot NUMBERS that do not match chronological mtime order
    # (the ring wraps, so seg_002 can be older than seg_000).
    buf = tmp_path / "preroll"
    buf.mkdir()
    pb = _make_buffer(buf)
    _write_seg(buf, 0, 8010.0)  # newest
    _write_seg(buf, 1, 8000.0)  # oldest
    _write_seg(buf, 2, 8005.0)  # middle

    # When the band covers all three
    result = pb.segments_in_range(7990.0, 8010.0)

    # Then they come back in CHRONOLOGICAL (play) order, not slot order
    names = [os.path.basename(p) for p in result]
    assert names == ["seg_001.mp4", "seg_002.mp4", "seg_000.mp4"]


# --------------------------------------------------------------------------
# copy_new_segments
# --------------------------------------------------------------------------

def _basenames(seen):
    # seen holds (basename, mtime) identities — pull just the names.
    return {ident[0] for ident in seen}


def test_given_fresh_visit_when_copy_new_segments_then_copies_overlapping_only(tmp_path):
    # Given a ring with slots tiling wall-clock and a band covering s1..s2
    buf = tmp_path / "preroll"
    buf.mkdir()
    pb = _make_buffer(buf)
    base = 1000.0
    for i in range(4):
        _write_seg(buf, i, base + i * GOP_S)
    scratch = tmp_path / "_visits" / "visit_abc"

    # When we copy the band [inside s1, inside s2]
    start = base + 0.5 * GOP_S   # inside s1 window
    until = base + 2.0 * GOP_S - 0.5  # inside s2 window
    newly, seen = pb.copy_new_segments(
        start, until, str(scratch), already_copied=None,
    )

    # Then only the overlapping slots are copied (s1, s2), scratch dir is
    # created, dest files use monotonic chronological names, and seen
    # tracks their (basename, mtime) identities.
    assert scratch.is_dir()
    assert sorted(os.path.basename(p) for p in newly) == [
        "000000.mp4", "000001.mp4",
    ]
    assert _basenames(seen) == {"seg_001.mp4", "seg_002.mp4"}
    assert (scratch / "000000.mp4").is_file()
    assert (scratch / "000001.mp4").is_file()


def test_given_repeated_ticks_when_copy_new_segments_then_idempotent(tmp_path):
    # Given a visit that grows over two extend ticks
    buf = tmp_path / "preroll"
    buf.mkdir()
    pb = _make_buffer(buf)
    base = 2000.0
    for i in range(4):
        _write_seg(buf, i, base + i * GOP_S)
    scratch = tmp_path / "_visits" / "visit_xyz"

    # When tick 1 copies the first part of the band
    newly1, seen = pb.copy_new_segments(
        base, base + 1.0 * GOP_S, str(scratch), already_copied=None,
    )
    tick1_names = _basenames(seen)

    # And tick 2 extends the band to cover later slots, reusing `seen`
    newly2, seen2 = pb.copy_new_segments(
        base, base + 3.0 * GOP_S, str(scratch), already_copied=seen,
    )

    # Then tick 2 copies ONLY the newly-overlapping slots (no re-copy of
    # tick-1 slots), and `seen` accumulates across ticks (mutated in place).
    assert seen2 is seen
    tick2_only = _basenames(seen2) - tick1_names
    assert "seg_003.mp4" in tick2_only        # a genuinely-new slot
    assert {"seg_000.mp4", "seg_003.mp4"}.issubset(_basenames(seen2))
    # tick2 copied EXACTLY the new slots — no re-copy of tick-1 footage
    # (a re-copy would need a new (name, mtime) ident, which unchanged
    # slots don't have, so they're skipped).
    assert len(newly2) == len(tick2_only)

    # And a third tick over the SAME band copies nothing (pure idempotent)
    newly3, _ = pb.copy_new_segments(
        base, base + 3.0 * GOP_S, str(scratch), already_copied=seen2,
    )
    assert newly3 == []


def test_given_ring_wrapped_slot_when_copy_new_segments_then_skips_gracefully(
    tmp_path, monkeypatch
):
    # Given a band over s0..s2 where s1 is about to be wrapped away by the
    # ring before we can copy it.
    buf = tmp_path / "preroll"
    buf.mkdir()
    pb = _make_buffer(buf)
    base = 3000.0
    for i in range(3):
        _write_seg(buf, i, base + i * GOP_S)
    scratch = tmp_path / "_visits" / "visit_wrap"

    import shutil as _shutil
    real_copy2 = _shutil.copy2

    def flaky_copy2(src, dst, *a, **kw):
        # Simulate the ring wrapping seg_001 out from under us mid-copy:
        # delete it and raise the OSError the real copy would raise.
        if os.path.basename(src) == "seg_001.mp4":
            try:
                os.remove(src)
            except OSError:
                pass
            raise OSError(2, "No such file or directory", src)
        return real_copy2(src, dst, *a, **kw)

    monkeypatch.setattr("shutil.copy2", flaky_copy2)

    # When we copy the band covering all three
    newly, seen = pb.copy_new_segments(
        base, base + 2.0 * GOP_S, str(scratch), already_copied=None,
    )

    # Then the present slots ARE copied (under contiguous dest names, no
    # gap left by the failed s1), the vanished one is skipped (not crashed
    # on) and NOT marked seen — so a later tick can retry it.
    assert sorted(os.path.basename(p) for p in newly) == [
        "000000.mp4", "000001.mp4",
    ]
    assert _basenames(seen) == {"seg_000.mp4", "seg_002.mp4"}
    assert "seg_001.mp4" not in _basenames(seen)
    assert (scratch / "000000.mp4").is_file()
    assert (scratch / "000001.mp4").is_file()


def test_given_wrapped_slot_reused_when_copy_then_new_generation_copied(tmp_path):
    # Given a long visit whose ring slot gets REUSED: seg_000 is written,
    # copied, then the ring wraps and overwrites seg_000 with NEW footage
    # (same name, new mtime). Keying on basename alone would silently drop
    # the new generation — the exact missing-footage bug B3 guards against.
    buf = tmp_path / "preroll"
    buf.mkdir()
    pb = _make_buffer(buf)
    scratch = tmp_path / "_visits" / "visit_reuse"

    # arrange — first generation of seg_000 at t0
    _write_seg(buf, 0, 3000.0)
    newly1, seen = pb.copy_new_segments(
        2999.0, 3000.0, str(scratch), already_copied=None,
    )
    assert len(newly1) == 1
    assert _basenames(seen) == {"seg_000.mp4"}

    # act — ring wraps: seg_000 overwritten with new content + new mtime
    _write_seg(buf, 0, 3100.0)
    newly2, seen2 = pb.copy_new_segments(
        2999.0, 3100.0, str(scratch), already_copied=seen,
    )

    # assert — the NEW generation is copied (not skipped), under a fresh
    # dest name, and seen now holds both (seg_000, t0) and (seg_000, t1).
    assert seen2 is seen
    assert len(newly2) == 1
    assert os.path.basename(newly2[0]) == "000001.mp4"
    mtimes = {ident[1] for ident in seen2 if ident[0] == "seg_000.mp4"}
    assert mtimes == {3000.0, 3100.0}
    assert (scratch / "000000.mp4").is_file()
    assert (scratch / "000001.mp4").is_file()


def test_given_list_already_copied_when_copy_new_segments_then_returns_set(tmp_path):
    # Given `already_copied` passed as a LIST (not a set) — the round-trip
    # contract: a caller can persist seen as a list and pass it back.
    buf = tmp_path / "preroll"
    buf.mkdir()
    pb = _make_buffer(buf)
    base = 4000.0
    for i in range(2):
        _write_seg(buf, i, base + i * GOP_S)
    scratch = tmp_path / "_visits" / "visit_list"

    # arrange — first copy establishes the seen identities
    newly1, seen1 = pb.copy_new_segments(
        base, base + 1.0 * GOP_S, str(scratch), already_copied=None,
    )

    # When we pass those identities back AS A LIST
    newly2, seen2 = pb.copy_new_segments(
        base, base + 1.0 * GOP_S, str(scratch),
        already_copied=list(seen1),
    )

    # Then the list is normalised to a set, nothing re-copies, and the
    # identities round-trip intact.
    assert isinstance(seen2, set)
    assert newly2 == []
    assert seen2 == seen1
