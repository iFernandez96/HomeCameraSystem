"""Unit tests for the visit lifecycle state machine (detection/visit.py).

Run from `detection/`:
    /tmp/homecam-venv/bin/python -m pytest tests/test_visit.py -q

Pure-Python module — no jetson_inference / jetson_utils / I/O imports. These
pin the continuous-capture contract (docs/continuous_capture_plan.md S0/S1):

  ONE visit = ONE continuous clip window per emit key. The state machine
  converts a per-frame "is this subject present" stream into clip-lifecycle
  transitions (open / extend / finalize). A lingering subject that keeps
  re-appearing produces exactly ONE open + ONE finalize (the anti-teleport
  invariant) — NOT one segment per absence-grace period.

All times are seconds in whatever clock the caller injects (the `now` args),
so the suite drives a fully fake clock. `id_factory` is injected for
deterministic visit ids.
"""
import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from visit import VisitTracker  # noqa: E402


KEY = "person:cam1"
PRE_ROLL = 4.0
ABSENCE = 8.0
MAX_VISIT = 120.0
BOX = (10.0, 10.0, 110.0, 210.0)


def _ids(*values):
    """A deterministic id_factory yielding the given ids in order."""
    seq = list(values)
    idx = {"i": 0}

    def factory():
        v = seq[idx["i"] % len(seq)]
        idx["i"] += 1
        return v

    return factory


def _kinds(transitions):
    return [t["kind"] for t in transitions]


# 1. idle -> present => single open at now - pre_roll_s ----------------------


def test_given_idle_when_first_present_then_single_open_at_minus_preroll():
    # arrange
    t = VisitTracker(id_factory=_ids("v1"))
    # act
    out = t.observe(KEY, BOX, now=1000.0, pre_roll_s=PRE_ROLL,
                    absence_finalize_s=ABSENCE, max_visit_s=MAX_VISIT)
    # assert
    assert len(out) == 1
    assert out[0]["kind"] == "open"
    assert out[0]["key"] == KEY
    assert out[0]["visit_id"] == "v1"
    assert out[0]["start_ts"] == 1000.0 - PRE_ROLL


# 2. continuous 200s presence => exactly ONE open + ONE finalize -------------


def test_given_continuous_presence_when_observed_then_one_open_one_finalize():
    """THE anti-teleport invariant: 200 s of continuous presence at
    absence_finalize=8 is ONE visit, NOT 200/8 segments."""
    # arrange
    t = VisitTracker(id_factory=_ids("v1", "v2", "v3"))
    opens = []
    extends = []
    finals = []

    def record(out):
        for tr in out:
            if tr["kind"] == "open":
                opens.append(tr)
            elif tr["kind"] == "extend":
                extends.append(tr)
            elif tr["kind"] == "finalize":
                finals.append(tr)

    # act — present every 2 s for 200 s (well under max_visit cap via a big cap)
    big_cap = 10000.0
    now = 1000.0
    end = now + 200.0
    while now <= end:
        record(t.observe(KEY, BOX, now=now, pre_roll_s=PRE_ROLL,
                         absence_finalize_s=ABSENCE, max_visit_s=big_cap))
        now += 2.0
    # then the subject leaves; a later tick crosses the absence deadline
    record(t.tick(now=now + 100.0, absence_finalize_s=ABSENCE,
                  max_visit_s=big_cap))

    # assert
    assert len(opens) == 1
    assert len(finals) == 1
    assert len(extends) >= 50  # many extends, one per present frame after open


# 3. POST_ROLL re-detect before deadline => no finalize, countdown resets ----


