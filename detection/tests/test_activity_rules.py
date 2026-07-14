import json
import os
import sys
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from activity_rules import (  # noqa: E402
    ActivityRuleEngine,
    BoundedObjectTracker,
    sample_package_polygon,
    sanitize_rules,
)


def _box(cx, cy=0.5, label="person", score=0.9, size=0.1):
    return {
        "x": cx - size / 2.0,
        "y": cy - size / 2.0,
        "w": size,
        "h": size,
        "label": label,
        "score": score,
    }


def _rule(rule_id, kind, points, **changes):
    value = {
        "id": rule_id,
        "name": rule_id.replace("_", " ").title(),
        "kind": kind,
        "enabled": True,
        "camera_id": "front_door",
        "points": points,
        "labels": ["person"],
        "direction": "any",
        "dwell_s": 5.0,
        "threshold": 0.5,
    }
    value.update(changes)
    return value


class _PatternImage(object):
    """Tiny numpy-like RGB image generated deterministically on access."""

    def __init__(self, variant="empty", brightness=0.0):
        self.shape = (96, 96, 3)
        self.variant = variant
        self.brightness = float(brightness)

    def __getitem__(self, key):
        y, x = key
        # Textured floor; a global brightness change must disappear after the
        # package sampler's illumination normalization.
        base = 45.0 + ((x * 7 + y * 11) % 80) + self.brightness
        if self.variant == "occupied" and 28 <= x <= 68 and 26 <= y <= 72:
            base = 210.0 - ((x * 13 + y * 3) % 70) + self.brightness
        value = max(0.0, min(255.0, base))
        return (value, value, value)


def test_given_invalid_and_other_camera_rules_when_sanitized_then_only_local_valid_remains():
    # arrange
    valid = _rule("porch_line", "line_crossing", [[0.5, 0.0], [0.5, 1.0]])
    other = dict(valid, id="yard_line", camera_id="yard")
    invalid = dict(valid, id="Bad-ID")

    # act
    result = sanitize_rules([valid, other, invalid], camera_id="front_door")

    # assert
    assert [rule["id"] for rule in result] == ["porch_line"]
    assert result[0]["labels"] == ["person"]


def test_given_two_people_when_associated_then_tracks_stay_distinct_and_bounded():
    # arrange
    tracker = BoundedObjectTracker(max_tracks=2)

    # act
    first = tracker.observe([_box(0.2), _box(0.8)], 0.0)
    second = tracker.observe([_box(0.25), _box(0.75)], 1.0)
    tracker.observe([_box(0.5, label="dog")], 2.0)

    # assert
    assert len(first) == 2
    assert {track["id"] for track in first} == {track["id"] for track in second}
    assert len(tracker.active()) == 2


def test_given_finite_oriented_line_when_track_crosses_then_direction_is_enforced():
    # arrange — vertical line; left->right is reverse under the documented
    # points[0]->points[1] orientation.
    line = _rule(
        "porch_line", "line_crossing", [[0.5, 0.2], [0.5, 0.8]],
        direction="reverse",
    )
    engine = ActivityRuleEngine("front_door", [line])

    # act
    assert engine.observe_boxes([_box(0.35)], 0.0) == []
    events = engine.observe_boxes([_box(0.60)], 1.0)

    # assert
    assert len(events) == 1
    assert events[0]["label"] == "line_crossing"
    assert events[0]["crossing_direction"] == "reverse"
    assert events[0]["rule_id"] == "porch_line"


def test_given_motion_crosses_only_infinite_extension_then_no_line_event():
    # arrange — movement is above the finite y=.2..8 line segment.
    line = _rule(
        "short_line", "line_crossing", [[0.5, 0.2], [0.5, 0.8]],
        direction="any",
    )
    engine = ActivityRuleEngine("front_door", [line])

    # act / assert
    assert engine.observe_boxes([_box(0.35, 0.93)], 0.0) == []
    assert engine.observe_boxes([_box(0.60, 0.93)], 1.0) == []


def test_given_line_deadband_jitter_then_no_repeated_crossing():
    # arrange
    line = _rule("line", "line_crossing", [[0.5, 0.0], [0.5, 1.0]])
    engine = ActivityRuleEngine("front_door", [line])

    # act — all centers remain inside the 1.5% deadband.
    events = []
    for index, center in enumerate((0.49, 0.505, 0.495, 0.51)):
        events.extend(engine.observe_boxes([_box(center, size=0.02)], float(index)))

    # assert
    assert events == []


