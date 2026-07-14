import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock


sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.modules.setdefault("jetson_inference", MagicMock())
sys.modules.setdefault("jetson_utils", MagicMock())

import detect  # noqa: E402


def _rule(kind="line_crossing", rule_id="porch_line", threshold=0.4):
    return {
        "id": rule_id,
        "name": "Porch line",
        "kind": kind,
        "enabled": True,
        "camera_id": "front_door",
        "points": (
            [[0.5, 0.0], [0.5, 1.0]]
            if kind == "line_crossing"
            else [[0.1, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9]]
        ),
        "labels": ["person"],
        "direction": "any",
        "dwell_s": 10.0,
        "threshold": threshold,
    }


def test_apply_config_canonicalizes_new_rule_audio_and_policy_fields():
    runtime = detect.RuntimeConfig(camera_id="front_door")
    warnings = detect.apply_config(runtime, {
        "smart_rules": [_rule()],
        "package_change_threshold": 99,
        "package_stable_s": 0,
        "audio_event_enabled": True,
        "audio_event_labels": ["audio_scream", "unknown"],
        "deterrence_enabled": True,
        "deterrence_action": "warning",
        "deterrence_duration_s": 99,
    })
    assert warnings == []
    assert [rule["id"] for rule in runtime.smart_rules] == ["porch_line"]
    assert runtime.package_change_threshold == 3.0
    assert runtime.package_stable_s == 2.0
    assert runtime.audio_event_enabled is True
    assert runtime.audio_event_labels == ["audio_scream"]
    assert runtime.deterrence_enabled is True
    assert runtime.deterrence_action == "warning"
    assert runtime.deterrence_duration_s == 60.0


def test_privacy_mode_forces_full_mask_and_exit_restores_configured_masks():
    runtime = detect.RuntimeConfig()
    configured = [[[0.1, 0.2], [0.3, 0.2], [0.3, 0.4]]]
    runtime.privacy_masks = configured
    assert detect.effective_privacy_masks(runtime) == configured
    runtime.operating_mode = "privacy"
    assert detect.effective_privacy_masks(runtime) == [[
        [0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0],
    ]]
    assert runtime.privacy_masks == configured
    runtime.operating_mode = "home"
    assert detect.effective_privacy_masks(runtime) == configured


def test_default_package_state_path_is_namespaced_per_camera(tmp_path):
    front = detect.default_package_state_path(str(tmp_path), "front_door")
    garage = detect.default_package_state_path(str(tmp_path), "garage")
    assert front != garage
    assert front.endswith(".package-rule-state-front_door.json")
    assert garage.endswith(".package-rule-state-garage.json")


def test_activity_payload_uses_only_strict_server_fields():
    payload = detect.build_activity_event_payload({
        "label": "line_crossing",
        "score": 0.8,
        "box": {
            "x": 0.1, "y": 0.2, "w": 0.3, "h": 0.4,
            "label": "person", "score": 0.8,
        },
        "rule_id": "porch_line",
        "rule_name": "Porch line",
        "correlation_id": "rule_porch_line_t1_1000_1",
        "crossing_direction": "forward",
        "dwell_s": 15.0,
    }, "front_door", related_event_id="segment2", visit_id="visit1",
       event_id="ruleevent1")
    assert payload["source"] == "vision"
    assert payload["related_event_id"] == "segment2"
    assert payload["visit_id"] == "visit1"
    assert payload["boxes"][0]["label"] == "person"
    assert "crossing_direction" not in payload
    assert "dwell_s" not in payload
    assert "deterrence" not in payload


def test_activity_relation_uses_current_segment_and_stable_root_visit(monkeypatch):
    from visit import VisitTracker

    ids = iter(["segment1", "segment2"])
    tracker = VisitTracker(id_factory=lambda: next(ids))
    tracker.observe(
        "person:front_door", (0, 0, 10, 10), now=100.0, pre_roll_s=0.0,
        absence_finalize_s=10.0, max_visit_s=5.0,
    )
    tracker.observe(
        "person:front_door", (0, 0, 10, 10), now=106.0, pre_roll_s=0.0,
        absence_finalize_s=10.0, max_visit_s=5.0,
    )
    monkeypatch.setattr(
        detect, "_VISIT_RUNNER", SimpleNamespace(tracker=tracker),
    )

    related = detect._activity_related_visit({
        "box": {"label": "person"},
    }, "front_door")

    assert related == {
        "related_event_id": "segment2",
        "visit_id": "segment1",
    }


def test_rule_box_normalization_is_independent_of_legacy_threshold_and_zone():
    detection = SimpleNamespace(
        ClassID=1, Confidence=0.45,
        Left=10, Top=20, Right=50, Bottom=80,
    )
    net = SimpleNamespace(GetClassDesc=lambda _class_id: "Person")
    boxes = detect.normalize_activity_boxes(
        [detection], net, 100.0, 100.0, [_rule(threshold=0.4)],
    )
    assert len(boxes) == 1
    assert boxes[0]["label"] == "person"
    assert boxes[0]["x"] == 0.1
    assert detect.normalize_activity_boxes(
        [detection], net, 100.0, 100.0, [_rule(threshold=0.5)],
    ) == []


def test_package_rule_labels_and_threshold_feed_blocker_boxes():
    detection = SimpleNamespace(
        ClassID=1, Confidence=0.45,
        Left=10, Top=20, Right=50, Bottom=80,
    )
    net = SimpleNamespace(GetClassDesc=lambda _class_id: "Person")
    boxes = detect.normalize_activity_boxes(
        [detection], net, 100.0, 100.0,
        [_rule(kind="package", rule_id="parcel", threshold=0.4)],
    )
    assert len(boxes) == 1
    assert boxes[0]["label"] == "person"


def test_metadata_signal_gate_drops_privacy_and_detection_off():
    runtime = detect.RuntimeConfig()
    assert detect.metadata_signal_allowed(runtime) is True
    runtime.operating_mode = "privacy"
    assert detect.metadata_signal_allowed(runtime) is False
    runtime.operating_mode = "home"
    runtime.enabled = False
    assert detect.metadata_signal_allowed(runtime) is False


def test_visit_face_enrichment_is_bounded_to_first_physical_segment(monkeypatch):
    class _Rgb(object):
        shape = (100, 100, 3)
        size = 30000

        def __getitem__(self, _key):
            return self

    calls = []

    class _Recognizer(object):
        def recognize_in_crop(self, _crop, **kwargs):
            calls.append(kwargs)
            return "Alice"

    monkeypatch.setattr(detect, "cuda_to_rgb_numpy", lambda _img: _Rgb())
    boxes = [{
        "x": 0.1, "y": 0.1, "w": 0.5, "h": 0.8,
        "label": "person", "score": 0.9,
    }]
    result = detect.prepare_visit_open_faces(
        "visit1", "person:front_door", boxes, object(), 0,
        _Recognizer(), "/captures", "front_door", "model",
    )
    assert result == {"person_name": "Alice", "person_names": ["Alice"]}
    assert calls[0]["event_id"] == "visit1"
    assert detect.prepare_visit_open_faces(
        "visit2", "person:front_door", boxes, object(), 1,
        _Recognizer(), "/captures", "front_door", "model",
    ) == {}
    assert len(calls) == 1