def test_given_postroll_when_redetect_before_deadline_then_no_finalize_reset():
    # arrange — open, then go absent partway into the grace window.
    t = VisitTracker(id_factory=_ids("v1"))
    t.observe(KEY, BOX, now=1000.0, pre_roll_s=PRE_ROLL,
              absence_finalize_s=ABSENCE, max_visit_s=MAX_VISIT)
    # last_seen = 1000, deadline = 1008. Re-detect at 1005 (< deadline).
    # act
    out = t.observe(KEY, BOX, now=1005.0, pre_roll_s=PRE_ROLL,
                    absence_finalize_s=ABSENCE, max_visit_s=MAX_VISIT)
    # a tick at 1012 would have crossed the OLD deadline (1008) but not the new
    tick_out = t.tick(now=1012.0, absence_finalize_s=ABSENCE,
                      max_visit_s=MAX_VISIT)
    # assert — re-detect is an extend, not a finalize; deadline slid to 1013.
    assert _kinds(out) == ["extend"]
    assert out[0]["end_ts"] == 1005.0
    assert _kinds(tick_out) == []  # 1012 < new deadline 1005 + 8 = 1013
    assert t.active_visit_id(KEY) == "v1"


# 4. deadline passes => finalize at last_seen + absence_finalize_s -----------


def test_given_absence_when_deadline_passes_then_finalize_at_deadline():
    # arrange
    t = VisitTracker(id_factory=_ids("v1"))
    t.observe(KEY, BOX, now=1000.0, pre_roll_s=PRE_ROLL,
              absence_finalize_s=ABSENCE, max_visit_s=MAX_VISIT)
    # last_seen = 1000, deadline = 1008.
    # act — a tick just before the deadline does nothing.
    before = t.tick(now=1007.9, absence_finalize_s=ABSENCE,
                    max_visit_s=MAX_VISIT)
    # a tick after the deadline finalizes.
    after = t.tick(now=1050.0, absence_finalize_s=ABSENCE,
                   max_visit_s=MAX_VISIT)
    # assert
    assert before == []
    assert len(after) == 1
    fin = after[0]
    assert fin["kind"] == "finalize"
    assert fin["visit_id"] == "v1"
    assert fin["start_ts"] == 1000.0 - PRE_ROLL
    assert fin["end_ts"] == 1000.0 + ABSENCE  # last_seen + grace
    assert fin["segment_index"] == 0
    assert t.active_visit_id(KEY) is None


# 5. finalize then later re-detect => new distinct visit_id ------------------


def test_given_finalized_when_redetect_later_then_new_visit_id():
    # arrange
    t = VisitTracker(id_factory=_ids("v1", "v2"))
    t.observe(KEY, BOX, now=1000.0, pre_roll_s=PRE_ROLL,
              absence_finalize_s=ABSENCE, max_visit_s=MAX_VISIT)
    t.tick(now=1050.0, absence_finalize_s=ABSENCE, max_visit_s=MAX_VISIT)
    # act — a fresh presence well after finalize.
    out = t.observe(KEY, BOX, now=2000.0, pre_roll_s=PRE_ROLL,
                    absence_finalize_s=ABSENCE, max_visit_s=MAX_VISIT)
    # assert
    assert _kinds(out) == ["open"]
    assert out[0]["visit_id"] == "v2"
    assert out[0]["visit_id"] != "v1"


# 6. continuous presence past max_visit_s => finalize + continuation open ----


def test_given_presence_past_max_visit_then_finalize_and_continuation_open():
    """Hard max-duration cap is a non-resettable disk guard: emit
    [finalize, open] atomically, continuation adjacent at the nominal level."""
    # arrange — small cap so the cap trips while still present.
    t = VisitTracker(id_factory=_ids("v1", "v2"))
    cap = 30.0
    t.observe(KEY, BOX, now=1000.0, pre_roll_s=PRE_ROLL,
              absence_finalize_s=ABSENCE, max_visit_s=cap)
    # act — keep present; an observe at/after started_at + cap trips the split.
    out = t.observe(KEY, BOX, now=1035.0, pre_roll_s=PRE_ROLL,
                    absence_finalize_s=ABSENCE, max_visit_s=cap)
    # assert — atomic finalize-then-open.
    assert _kinds(out) == ["finalize", "open"]
    fin, opn = out
    assert fin["visit_id"] == "v1"
    assert fin["segment_index"] == 0
    assert opn["visit_id"] == "v2"
    assert opn["segment_index"] == 1
    # continuation adjacency at the nominal/SM level: v2.start_ts == v1.end_ts
    # EXACTLY, with NO pre-roll re-added.
    assert opn["start_ts"] == fin["end_ts"]
    assert opn["start_ts"] != 1035.0 - PRE_ROLL