def test_given_person_dwells_then_loiter_fires_once_and_rearms_after_exit():
    # arrange
    zone = _rule(
        "porch", "loitering",
        [[0.2, 0.2], [0.6, 0.2], [0.6, 0.8], [0.2, 0.8]],
        dwell_s=5.0,
    )
    engine = ActivityRuleEngine("front_door", [zone])

    # act / assert — first stay emits once.
    assert engine.observe_boxes([_box(0.4)], 0.0) == []
    assert engine.observe_boxes([_box(0.42)], 3.0) == []
    first = engine.observe_boxes([_box(0.43)], 5.1)
    assert [event["label"] for event in first] == ["loitering"]
    assert engine.observe_boxes([_box(0.44)], 8.0) == []

    # Exit using a small enough move to retain the same object track, then
    # re-enter and satisfy a fresh dwell window.
    assert engine.observe_boxes([_box(0.68)], 9.0) == []
    assert engine.observe_boxes([_box(0.50)], 10.0) == []
    assert engine.observe_boxes([_box(0.50)], 13.0) == []
    second = engine.observe_boxes([_box(0.51)], 15.1)
    assert [event["label"] for event in second] == ["loitering"]
    assert second[0]["correlation_id"] != first[0]["correlation_id"]


def test_given_global_brightness_shift_when_sampling_then_normalized_scene_is_unchanged():
    # arrange
    polygon = [[0.1, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9]]

    # act
    first = sample_package_polygon(_PatternImage("empty", 0), polygon)
    second = sample_package_polygon(_PatternImage("empty", 40), polygon)

    # assert
    assert first is not None and second is not None
    delta = sum(abs(a - b) for a, b in zip(first, second)) / len(first)
    assert delta < 1e-9


def test_given_stable_package_zone_when_object_appears_and_clears_then_lifecycle_correlates(tmp_path):
    # arrange
    polygon = [[0.1, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9]]
    package = _rule("parcel_spot", "package", polygon)
    state_path = tmp_path / "package-state.json"
    engine = ActivityRuleEngine(
        "front_door", [package], package_change_threshold=0.25,
        package_stable_s=4.0, package_state_path=str(state_path),
    )

    # act — stable empty scene calibrates silently.
    assert engine.observe_package_frame(_PatternImage("empty"), 0.0) == []
    assert engine.observe_package_frame(_PatternImage("empty"), 5.0) == []
    assert state_path.exists()

    # A stable changed scene means a possible porch object appeared.
    assert engine.observe_package_frame(_PatternImage("occupied"), 10.0) == []
    delivered = engine.observe_package_frame(_PatternImage("occupied"), 15.0)
    assert len(delivered) == 1
    assert delivered[0]["label"] == "package_delivered"
    assert delivered[0]["package_state"] == "delivered"

    # Returning close to the calibrated empty scene means it was collected.
    assert engine.observe_package_frame(_PatternImage("empty"), 20.0) == []
    collected = engine.observe_package_frame(_PatternImage("empty"), 25.0)

    # assert
    assert len(collected) == 1
    assert collected[0]["label"] == "package_collected"
    assert collected[0]["correlation_id"] == delivered[0]["correlation_id"]
    persisted = json.loads(state_path.read_text())
    assert persisted["rules"]["parcel_spot"]["state"] == "empty"
    assert (os.stat(str(state_path)).st_mode & 0o777) == 0o600


def test_given_occupied_state_reloaded_when_scene_clears_then_collected_keeps_correlation(tmp_path):
    # arrange / calibrate / deliver with engine 1.
    polygon = [[0.1, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9]]
    package = _rule("parcel", "package", polygon)
    path = str(tmp_path / "state.json")
    first = ActivityRuleEngine(
        "front_door", [package], 0.25, 2.0, package_state_path=path,
    )
    first.observe_package_frame(_PatternImage("empty"), 0.0)
    first.observe_package_frame(_PatternImage("empty"), 3.0)
    first.observe_package_frame(_PatternImage("occupied"), 6.0)
    delivered = first.observe_package_frame(_PatternImage("occupied"), 9.0)[0]

    # act — simulate worker restart, then removal.
    second = ActivityRuleEngine(
        "front_door", [package], 0.25, 2.0, package_state_path=path,
    )
    second.observe_package_frame(_PatternImage("empty"), 12.0)
    collected = second.observe_package_frame(_PatternImage("empty"), 15.0)[0]

    # assert
    assert collected["package_state"] == "collected"
    assert collected["correlation_id"] == delivered["correlation_id"]


def test_given_person_in_package_zone_when_scene_changes_then_transition_waits_until_clear():
    # arrange
    polygon = [[0.1, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9]]
    package = _rule("parcel", "package", polygon)
    engine = ActivityRuleEngine("front_door", [package], 0.25, 2.0)
    engine.observe_package_frame(_PatternImage("empty"), 0.0)
    engine.observe_package_frame(_PatternImage("empty"), 3.0)

    # act — tracked person freezes candidate accumulation.
    engine.observe_boxes([_box(0.5)], 4.0)
    assert engine.observe_package_frame(_PatternImage("occupied"), 5.0) == []
    assert engine.observe_package_frame(_PatternImage("occupied"), 8.0) == []
    engine.tick(9.0)  # expires the four-second track gap
    assert engine.observe_package_frame(_PatternImage("occupied"), 9.0) == []
    result = engine.observe_package_frame(_PatternImage("occupied"), 12.0)

    # assert
    assert [event["package_state"] for event in result] == ["delivered"]


