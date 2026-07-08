"""S4 offline tests for continuous-capture wiring + crash recovery.

The detection LOOP itself can only be verified on the Jetson, but the new
LOGIC — flag/knob resolution, the transition handler, the tick-at-loop-top
finalize, 3-state idempotent crash recovery, orphan sweep, and the R5 watchdog
finalize hook — is pure-Python and tested here with the SDK mocked (mirrors
test_capture_recovery.py's sys.modules stub) so it runs on the dev host.

Run from `detection/`:
    /tmp/homecam-venv/bin/python -m pytest tests/test_visit_recovery.py -q
"""
import os
import sys
from pathlib import Path
from unittest.mock import MagicMock

import pytest

# detect.py / visit.py / visit_runtime.py sit one level up.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

# Stub the host-only Jetson SDK BEFORE importing anything that pulls detect.
sys.modules.setdefault("jetson_inference", MagicMock())
sys.modules.setdefault("jetson_utils", MagicMock())

import visit_runtime  # noqa: E402
from visit import VisitTracker  # noqa: E402


# --------------------------------------------------------------------------- #
# 1. Flag / knob resolution (pure)                                            #
# --------------------------------------------------------------------------- #

def test_given_no_env_or_config_when_resolved_then_flag_off_and_defaults():
    # arrange / act
    cfg = visit_runtime.resolve_continuous_config(env={}, config={})

    # assert — feature is OFF by default; knobs at plan defaults.
    assert cfg["enabled"] is False
    assert cfg["max_visit_s"] == visit_runtime.DEFAULT_MAX_VISIT_S
    assert cfg["absence_finalize_s"] == visit_runtime.DEFAULT_ABSENCE_FINALIZE_S


def test_given_env_flag_truthy_when_resolved_then_enabled():
    # arrange / act
    cfg = visit_runtime.resolve_continuous_config(
        env={"DETECT_CONTINUOUS_CAPTURE": "1",
             "DETECT_MAX_VISIT_S": "200",
             "DETECT_ABSENCE_FINALIZE_S": "12"},
        config={},
    )

    # assert
    assert cfg["enabled"] is True
    assert cfg["max_visit_s"] == 200.0
    assert cfg["absence_finalize_s"] == 12.0


def test_given_config_when_resolved_then_config_overrides_env():
    # arrange — env says off + 200; config (live poll) says on + 90.
    env = {"DETECT_CONTINUOUS_CAPTURE": "0", "DETECT_MAX_VISIT_S": "200"}
    config = {"continuous_capture": True, "max_visit_s": 90}

    # act
    cfg = visit_runtime.resolve_continuous_config(env=env, config=config)

    # assert — config wins on both fields.
    assert cfg["enabled"] is True
    assert cfg["max_visit_s"] == 90.0


def test_given_bad_values_when_resolved_then_falls_back_to_default():
    # arrange — uncastable + non-positive values must not raise / wedge.
    cfg = visit_runtime.resolve_continuous_config(
        env={"DETECT_MAX_VISIT_S": "abc", "DETECT_ABSENCE_FINALIZE_S": "-5"},
        config={"absence_finalize_s": 0},
    )

    # assert
    assert cfg["max_visit_s"] == visit_runtime.DEFAULT_MAX_VISIT_S
    assert cfg["absence_finalize_s"] == visit_runtime.DEFAULT_ABSENCE_FINALIZE_S


# --------------------------------------------------------------------------- #
# Helpers for the recovery / runner tests                                     #
# --------------------------------------------------------------------------- #

def _write_open_visit(rec_dir, visit_id, **fields):
    """Persist a single OPEN visit record + create its scratch dir with one
    fake segment so a finalize has something to chew on."""
    rec = {
        "state": visit_runtime.STATE_OPEN,
        "key": "person:cam1",
        "visit_id": visit_id,
        "start_ts": fields.get("start_ts", 100.0),
        "last_extend": fields.get("last_extend", 110.0),
        "last_seen": fields.get("last_seen", 110.0),
        "segment_index": 0,
        "absence_finalize_s": fields.get("absence_finalize_s", 10.0),
    }
    rec.update(fields)
    visits = visit_runtime.read_open_visits(rec_dir)
    visits[visit_id] = rec
    visit_runtime.write_open_visits(rec_dir, visits)
    scratch = visit_runtime.scratch_dir_for(rec_dir, visit_id)
    os.makedirs(scratch, exist_ok=True)
    with open(os.path.join(scratch, "000000.mp4"), "wb") as f:
        f.write(b"fake-segment-bytes")
    return rec


