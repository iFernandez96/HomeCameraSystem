"""Unit tests for the presence-coalescing emit gate (detection/presence.py).

Run from `detection/`:
    /tmp/homecam-venv/bin/python -m pytest tests/test_presence.py -q

Pure-Python module — no jetson_inference / jetson_utils imports. These pin the
behavior that fixes the user-reported "events triggered multiple times" /
"teleporting" bug: one continuous presence = one event (+ segmented clips on a
long linger), not one event per ~5 s cooldown.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from presence import PresenceTracker, bbox_iou


# Standard call params for a "typical deploy": 90 s clips, 20 s presence gap,
# 5 s min-gap floor. A box helper keeps the cases readable.
CLIP = 90.0
GAP = 20.0
FLOOR = 5.0


def _emit(tracker, box, now, clip=CLIP, gap=GAP, floor=FLOOR, key="person:cam1"):
    return tracker.should_emit(key, box, now, clip, gap, floor)


# --- bbox_iou ---


def test_given_identical_boxes_when_iou_then_one():
    # arrange + act + assert
    assert bbox_iou((0, 0, 10, 10), (0, 0, 10, 10)) == 1.0


def test_given_disjoint_boxes_when_iou_then_zero():
    # arrange + act + assert
    assert bbox_iou((0, 0, 10, 10), (20, 20, 30, 30)) == 0.0


def test_given_half_overlap_when_iou_then_third():
    # arrange — two 10x10 boxes sharing a 5x10 overlap → inter 50, union 150.
    # act + assert
    assert abs(bbox_iou((0, 0, 10, 10), (5, 0, 15, 10)) - (50.0 / 150.0)) < 1e-9


# --- core coalescing behavior ---


def test_given_first_detection_when_should_emit_then_true():
    # arrange
    t = PresenceTracker()
    # act + assert — a brand-new presence always emits.
    assert _emit(t, (0, 0, 100, 200), now=1000.0) is True


def test_given_same_subject_lingering_within_clip_then_suppressed():
    """THE fix: a stationary subject re-detected every 5 s while its clip is
    still recording emits ONCE, not every cooldown."""
    # arrange — same box, detected every 5 s for ~60 s (< 90 s clip).
    t = PresenceTracker()
    box = (10, 10, 110, 210)
    # act
    first = _emit(t, box, now=1000.0)
    suppressed = [_emit(t, box, now=1000.0 + 5 * i) for i in range(1, 13)]  # 5..60 s
    # assert — one emit, then all suppressed (still inside the 90 s clip).
    assert first is True
    assert suppressed == [False] * 12


def test_given_long_linger_past_clip_when_should_emit_then_rearms_once():
    """A presence that outlasts its clip re-arms to the NEXT segment exactly
    once per clip length — so a 3 min linger is ~2 events, not ~36."""
    # arrange — same subject every 5 s for 190 s, 90 s clips.
    t = PresenceTracker()
    box = (10, 10, 110, 210)
    emits = []
    for i in range(0, 39):  # now = 1000 .. 1190 step 5
        emits.append(_emit(t, box, now=1000.0 + 5 * i))
    # assert — emit at t0 (new), again once past 90 s (~t=1090), again past
    # 180 s (~t=1180): exactly 3 emits across 190 s, the rest suppressed.
    assert sum(1 for e in emits if e) == 3


def test_given_subject_leaves_and_returns_after_gap_then_new_event():
    """Left-and-returned (gap exceeded) is a fresh visit → new event."""
    # arrange
    t = PresenceTracker()
    box = (10, 10, 110, 210)
    first = _emit(t, box, now=1000.0)
    # act — gone for 30 s (> 20 s gap), then returns.
    returned = _emit(t, box, now=1030.0)
    # assert
    assert first is True
    assert returned is True


def test_given_brief_disappearance_within_gap_then_still_coalesced():
    """A blink-out shorter than the presence gap stays the same visit."""
    # arrange
    t = PresenceTracker()
    box = (10, 10, 110, 210)
    _emit(t, box, now=1000.0)
    # act — gone 10 s (< 20 s gap), same spot, clip still recording.
    again = _emit(t, box, now=1010.0)
    # assert — coalesced, not re-emitted.
    assert again is False


def test_given_relocated_subject_past_floor_then_new_event():
    """A genuinely different/relocated box (IoU mismatch) past the min-gap
    floor emits a new event (e.g. a second person elsewhere in frame)."""
    # arrange
    t = PresenceTracker()
    _emit(t, (0, 0, 50, 100), now=1000.0)  # subject A, left side
    # act — subject B on the right, 6 s later (> 5 s floor), no overlap.
    other = _emit(t, (200, 0, 250, 100), now=1006.0)
    # assert
    assert other is True


def test_given_relocated_subject_within_floor_then_suppressed():
    """Even a mismatched box can't emit faster than the min-gap floor — guards
    against two subjects ping-pong-spamming."""
    # arrange
    t = PresenceTracker()
    _emit(t, (0, 0, 50, 100), now=1000.0)
    # act — different box only 2 s later (< 5 s floor).
    other = _emit(t, (200, 0, 250, 100), now=1002.0)
    # assert
    assert other is False


def test_given_walk_across_frame_when_overlapping_steps_then_coalesced():
    """A person walking across the FOV overlaps frame-to-frame at 5 fps, so
    the whole pass is ONE event, not one per step."""
    # arrange — box drifts right by 5 px each 0.2 s frame; boxes overlap.
    t = PresenceTracker()
    first = _emit(t, (0, 0, 100, 200), now=1000.0)
    steps = []
    for i in range(1, 20):
        steps.append(_emit(t, (5 * i, 0, 100 + 5 * i, 200), now=1000.0 + 0.2 * i))
    # assert — one emit; the drift keeps IoU above threshold so all coalesce.
    assert first is True
    assert not any(steps)


def test_given_independent_labels_then_keyed_separately():
    """person and cat are independent keys (a cat doesn't suppress a person)."""
    # arrange
    t = PresenceTracker()
    person = t.should_emit("person:cam1", (0, 0, 50, 100), 1000.0, CLIP, GAP, FLOOR)
    cat = t.should_emit("cat:cam1", (0, 0, 50, 100), 1000.5, CLIP, GAP, FLOOR)
    # assert — both emit; separate presences.
    assert person is True
    assert cat is True


def test_given_many_keys_then_dict_is_bounded():
    """Operator-misconfig guard: the presence dict can't grow unbounded."""
    # arrange — emit 50 distinct keys; cap is 32.
    t = PresenceTracker(max_keys=32)
    for i in range(50):
        t.should_emit("label%d:cam1" % i, (0, 0, 10, 10), 1000.0 + i, CLIP, GAP, FLOOR)
    # assert
    assert len(t._presence) <= 33  # cap + the just-inserted key