def test_package_rule_boxes_feed_blocker_tracker_without_object_rule_events():
    polygon = [[0.1, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9]]
    package = _rule("parcel", "package", polygon, threshold=0.7)
    engine = ActivityRuleEngine("front_door", [package])
    observed = []
    state = engine._package_state["parcel"]
    state.observe = lambda sample, now, blocked, rule_id: (
        observed.append(blocked) or (None, False)
    )

    assert engine.observe_boxes([_box(0.5, score=0.8)], 1.0) == []
    engine.observe_package_frame(_PatternImage("empty"), 1.0)
    assert observed[-1] is True
    assert engine.observe_boxes([_box(0.5, score=0.5)], 2.0) == []
    engine.observe_package_frame(_PatternImage("empty"), 2.0)
    assert observed[-1] is False


def test_package_fingerprint_change_resets_calibration_and_persists_new_shape(tmp_path):
    first_polygon = [[0.1, 0.1], [0.8, 0.1], [0.8, 0.8], [0.1, 0.8]]
    second_polygon = [[0.2, 0.2], [0.9, 0.2], [0.9, 0.9], [0.2, 0.9]]
    path = str(tmp_path / "state.json")
    engine = ActivityRuleEngine(
        "front_door", [_rule("parcel", "package", first_polygon)],
        package_stable_s=2.0, package_state_path=path,
    )
    engine.observe_package_frame(_PatternImage("empty"), 0.0)
    engine.observe_package_frame(_PatternImage("empty"), 3.0)
    assert engine._package_state["parcel"].baseline is not None

    engine.set_rules([_rule("parcel", "package", second_polygon)])
    assert engine._package_state["parcel"].baseline is None
    assert engine._package_dirty is True
    engine.tick(4.0)
    with open(path, "r") as handle:
        persisted = json.load(handle)
    fingerprint = json.loads(persisted["rules"]["parcel"]["fingerprint"])
    assert fingerprint["points"] == second_polygon


def test_failed_package_persistence_stays_dirty_and_retries_later():
    polygon = [[0.1, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9]]
    engine = ActivityRuleEngine(
        "front_door", [_rule("parcel", "package", polygon)],
    )
    calls = []

    def save(_camera_id, _snapshots):
        calls.append(True)
        return len(calls) > 1

    engine.store.save = save
    engine._package_dirty = True
    engine.tick(10.0)
    assert engine._package_dirty is True
    engine.tick(14.0)
    assert len(calls) == 1
    engine.tick(15.0)
    assert len(calls) == 2
    assert engine._package_dirty is False


def test_suspend_clears_candidate_but_preserves_package_baseline_and_state():
    polygon = [[0.1, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9]]
    engine = ActivityRuleEngine(
        "front_door", [_rule("parcel", "package", polygon)],
        package_change_threshold=0.25, package_stable_s=2.0,
    )
    engine.observe_package_frame(_PatternImage("empty"), 0.0)
    engine.observe_package_frame(_PatternImage("empty"), 3.0)
    state = engine._package_state["parcel"]
    baseline = list(state.baseline)
    engine.observe_package_frame(_PatternImage("occupied"), 5.0)
    assert state._candidate == "occupied"

    engine.suspend()
    assert state._candidate is None
    assert state.state == "empty"
    assert state.baseline == baseline
    assert engine.observe_package_frame(_PatternImage("occupied"), 8.0) == []
    assert engine.observe_package_frame(_PatternImage("occupied"), 11.0)


def test_delayed_authoritative_rules_restore_once_but_deleted_rules_do_not_resurrect(tmp_path):
    polygon = [[0.1, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9]]
    rule = _rule("parcel", "package", polygon)
    path = str(tmp_path / "state.json")
    first = ActivityRuleEngine(
        "front_door", [rule], package_stable_s=2.0,
        package_state_path=path,
    )
    first.observe_package_frame(_PatternImage("empty"), 0.0)
    first.observe_package_frame(_PatternImage("empty"), 3.0)

    delayed = ActivityRuleEngine("front_door", [], package_state_path=path)
    delayed.set_rules([rule], authoritative=True)
    assert delayed._package_state["parcel"].baseline is not None

    deleted = ActivityRuleEngine("front_door", [], package_state_path=path)
    deleted.set_rules([], authoritative=True)
    deleted.set_rules([rule], authoritative=True)
    assert deleted._package_state["parcel"].baseline is None