def _write_valid_clip(rec_dir, visit_id):
    path = os.path.join(rec_dir, "{}.mp4".format(visit_id))
    with open(path, "wb") as f:
        f.write(b"a-published-clip")
    return path


# --------------------------------------------------------------------------- #
# 2. Recovery idempotency (plan B4)                                           #
# --------------------------------------------------------------------------- #

def test_given_visit_with_valid_clip_when_recovered_then_skipped_no_refinalize(
    tmp_path,
):
    # arrange — a crashed-mid-visit entry whose <id>.mp4 already exists+valid.
    rec_dir = str(tmp_path)
    _write_open_visit(rec_dir, "vid_valid")
    _write_valid_clip(rec_dir, "vid_valid")
    finalize_calls = []

    def validate(_path):
        return True  # the surviving clip validates

    def finalize(vid, scratch, s, e):
        finalize_calls.append(vid)  # MUST NOT be called for a valid clip
        return True

    # act
    summary = visit_runtime.recover_open_visits(
        rec_dir, validate, finalize, now=200.0,
    )

    # assert — THE B4 idempotency property: valid clip => skipped, never
    # re-finalized, never os.replace'd over the good file, entry dropped.
    assert summary["skipped"] == ["vid_valid"]
    assert finalize_calls == []
    assert visit_runtime.read_open_visits(rec_dir) == {}


def test_given_visit_with_no_output_when_recovered_then_finalized_from_scratch(
    tmp_path,
):
    # arrange — a crashed visit with NO published clip but surviving scratch.
    rec_dir = str(tmp_path)
    _write_open_visit(rec_dir, "vid_orphan",
                      start_ts=100.0, last_extend=140.0,
                      absence_finalize_s=10.0)
    seen = {}

    def validate(_path):
        return False  # no valid output exists

    def finalize(vid, scratch, start_ts, end_ts):
        seen["call"] = (vid, scratch, start_ts, end_ts)
        return True

    # act
    summary = visit_runtime.recover_open_visits(
        rec_dir, validate, finalize, now=200.0,
    )

    # assert — finalized over [start, min(last_extend, now)] = [100, 140].
    # Bug-B3 fix (2026-07-07, replay harness): the window used to add the
    # absence grace (end 150) — footage scratch never held, so finalize's
    # duration check refused honest clips on slow restarts. Recovery now
    # claims exactly what was captured: up to last_extend.
    assert summary["finalized"] == ["vid_orphan"]
    vid, scratch, start_ts, end_ts = seen["call"]
    assert vid == "vid_orphan"
    assert start_ts == 100.0
    assert end_ts == 140.0
    assert visit_runtime.read_open_visits(rec_dir) == {}


def test_given_finalize_fails_when_recovered_then_entry_left_finalizing(
    tmp_path,
):
    # arrange — finalize can't produce a clip (scratch lost); the entry must
    # survive in FINALIZING for a later retry (never silently dropped).
    rec_dir = str(tmp_path)
    _write_open_visit(rec_dir, "vid_fail")

    def validate(_path):
        return False

    def finalize(vid, scratch, s, e):
        return False

    # act
    summary = visit_runtime.recover_open_visits(
        rec_dir, validate, finalize, now=300.0,
    )

    # assert
    assert summary["failed"] == ["vid_fail"]
    survivors = visit_runtime.read_open_visits(rec_dir)
    assert "vid_fail" in survivors
    assert survivors["vid_fail"]["state"] == visit_runtime.STATE_FINALIZING


@pytest.mark.parametrize("crash_state", ["OPEN", "FINALIZING", "valid_clip"])
def test_property_random_crash_state_never_double_finalizes(
    tmp_path, crash_state,
):
    """Across the lifecycle states a crash can leave behind, a recovery pass
    must NEVER os.replace over a good clip and must finalize a given visit_id
    AT MOST ONCE (the B4 no-double-publish property)."""
    # arrange
    rec_dir = str(tmp_path)
    _write_open_visit(rec_dir, "vid_x")
    if crash_state == "FINALIZING":
        visits = visit_runtime.read_open_visits(rec_dir)
        visits["vid_x"]["state"] = visit_runtime.STATE_FINALIZING
        visit_runtime.write_open_visits(rec_dir, visits)
    clip_already_valid = crash_state == "valid_clip"
    if clip_already_valid:
        _write_valid_clip(rec_dir, "vid_x")

    finalize_calls = []

    def validate(_path):
        return clip_already_valid

    def finalize(vid, scratch, s, e):
        finalize_calls.append(vid)
        return True

    # act — run recovery TWICE (a second boot after the first completed).
    visit_runtime.recover_open_visits(rec_dir, validate, finalize, now=500.0)
    # second pass: the clip now exists from pass 1 (if finalize ran), so it
    # must be treated as valid on re-entry → no second finalize.
    if finalize_calls and not clip_already_valid:
        _write_valid_clip(rec_dir, "vid_x")

        def validate2(_path):
            return True

        visit_runtime.recover_open_visits(
            rec_dir, validate2, finalize, now=600.0,
        )

    # assert — finalize fired at most once for the visit_id.
    assert finalize_calls.count("vid_x") <= 1
    # and the table is clean (or left FINALIZING only if finalize never ran).
    if clip_already_valid:
        assert finalize_calls == []