# 7. brief one-frame flap (gap < absence) => no finalize, window stays open --


def test_given_brief_flap_when_under_grace_then_window_stays_open():
    # arrange
    t = VisitTracker(id_factory=_ids("v1"))
    t.observe(KEY, BOX, now=1000.0, pre_roll_s=PRE_ROLL,
              absence_finalize_s=ABSENCE, max_visit_s=MAX_VISIT)
    # act — a one-frame dropout: a tick mid-grace, then re-detect before deadline.
    mid = t.tick(now=1003.0, absence_finalize_s=ABSENCE, max_visit_s=MAX_VISIT)
    back = t.observe(KEY, BOX, now=1004.0, pre_roll_s=PRE_ROLL,
                     absence_finalize_s=ABSENCE, max_visit_s=MAX_VISIT)
    # assert — no finalize through the flap; the single window persists.
    assert mid == []
    assert _kinds(back) == ["extend"]
    assert t.active_visit_id(KEY) == "v1"


# 8. raising absence_finalize_s mid-visit => deadline extends ----------------


def test_given_raised_absence_mid_visit_then_deadline_extends():
    """absence_finalize_s is a CALL ARG (not stored) so a slider change takes
    effect on the next tick."""
    # arrange — open at default grace 8.
    t = VisitTracker(id_factory=_ids("v1"))
    t.observe(KEY, BOX, now=1000.0, pre_roll_s=PRE_ROLL,
              absence_finalize_s=8.0, max_visit_s=MAX_VISIT)
    # last_seen = 1000. With grace 8 the deadline is 1008.
    # act — operator raises grace to 30 mid-visit; tick at 1020.
    out = t.tick(now=1020.0, absence_finalize_s=30.0, max_visit_s=MAX_VISIT)
    # assert — 1020 < 1000 + 30 = 1030, so NO finalize.
    assert out == []
    assert t.active_visit_id(KEY) == "v1"
    # and dropping it back below now DOES finalize.
    out2 = t.tick(now=1020.0, absence_finalize_s=8.0, max_visit_s=MAX_VISIT)
    assert _kinds(out2) == ["finalize"]


# 9. different subject during POST_ROLL tail => old finalize + new open ------


def test_given_different_subject_in_postroll_then_old_finalize_new_open():
    # arrange — subject A opens, then goes absent into the grace window.
    t = VisitTracker(id_factory=_ids("vA", "vB"))
    a_box = (0.0, 0.0, 100.0, 100.0)
    b_box = (500.0, 500.0, 600.0, 600.0)  # disjoint -> IoU 0
    t.observe(KEY, a_box, now=1000.0, pre_roll_s=PRE_ROLL,
              absence_finalize_s=ABSENCE, max_visit_s=MAX_VISIT)
    # act — a clearly-different subject arrives at 1004 (within A's grace tail).
    out = t.observe(KEY, b_box, now=1004.0, pre_roll_s=PRE_ROLL,
                    absence_finalize_s=ABSENCE, max_visit_s=MAX_VISIT)
    # assert — A finalizes, B opens, distinct ids.
    assert _kinds(out) == ["finalize", "open"]
    fin, opn = out
    assert fin["visit_id"] == "vA"
    assert opn["visit_id"] == "vB"
    assert opn["start_ts"] == 1004.0 - PRE_ROLL
    assert t.active_visit_id(KEY) == "vB"