# --------------------------------------------------------------------------- #
# 3. Orphan sweep (plan R8)                                                    #
# --------------------------------------------------------------------------- #

def test_given_orphan_scratch_and_tmp_when_swept_then_reclaimed_preroll_kept(
    tmp_path,
):
    # arrange
    rec_dir = str(tmp_path)
    # An orphan visit scratch dir (no live entry in .open_visits.json).
    orphan = visit_runtime.scratch_dir_for(rec_dir, "ghost")
    os.makedirs(orphan, exist_ok=True)
    with open(os.path.join(orphan, "000000.mp4"), "wb") as f:
        f.write(b"x")
    # A live visit scratch that MUST survive (its id is in the table).
    _write_open_visit(rec_dir, "alive")
    # A stray .mp4.tmp from a crashed finalize.
    stray_tmp = os.path.join(rec_dir, "abc.mp4.tmp")
    with open(stray_tmp, "wb") as f:
        f.write(b"partial")
    # The pre-roll ring — MUST NOT be touched.
    preroll = os.path.join(rec_dir, "_preroll")
    os.makedirs(preroll, exist_ok=True)
    seg = os.path.join(preroll, "seg_001.mp4")
    with open(seg, "wb") as f:
        f.write(b"ring")

    # act
    reclaimed = visit_runtime.sweep_orphans(rec_dir)

    # assert — orphan scratch + stray .tmp gone; live scratch + _preroll kept.
    assert reclaimed == 2
    assert not os.path.exists(orphan)
    assert not os.path.exists(stray_tmp)
    assert os.path.exists(visit_runtime.scratch_dir_for(rec_dir, "alive"))
    assert os.path.exists(seg), "_preroll/seg_* must NEVER be swept"


# --------------------------------------------------------------------------- #
# 4. Tick-at-loop-top: all-absent frame drives finalize (plan B5)             #
# --------------------------------------------------------------------------- #

def _make_runner(tmp_path, spawn=None):
    """A VisitRunner with side effects captured into lists, finalize run
    SYNCHRONOUSLY (spawn = call-immediately) so assertions are deterministic."""
    events = {"open": [], "copy": [], "finalize": []}

    def post_event(visit_id, key, start_ts, boxes=None, segment_index=0):
        events["open"].append((visit_id, key, start_ts, boxes))

    def copy_segments(visit_id, start_ts, until_ts, scratch, already):
        events["copy"].append((visit_id, start_ts, until_ts))
        return [], (already if already is not None else set())

    def finalize(visit_id, scratch, start_ts, end_ts):
        events["finalize"].append((visit_id, start_ts, end_ts))
        return True

    def _sync_spawn(target, _vid):
        target()

    runner = visit_runtime.VisitRunner(
        recordings_dir=str(tmp_path),
        post_event=post_event,
        copy_segments=copy_segments,
        finalize_visit=finalize,
        tracker=VisitTracker(id_factory=lambda: "vid1"),
        spawn=spawn if spawn is not None else _sync_spawn,
    )
    return runner, events


def test_given_observe_with_boxes_when_open_then_post_carries_those_boxes(tmp_path):
    # arrange — the S6 fix: the open POST must carry the frame's real boxes
    # (server DetectionPayload requires >=1 box; S4 shipped boxes:[]).
    runner, events = _make_runner(tmp_path)
    frame_boxes = [
        {"label": "person", "x": 0.1, "y": 0.1, "w": 0.2, "h": 0.3, "score": 0.9},
    ]

    # act — a present detection opens a visit, passing the full box list.
    runner.observe("person:cam1", (0.0, 0.0, 0.1, 0.1), now=100.0,
                   pre_roll_s=0.0, absence_finalize_s=10.0, max_visit_s=150.0,
                   boxes=frame_boxes)

    # assert — the open POST received the non-empty boxes (not []).
    assert len(events["open"]) == 1
    posted_boxes = events["open"][0][3]
    assert posted_boxes == frame_boxes
    assert posted_boxes, "open POST must carry >=1 box or the server 422s"


def test_given_open_visit_when_all_absent_frames_tick_then_finalize_at_deadline(
    tmp_path,
):
    # arrange — open a visit at t=100, then ONLY absent frames (tick).
    runner, events = _make_runner(tmp_path)
    runner.set_absence_finalize_s(10.0)
    runner.observe("person:cam1", (0.0, 0.0, 0.1, 0.1), now=100.0,
                   pre_roll_s=0.0, absence_finalize_s=10.0, max_visit_s=150.0)
    assert events["open"], "observe should have opened a visit"

    # act — absent ticks BEFORE and AFTER the deadline (last_seen=100 + 10).
    runner.tick(now=105.0, absence_finalize_s=10.0, max_visit_s=150.0)
    assert events["finalize"] == [], "no finalize before the deadline"
    runner.tick(now=120.0, absence_finalize_s=10.0, max_visit_s=150.0)

    # assert — the all-absent tick path fired finalize at the deadline (110).
    assert len(events["finalize"]) == 1
    vid, start_ts, end_ts = events["finalize"][0]
    assert vid == "vid1"
    assert end_ts == 110.0  # last_seen(100) + absence(10)


def test_given_extend_when_observed_again_then_copy_segments_called(tmp_path):
    # arrange
    runner, events = _make_runner(tmp_path)
    runner.set_absence_finalize_s(10.0)
    box = (0.0, 0.0, 0.2, 0.2)
    runner.observe("person:cam1", box, now=100.0, pre_roll_s=0.0,
                   absence_finalize_s=10.0, max_visit_s=150.0)

    # act — a second present frame (same subject) → extend → incremental copy.
    runner.observe("person:cam1", box, now=103.0, pre_roll_s=0.0,
                   absence_finalize_s=10.0, max_visit_s=150.0)

    # assert
    assert len(events["copy"]) == 1
    vid, start_ts, until_ts = events["copy"][0]
    assert vid == "vid1"
    assert until_ts == 103.0


# --------------------------------------------------------------------------- #
# 5. Watchdog-escalation finalize hook (plan R5)                              #
# --------------------------------------------------------------------------- #

def test_given_open_visit_when_escalation_hook_then_finalize_at_last_seen_and_persist(
    tmp_path,
):
    # arrange — an open visit; the camera watchdog is about to reboot.
    runner, events = _make_runner(tmp_path)
    runner.set_absence_finalize_s(10.0)
    runner.observe("person:cam1", (0.0, 0.0, 0.2, 0.2), now=100.0,
                   pre_roll_s=0.0, absence_finalize_s=10.0, max_visit_s=150.0)
    runner.observe("person:cam1", (0.0, 0.0, 0.2, 0.2), now=108.0,
                   pre_roll_s=0.0, absence_finalize_s=10.0, max_visit_s=150.0)
    # the .open_visits.json should now hold the OPEN visit.
    assert "vid1" in visit_runtime.read_open_visits(str(tmp_path))

    # act — escalation hook (now well past last_seen=108).
    finalized = runner.finalize_open_visits_for_escalation(now=130.0)

    # assert — finalized at LAST_SEEN (108), not spanning the gap to 130; the
    # persisted table is drained BEFORE the caller proceeds to reboot.
    assert finalized == ["vid1"]
    assert len(events["finalize"]) == 1
    _vid, _start, end_ts = events["finalize"][0]
    assert end_ts == 108.0
    assert visit_runtime.read_open_visits(str(tmp_path)) == {}


# --------------------------------------------------------------------------- #
# 6. Persistence durability                                                    #
# --------------------------------------------------------------------------- #

def test_given_open_visits_when_persisted_then_roundtrips(tmp_path):
    # arrange / act
    rec_dir = str(tmp_path)
    table = {"v1": {"state": "OPEN", "start_ts": 1.0}}
    ok = visit_runtime.write_open_visits(rec_dir, table)

    # assert — file exists, fsync'd, and reads back identically.
    assert ok is True
    assert os.path.exists(os.path.join(rec_dir, ".open_visits.json"))
    assert visit_runtime.read_open_visits(rec_dir) == table


# --------------------------------------------------------------------------- #
# 7. Finalize catch-up copy (2026-07-07 replay-harness fixes)                 #
# --------------------------------------------------------------------------- #