def test_given_same_subject_drift_in_window_then_just_extends():
    """IoU is ADVISORY: a continuation that still overlaps keeps one window."""
    # arrange
    t = VisitTracker(id_factory=_ids("v1"))
    t.observe(KEY, (0.0, 0.0, 100.0, 100.0), now=1000.0, pre_roll_s=PRE_ROLL,
              absence_finalize_s=ABSENCE, max_visit_s=MAX_VISIT)
    # act — a heavily-overlapping drift (IoU >= 0.3) re-stamps the box.
    out = t.observe(KEY, (10.0, 10.0, 110.0, 110.0), now=1002.0,
                    pre_roll_s=PRE_ROLL, absence_finalize_s=ABSENCE,
                    max_visit_s=MAX_VISIT)
    # assert
    assert _kinds(out) == ["extend"]
    assert t.active_visit_id(KEY) == "v1"


# snapshot is JSON-serializable -------------------------------------------


def test_given_open_visit_when_snapshot_then_json_serializable():
    # arrange
    import json
    t = VisitTracker(id_factory=_ids("v1"))
    t.observe(KEY, BOX, now=1000.0, pre_roll_s=PRE_ROLL,
              absence_finalize_s=ABSENCE, max_visit_s=MAX_VISIT)
    # act
    snap = t.snapshot()
    encoded = json.dumps(snap)  # raises if not serializable
    # assert
    assert isinstance(snap, dict)
    assert KEY in json.loads(encoded)


def test_given_many_keys_when_observed_then_bounded_at_max_keys():
    # arrange — max_keys small; push past it.
    t = VisitTracker(max_keys=4, id_factory=_ids(*["v%d" % i for i in range(50)]))
    # act — open 10 distinct keys, advancing time so older ones go stale.
    now = 1000.0
    for i in range(10):
        t.observe("k%d" % i, BOX, now=now, pre_roll_s=PRE_ROLL,
                  absence_finalize_s=ABSENCE, max_visit_s=MAX_VISIT)
        now += 100.0  # each new key makes prior ones long-absent
    # assert — never exceeds the cap.
    assert len(t.snapshot()) <= 4


# 10. property/fuzz: open/finalize pairing invariant ------------------------


def test_given_random_present_absent_sequence_then_open_finalize_well_paired():
    """For random present/absent streams the SM NEVER emits two 'open' for one
    key without an intervening 'finalize', and NEVER 'finalize' without a
    prior matching 'open'."""
    # arrange
    rng = random.Random(20260621)
    for trial in range(200):
        ids = ["v%d" % i for i in range(500)]
        t = VisitTracker(id_factory=_ids(*ids))
        open_active = False
        active_id = None
        now = 1000.0
        grace = rng.choice([5.0, 8.0, 15.0])
        cap = rng.choice([20.0, 60.0, 120.0])

        def check(out):
            # closure over open_active/active_id via list cells.
            for tr in out:
                if tr["kind"] == "open":
                    # no second open without an intervening finalize
                    assert state["open"] is False, (
                        "double open without finalize in trial %d" % trial)
                    state["open"] = True
                    state["id"] = tr["visit_id"]
                elif tr["kind"] == "finalize":
                    assert state["open"] is True, (
                        "finalize without a prior open in trial %d" % trial)
                    assert tr["visit_id"] == state["id"]
                    state["open"] = False
                    state["id"] = None
                elif tr["kind"] == "extend":
                    assert state["open"] is True

        state = {"open": open_active, "id": active_id}
        # act — random walk of present/absent frames.
        for _ in range(120):
            now += rng.uniform(0.5, 12.0)
            if rng.random() < 0.55:
                # present: jitter the box a little (still same subject mostly)
                box = (rng.uniform(0, 5), rng.uniform(0, 5),
                       100 + rng.uniform(0, 5), 100 + rng.uniform(0, 5))
                check(t.observe(KEY, box, now=now, pre_roll_s=PRE_ROLL,
                                absence_finalize_s=grace, max_visit_s=cap))
            else:
                # absent frame: just a tick.
                check(t.tick(now=now, absence_finalize_s=grace, max_visit_s=cap))
        # final flush tick well past any deadline.
        check(t.tick(now=now + 10000.0, absence_finalize_s=grace,
                     max_visit_s=cap))
        # assert — after a flush far past the deadline, nothing is left open.
        assert state["open"] is False