def test_given_single_observe_visit_when_finalized_then_catchup_copy_covers_window(
    tmp_path,
):
    # arrange — tonight's prod bug: a visit whose subject appears on exactly
    # ONE frame never extends, so nothing ever copied ring segments into its
    # scratch ("finalize: scratch_dir unreadable ... FileNotFoundError").
    runner, events = _make_runner(tmp_path)
    runner.set_absence_finalize_s(10.0)
    runner.observe("person:cam1", (0.0, 0.0, 0.1, 0.1), now=100.0,
                   pre_roll_s=0.0, absence_finalize_s=10.0, max_visit_s=150.0)
    assert events["copy"] == [], "no extend yet -> no copy yet"

    # act — the absence deadline fires on an all-absent tick.
    runner.tick(now=120.0, absence_finalize_s=10.0, max_visit_s=150.0)

    # assert — a final catch-up copy ran over the FULL nominal window
    # [start_ts, end_ts] = [100, 110] BEFORE the finalize handoff, so the
    # scratch exists and the grace tail is included.
    assert events["copy"] == [("vid1", 100.0, 110.0)]
    assert len(events["finalize"]) == 1
    assert events["finalize"][0] == ("vid1", 100.0, 110.0)


def test_given_extended_visit_when_finalized_then_grace_tail_copied(tmp_path):
    # arrange — extends copied up to last_seen=108; the 10s grace tail after
    # it used to be absent from scratch (clip ~absence_s short -> at the
    # operator's 30s setting the ±10s duration check refused every clip).
    runner, events = _make_runner(tmp_path)
    runner.set_absence_finalize_s(10.0)
    box = (0.0, 0.0, 0.2, 0.2)
    runner.observe("person:cam1", box, now=100.0, pre_roll_s=0.0,
                   absence_finalize_s=10.0, max_visit_s=150.0)
    runner.observe("person:cam1", box, now=108.0, pre_roll_s=0.0,
                   absence_finalize_s=10.0, max_visit_s=150.0)
    assert events["copy"] == [("vid1", 100.0, 108.0)]

    # act
    runner.tick(now=125.0, absence_finalize_s=10.0, max_visit_s=150.0)

    # assert — catch-up copy extends the band to end_ts = 108 + 10 = 118.
    assert events["copy"][-1] == ("vid1", 100.0, 118.0)
    assert events["finalize"] == [("vid1", 100.0, 118.0)]


def test_given_escalation_drain_when_finalized_then_catchup_copy_runs(tmp_path):
    # arrange — a single-observe visit; the watchdog is about to reboot.
    runner, events = _make_runner(tmp_path)
    runner.set_absence_finalize_s(10.0)
    runner.observe("person:cam1", (0.0, 0.0, 0.2, 0.2), now=100.0,
                   pre_roll_s=0.0, absence_finalize_s=10.0, max_visit_s=150.0)

    # act
    runner.finalize_open_visits_for_escalation(now=104.0)

    # assert — the escalation drain also catch-up copies (at last_seen).
    assert events["copy"] == [("vid1", 100.0, 100.0)]
    assert events["finalize"] == [("vid1", 100.0, 100.0)]


# --------------------------------------------------------------------------- #
# 8. Bounded recovery retries (2026-07-07 replay-harness fix)                 #
# --------------------------------------------------------------------------- #

def test_given_finalize_keeps_failing_when_recovered_repeatedly_then_abandoned(
    tmp_path,
):
    # arrange — a FINALIZING entry whose scratch is gone for good: finalize
    # can never succeed. Tonight's prod journal showed this retrying on
    # every single boot, forever.
    rec_dir = str(tmp_path)
    _write_open_visit(rec_dir, "vid_lost")

    def validate(_path):
        return False

    def finalize(vid, scratch, s, e):
        return False

    # act — three recovery passes (three worker boots).
    s1 = visit_runtime.recover_open_visits(rec_dir, validate, finalize, now=300.0)
    s2 = visit_runtime.recover_open_visits(rec_dir, validate, finalize, now=400.0)
    s3 = visit_runtime.recover_open_visits(rec_dir, validate, finalize, now=500.0)

    # assert — two bounded retries survive in FINALIZING; the third attempt
    # (RECOVERY_MAX_FINALIZE_ATTEMPTS) abandons the entry loudly so the next
    # boot stops burning finalizes on unrecoverable footage.
    assert s1["failed"] == ["vid_lost"] and s1["abandoned"] == []
    assert s2["failed"] == ["vid_lost"] and s2["abandoned"] == []
    assert s3["failed"] == [] and s3["abandoned"] == ["vid_lost"]
    assert visit_runtime.read_open_visits(rec_dir) == {}

    # and a fourth pass is a clean no-op (idempotent after abandonment).
    s4 = visit_runtime.recover_open_visits(rec_dir, validate, finalize, now=600.0)
    assert s4 == {"skipped": [], "finalized": [], "failed": [], "abandoned": []}
