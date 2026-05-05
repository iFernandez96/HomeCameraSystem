"""Tests for the detection-config endpoint + persistence layer."""
from __future__ import annotations

from fastapi.testclient import TestClient

from app.services.detection_config import (
    COOLDOWN_MAX,
    DetectionConfig,
    DetectionConfigStore,
    THRESHOLD_MAX,
    THRESHOLD_MIN,
)


# ---------- store ----------


def test_store_starts_with_defaults(tmp_path):
    s = DetectionConfigStore(path=tmp_path / "cfg.json")
    cfg = s.get()
    assert cfg.threshold == 0.55
    assert cfg.cooldown_s == 5.0


def test_store_persists_threshold(tmp_path):
    path = tmp_path / "cfg.json"
    s = DetectionConfigStore(path=path)
    s.update(threshold=0.7)

    # Reload from the same file — the new value must come back.
    s2 = DetectionConfigStore(path=path)
    assert s2.get().threshold == 0.7
    assert s2.get().cooldown_s == 5.0


def test_store_clamps_out_of_range_disk_value(tmp_path):
    path = tmp_path / "cfg.json"
    path.write_text('{"threshold": 99.0, "cooldown_s": -10.0}')
    s = DetectionConfigStore(path=path)
    cfg = s.get()
    assert cfg.threshold == THRESHOLD_MAX
    assert cfg.cooldown_s == 0.0


def test_store_handles_corrupt_disk_value(tmp_path):
    path = tmp_path / "cfg.json"
    path.write_text("not json {")
    s = DetectionConfigStore(path=path)
    # Falls back to defaults instead of raising.
    assert s.get() == DetectionConfig()


def test_store_handles_non_dict_top_level(tmp_path):
    path = tmp_path / "cfg.json"
    path.write_text("[1,2,3]")
    s = DetectionConfigStore(path=path)
    assert s.get() == DetectionConfig()


def test_store_handles_wrong_type_for_threshold(tmp_path):
    """A manually-edited config like `{"threshold": "high"}` used to
    crash the server boot with an uncaught ValueError from `float(...)`.
    Pin the per-field fallback so disk surprises don't ground the
    server. Surrounding fields remain valid."""
    path = tmp_path / "cfg.json"
    path.write_text('{"threshold": "high", "cooldown_s": 7.0}')
    s = DetectionConfigStore(path=path)
    cfg = s.get()
    # Bad threshold falls back to default, valid cooldown kept.
    assert cfg.threshold == 0.55
    assert cfg.cooldown_s == 7.0


def test_store_handles_wrong_type_for_cooldown(tmp_path):
    path = tmp_path / "cfg.json"
    path.write_text('{"threshold": 0.7, "cooldown_s": [1, 2, 3]}')
    s = DetectionConfigStore(path=path)
    cfg = s.get()
    assert cfg.threshold == 0.7
    assert cfg.cooldown_s == 5.0  # default


def test_store_handles_null_for_numeric_fields(tmp_path):
    """JSON null for a numeric field — `float(None)` raises TypeError;
    the helper must fall back to defaults the same as for strings."""
    path = tmp_path / "cfg.json"
    path.write_text('{"threshold": null, "cooldown_s": null}')
    s = DetectionConfigStore(path=path)
    cfg = s.get()
    assert cfg.threshold == 0.55
    assert cfg.cooldown_s == 5.0


def test_store_partial_update_preserves_other_field(tmp_path):
    s = DetectionConfigStore(path=tmp_path / "cfg.json")
    s.update(threshold=0.65)
    s.update(cooldown_s=3.0)
    cfg = s.get()
    assert cfg.threshold == 0.65
    assert cfg.cooldown_s == 3.0


# ---------- route ----------


def test_get_returns_current_config(client: TestClient):
    r = client.get("/api/detection/config")
    assert r.status_code == 200
    body = r.json()
    assert body == {
        "threshold": 0.55,
        "cooldown_s": 5.0,
        "enabled": True,
        "schedule_off_start": None,
        "schedule_off_end": None,
        "classes": ["person"],
        "zones": [],
        # iter-254: per-event clip duration knobs (post-roll live-
        # tunable; pre-roll persisted-only until iter-255).
        "clip_post_roll_s": 8.0,
        # iter-325: pre-roll lights up by default at 3 s (was 0.0 —
        # iter-254 shipped the field as a dead value; iter-324 wired
        # the buffer; iter-325 turns it on so the user gets the
        # Ring-style "saw them coming" clip without a Settings
        # nudge).
        "clip_pre_roll_s": 3.0,
        # iter-257: retention/clip-cap preset (week / month / 5y).
        "clip_retention_preset": "month",
        # iter-305: friendly camera label (default "Front Door" until
        # the user renames). Multi-cam (MC Phase 1+) will move this
        # under a per-camera section.
        "camera_label": "Front Door",
        # iter-308: two-way audio gating. Defaults false because most
        # deploys today don't have a mic + speaker wired to the Jetson.
        "audio_enabled": False,
        # iter-356.62 slice 3 (privacy controls): face/person capture
        # operator opt-out + TTL.
        "face_capture_enabled": True,
        "face_capture_retention_days": 30,
    }


def test_patch_updates_threshold(client: TestClient):
    r = client.patch("/api/detection/config", json={"threshold": 0.7})
    assert r.status_code == 200
    assert r.json()["threshold"] == 0.7
    # Read-back from a fresh GET reflects the change.
    r2 = client.get("/api/detection/config")
    assert r2.json()["threshold"] == 0.7


def test_patch_updates_cooldown(client: TestClient):
    r = client.patch("/api/detection/config", json={"cooldown_s": 10.0})
    assert r.status_code == 200
    assert r.json()["cooldown_s"] == 10.0


def test_patch_partial_keeps_other_field(client: TestClient):
    client.patch("/api/detection/config", json={"threshold": 0.8})
    client.patch("/api/detection/config", json={"cooldown_s": 2.0})
    r = client.get("/api/detection/config")
    body = r.json()
    assert body["threshold"] == 0.8
    assert body["cooldown_s"] == 2.0


def test_patch_rejects_out_of_range_threshold(client: TestClient):
    r = client.patch("/api/detection/config", json={"threshold": 1.5})
    assert r.status_code == 422


def test_patch_rejects_negative_cooldown(client: TestClient):
    r = client.patch("/api/detection/config", json={"cooldown_s": -1.0})
    assert r.status_code == 422


def test_patch_rejects_threshold_below_minimum(client: TestClient):
    r = client.patch("/api/detection/config", json={"threshold": THRESHOLD_MIN - 0.01})
    assert r.status_code == 422


def test_patch_rejects_cooldown_above_maximum(client: TestClient):
    r = client.patch("/api/detection/config", json={"cooldown_s": COOLDOWN_MAX + 1.0})
    assert r.status_code == 422


def test_patch_with_empty_body_rejects(client: TestClient):
    r = client.patch("/api/detection/config", json={})
    assert r.status_code == 422


def test_patch_rejects_unknown_field(client: TestClient):
    r = client.patch(
        "/api/detection/config",
        json={"threshold": 0.6, "model": "yolo"},
    )
    assert r.status_code == 422


# ---------- enabled toggle persistence ----------


def test_enabled_default_is_true(client: TestClient):
    r = client.get("/api/detection/config")
    assert r.json()["enabled"] is True


def test_patch_can_disable_detection(client: TestClient):
    r = client.patch("/api/detection/config", json={"enabled": False})
    assert r.status_code == 200
    assert r.json()["enabled"] is False


def test_disabled_state_survives_a_reload(tmp_path):
    """The whole point of moving the toggle into config: it persists."""
    path = tmp_path / "cfg.json"
    s = DetectionConfigStore(path=path)
    s.update(enabled=False)
    s2 = DetectionConfigStore(path=path)
    assert s2.get().enabled is False


def test_legacy_config_file_without_enabled_defaults_to_true(tmp_path):
    """A config file written by an earlier version of the server has no
    `enabled` key. Loading it must not flip detection off."""
    path = tmp_path / "cfg.json"
    path.write_text('{"threshold": 0.65, "cooldown_s": 7.0}')
    s = DetectionConfigStore(path=path)
    assert s.get().enabled is True


def test_load_treats_explicit_null_enabled_as_default(tmp_path):
    """A manually-edited config with `enabled: null` would silently
    disable detection if we used `bool(None)` (which is False) — pinned
    in iter-125 so explicit null falls back to the constructor default
    (True), matching the update() path's None semantics."""
    path = tmp_path / "cfg.json"
    path.write_text('{"threshold": 0.65, "enabled": null}')
    s = DetectionConfigStore(path=path)
    assert s.get().enabled is True


def test_detection_toggle_route_flips_enabled(client: TestClient):
    """The legacy /api/detection/toggle route is now backed by config — the
    in-memory `detection_service.active` is a property over `enabled`, so
    toggling persists."""
    initial = client.get("/api/detection/config").json()["enabled"]
    client.post("/api/detection/toggle")
    flipped = client.get("/api/detection/config").json()["enabled"]
    assert flipped is not initial


# ---------- schedule ----------


def test_schedule_defaults_to_disabled(client: TestClient):
    body = client.get("/api/detection/config").json()
    assert body["schedule_off_start"] is None
    assert body["schedule_off_end"] is None


def test_patch_sets_schedule_window(client: TestClient):
    r = client.patch(
        "/api/detection/config",
        json={"schedule_off_start": "23:00", "schedule_off_end": "06:00"},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["schedule_off_start"] == "23:00"
    assert body["schedule_off_end"] == "06:00"


def test_patch_clears_schedule_with_null(client: TestClient):
    client.patch(
        "/api/detection/config",
        json={"schedule_off_start": "23:00", "schedule_off_end": "06:00"},
    )
    r = client.patch(
        "/api/detection/config",
        json={"schedule_off_start": None, "schedule_off_end": None},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["schedule_off_start"] is None
    assert body["schedule_off_end"] is None


def test_patch_partial_schedule_keeps_other_field(client: TestClient):
    client.patch(
        "/api/detection/config",
        json={"schedule_off_start": "23:00", "schedule_off_end": "06:00"},
    )
    r = client.patch(
        "/api/detection/config", json={"schedule_off_start": "22:30"}
    )
    body = r.json()
    assert body["schedule_off_start"] == "22:30"
    assert body["schedule_off_end"] == "06:00"


def test_patch_rejects_invalid_time_format(client: TestClient):
    bad_values = ["24:00", "12:60", "12", "12:00:00", "noon", "1230"]
    for bad in bad_values:
        r = client.patch(
            "/api/detection/config", json={"schedule_off_start": bad}
        )
        assert r.status_code == 422, f"expected 422 for {bad}"


def test_in_schedule_off_window_simple_day_window():
    from app.services.detection_config import in_schedule_off_window

    # Window 09:00-17:00. Inside at 12:00, outside at 06:00 / 18:00.
    assert in_schedule_off_window("09:00", "17:00", 12, 0) is True
    assert in_schedule_off_window("09:00", "17:00", 6, 0) is False
    assert in_schedule_off_window("09:00", "17:00", 18, 0) is False
    # Boundary: start inclusive, end exclusive.
    assert in_schedule_off_window("09:00", "17:00", 9, 0) is True
    assert in_schedule_off_window("09:00", "17:00", 17, 0) is False


def test_in_schedule_off_window_overnight_wrap():
    from app.services.detection_config import in_schedule_off_window

    # Window 23:00 -> 06:00. Inside at 00:00, 02:30, 23:30. Outside at 12:00.
    assert in_schedule_off_window("23:00", "06:00", 0, 0) is True
    assert in_schedule_off_window("23:00", "06:00", 2, 30) is True
    assert in_schedule_off_window("23:00", "06:00", 23, 30) is True
    assert in_schedule_off_window("23:00", "06:00", 12, 0) is False
    # Boundaries.
    assert in_schedule_off_window("23:00", "06:00", 6, 0) is False
    assert in_schedule_off_window("23:00", "06:00", 23, 0) is True


def test_in_schedule_off_window_returns_false_for_missing_or_invalid():
    from app.services.detection_config import in_schedule_off_window

    assert in_schedule_off_window(None, "06:00", 5, 0) is False
    assert in_schedule_off_window("23:00", None, 5, 0) is False
    assert in_schedule_off_window("not-time", "06:00", 5, 0) is False
    # Zero-length window — no schedule.
    assert in_schedule_off_window("06:00", "06:00", 6, 0) is False


# ---------- classes ----------


def test_classes_default_is_person_only(client: TestClient):
    body = client.get("/api/detection/config").json()
    assert body["classes"] == ["person"]


def test_patch_classes(client: TestClient):
    r = client.patch("/api/detection/config", json={"classes": ["person", "car", "dog"]})
    assert r.status_code == 200
    assert r.json()["classes"] == ["person", "car", "dog"]


def test_patch_classes_normalizes_to_lowercase(client: TestClient):
    r = client.patch("/api/detection/config", json={"classes": ["PERSON", "Car", "  Dog "]})
    assert r.status_code == 200
    assert r.json()["classes"] == ["person", "car", "dog"]


def test_patch_classes_dedupes(client: TestClient):
    r = client.patch(
        "/api/detection/config", json={"classes": ["person", "person", "car"]}
    )
    assert r.json()["classes"] == ["person", "car"]


def test_patch_classes_drops_whitespace_only_strings(client: TestClient):
    """A whitespace-only class is legal at the route boundary
    (`min_length=1` after iter-112) but `_valid_classes` strips and
    drops it on the service side. Mixed valid + whitespace input
    yields just the valid entries. Empty strings (`""`) are
    route-rejected — see `test_patch_rejects_empty_string_in_classes`."""
    r = client.patch(
        "/api/detection/config", json={"classes": ["person", "  ", "car"]}
    )
    assert r.status_code == 200, r.text
    assert r.json()["classes"] == ["person", "car"]


def test_patch_classes_can_be_empty(client: TestClient):
    """Empty list is legal — means "detect nothing", a stronger off than enabled=false."""
    r = client.patch("/api/detection/config", json={"classes": []})
    assert r.status_code == 200
    assert r.json()["classes"] == []


def test_patch_rejects_more_than_30_classes(client: TestClient):
    huge = [f"class_{i}" for i in range(40)]
    r = client.patch("/api/detection/config", json={"classes": huge})
    assert r.status_code == 422


def test_patch_rejects_class_name_longer_than_64_chars(client: TestClient):
    """List length is capped at 30 (existing test). Per-element length
    was previously unbounded — `[\"x\" * 1_000_000]` would survive the
    list cap and persist to disk. Pin the iter-112 per-element cap so
    a single oversized class can't slip through."""
    r = client.patch(
        "/api/detection/config",
        json={"classes": ["person", "x" * 65]},
    )
    assert r.status_code == 422


def test_patch_rejects_empty_string_in_classes(client: TestClient):
    """The Pydantic per-element `min_length=1` rejects empty strings
    at the route boundary. _valid_classes still strips them on disk
    load (see test below) — both layers symmetric."""
    r = client.patch(
        "/api/detection/config",
        json={"classes": ["person", ""]},
    )
    assert r.status_code == 422


def test_load_drops_oversized_classes_from_disk(tmp_path):
    """A manually-edited config with an oversized class shouldn't
    poison the worker's runtime — _valid_classes filters at load."""
    path = tmp_path / "cfg.json"
    path.write_text(
        '{"classes": ["person", "' + "y" * 100 + '", "car"]}'
    )
    s = DetectionConfigStore(path=path)
    cfg = s.get()
    # The 100-char class was filtered out; valid sibling classes kept.
    assert cfg.classes == ["person", "car"]


def test_classes_persist_across_reload(tmp_path):
    path = tmp_path / "cfg.json"
    s = DetectionConfigStore(path=path)
    s.update(classes=["person", "car"])
    s2 = DetectionConfigStore(path=path)
    assert s2.get().classes == ["person", "car"]


# ---------- iter-191 (Feature #5): zones ----------


def test_default_zones_is_empty(tmp_path):
    """Empty default = no spatial gating = pre-iter-191 behaviour."""
    s = DetectionConfigStore(path=tmp_path / "cfg.json")
    assert s.get().zones == []


def test_store_persists_zones(tmp_path):
    path = tmp_path / "cfg.json"
    s = DetectionConfigStore(path=path)
    triangle = [[0.1, 0.1], [0.9, 0.1], [0.5, 0.9]]
    s.update(zones=[triangle])
    s2 = DetectionConfigStore(path=path)
    assert s2.get().zones == [triangle]


def test_load_drops_zones_with_too_few_vertices(tmp_path):
    """A 2-point polygon is degenerate (a line); filter at load."""
    path = tmp_path / "cfg.json"
    path.write_text(
        '{"zones": [[[0.1, 0.1], [0.5, 0.5]], [[0.0,0.0],[1.0,0.0],[0.5,1.0]]]}'
    )
    s = DetectionConfigStore(path=path)
    cfg = s.get()
    # First polygon dropped (only 2 points); second kept (3 points).
    assert len(cfg.zones) == 1
    assert cfg.zones[0] == [[0.0, 0.0], [1.0, 0.0], [0.5, 1.0]]


def test_load_drops_zones_with_out_of_range_coords(tmp_path):
    """Coords outside [0, 1] are nonsense in the normalized space."""
    path = tmp_path / "cfg.json"
    path.write_text('{"zones": [[[0.1,0.1],[1.5,0.5],[0.9,0.9]]]}')
    s = DetectionConfigStore(path=path)
    assert s.get().zones == []


def test_load_drops_zones_with_non_pair_points(tmp_path):
    """Each point must be exactly [x, y]."""
    path = tmp_path / "cfg.json"
    path.write_text('{"zones": [[[0.1,0.1],[0.5],[0.9,0.9]]]}')
    s = DetectionConfigStore(path=path)
    assert s.get().zones == []


def test_load_caps_zones_at_max(tmp_path):
    """ZONES_MAX bounds the polygon count."""
    from app.services.detection_config import ZONES_MAX

    triangle = "[[0,0],[1,0],[0.5,1]]"
    path = tmp_path / "cfg.json"
    path.write_text(
        '{{"zones": [{}]}}'.format(",".join([triangle] * (ZONES_MAX + 5)))
    )
    s = DetectionConfigStore(path=path)
    assert len(s.get().zones) == ZONES_MAX


# ---------- iter-191: PATCH /api/detection/config zones ----------


def test_patch_accepts_zones(client: TestClient):
    triangle = [[0.1, 0.1], [0.9, 0.1], [0.5, 0.9]]
    r = client.patch("/api/detection/config", json={"zones": [triangle]})
    assert r.status_code == 200
    assert r.json()["zones"] == [triangle]


def test_patch_rejects_zones_with_oversized_polygon_count(client: TestClient):
    """ZONES_MAX = 16; sending 17 must 422."""
    from app.services.detection_config import ZONES_MAX

    tri = [[0.0, 0.0], [1.0, 0.0], [0.5, 1.0]]
    r = client.patch(
        "/api/detection/config",
        json={"zones": [tri] * (ZONES_MAX + 1)},
    )
    assert r.status_code == 422


def test_patch_rejects_zones_with_too_few_vertices(client: TestClient):
    """A 2-point polygon must 422 at the route layer."""
    r = client.patch(
        "/api/detection/config",
        json={"zones": [[[0.1, 0.1], [0.5, 0.5]]]},
    )
    assert r.status_code == 422


def test_patch_rejects_zones_with_out_of_range_coord(client: TestClient):
    r = client.patch(
        "/api/detection/config",
        json={"zones": [[[0.1, 0.1], [1.5, 0.5], [0.9, 0.9]]]},
    )
    assert r.status_code == 422


def test_patch_rejects_zones_with_non_pair_point(client: TestClient):
    r = client.patch(
        "/api/detection/config",
        json={"zones": [[[0.1, 0.1], [0.5], [0.9, 0.9]]]},
    )
    assert r.status_code == 422


# ---------- iter-191: point_in_polygon helper (consumed by iter-191b) ----------


def test_point_in_polygon_inside_triangle():
    from app.services.detection_config import point_in_polygon

    tri = [[0.0, 0.0], [1.0, 0.0], [0.5, 1.0]]
    assert point_in_polygon(0.5, 0.4, tri) is True


def test_point_in_polygon_outside_triangle():
    from app.services.detection_config import point_in_polygon

    tri = [[0.0, 0.0], [1.0, 0.0], [0.5, 1.0]]
    assert point_in_polygon(0.0, 0.9, tri) is False


def test_point_in_polygon_degenerate_returns_false():
    """A polygon with <3 vertices can't enclose anything."""
    from app.services.detection_config import point_in_polygon

    assert point_in_polygon(0.5, 0.5, [[0.0, 0.0], [1.0, 1.0]]) is False
    assert point_in_polygon(0.5, 0.5, []) is False


# iter-254: per-event clip duration sliders (post-roll live-tunable;
# pre-roll persisted-only until iter-255 lands the rolling-segment
# recorder).

def test_when_clip_post_roll_s_patched_then_value_persists(client: TestClient):
    # arrange / act
    r = client.patch("/api/detection/config", json={"clip_post_roll_s": 15.0})

    # assert
    assert r.status_code == 200
    assert r.json()["clip_post_roll_s"] == 15.0
    r2 = client.get("/api/detection/config")
    assert r2.json()["clip_post_roll_s"] == 15.0


def test_when_clip_pre_roll_s_patched_then_value_persists(client: TestClient):
    # arrange / act
    r = client.patch("/api/detection/config", json={"clip_pre_roll_s": 12.0})

    # assert
    assert r.status_code == 200
    assert r.json()["clip_pre_roll_s"] == 12.0


def test_when_clip_post_roll_s_above_absolute_max_then_422(client: TestClient):
    # arrange — bound here is the absolute ceiling (week preset's
    # 30 min = 1800s). Above that, the route layer 422s. Per-preset
    # caps are enforced inside the store's update() path.
    r = client.patch("/api/detection/config", json={"clip_post_roll_s": 3600.0})

    # assert
    assert r.status_code == 422


def test_when_preset_is_year_5_and_post_roll_set_to_60s_then_clamped_to_30s(
    client: TestClient,
):
    # arrange — year_5 caps post-roll at 30s. A 60s value lands
    # but gets silently clamped (the route layer accepts up to the
    # absolute ceiling; the store re-clamps to the preset's cap).
    r = client.patch(
        "/api/detection/config",
        json={"clip_retention_preset": "year_5", "clip_post_roll_s": 60.0},
    )

    # assert
    assert r.status_code == 200
    assert r.json()["clip_post_roll_s"] == 30.0
    assert r.json()["clip_retention_preset"] == "year_5"


def test_when_preset_changed_to_year_5_then_existing_high_post_roll_clamps_down(
    client: TestClient,
):
    # arrange — set a high post-roll under "week" preset, then
    # switch to "year_5". The active value must clamp to the new
    # tier's cap automatically.
    client.patch(
        "/api/detection/config",
        json={"clip_retention_preset": "week", "clip_post_roll_s": 600.0},
    )
    r = client.patch(
        "/api/detection/config",
        json={"clip_retention_preset": "year_5"},
    )

    # assert
    assert r.status_code == 200
    body = r.json()
    assert body["clip_retention_preset"] == "year_5"
    assert body["clip_post_roll_s"] == 30.0


def test_when_clip_post_roll_s_below_min_then_422(client: TestClient):
    # arrange — bound is 3s minimum (any shorter and the clip
    # captures the moment of detection but nothing meaningful
    # after).
    r = client.patch("/api/detection/config", json={"clip_post_roll_s": 1.0})

    # assert
    assert r.status_code == 422


def test_given_worker_polls_internal_config_then_clip_durations_appear(client: TestClient):
    # arrange — worker reads the unauth carve-out (iter-244).
    client.patch(
        "/api/detection/config",
        json={"clip_post_roll_s": 12.0, "clip_pre_roll_s": 5.0},
    )

    # act
    r = client.get("/api/_internal/detection/config")

    # assert
    body = r.json()
    assert body["clip_post_roll_s"] == 12.0
    assert body["clip_pre_roll_s"] == 5.0


# iter-305 (user "How do I know which cam is which?"): camera_label
# field. Pin the wire shape + sanitization paths.

def test_given_default_config_when_get_called_then_camera_label_is_front_door(
    client: TestClient,
):
    # act
    r = client.get("/api/detection/config")

    # assert — default friendly label, not empty.
    assert r.json()["camera_label"] == "Front Door"


def test_given_user_patches_camera_label_when_get_called_then_new_label_returned(
    client: TestClient,
):
    # arrange
    r = client.patch(
        "/api/detection/config",
        json={"camera_label": "Driveway"},
    )
    assert r.status_code == 200

    # act
    body = client.get("/api/detection/config").json()

    # assert
    assert body["camera_label"] == "Driveway"


def test_given_oversized_camera_label_when_patched_then_422(client: TestClient):
    # arrange — Pydantic max_length=32 rejects.
    long_name = "a" * 33

    # act
    r = client.patch(
        "/api/detection/config",
        json={"camera_label": long_name},
    )

    # assert
    assert r.status_code == 422


def test_given_blank_camera_label_when_patched_then_422(client: TestClient):
    # arrange — Pydantic min_length=1 rejects.

    # act
    r = client.patch(
        "/api/detection/config",
        json={"camera_label": ""},
    )

    # assert
    assert r.status_code == 422


def test_given_corrupt_camera_label_in_config_file_when_loaded_then_falls_back_to_default(
    tmp_path,
):
    """Service-layer defense in depth: a manually-edited config file
    with a non-string camera_label loads cleanly with the default
    (won't crash startup)."""
    # arrange
    from app.services.detection_config import DetectionConfigStore
    cfg_path = tmp_path / "cfg.json"
    cfg_path.write_text('{"camera_label": 12345}')

    # act
    store = DetectionConfigStore(path=cfg_path)

    # assert
    assert store.get().camera_label == "Front Door"


# iter-308 (user "make the infrustructure for two-way audio"):
# audio_enabled is the user-facing gate that lights up Talk + Listen
# UI affordances. Defaults to false (no hardware) so existing deploys
# don't suddenly show non-functional buttons.

def test_given_default_config_when_get_called_then_audio_enabled_is_false(
    client: TestClient,
):
    # act
    r = client.get("/api/detection/config")

    # assert
    assert r.json()["audio_enabled"] is False


def test_given_owner_patches_audio_enabled_when_get_called_then_returned(
    client: TestClient,
):
    # arrange
    r = client.patch("/api/detection/config", json={"audio_enabled": True})
    assert r.status_code == 200

    # act
    body = client.get("/api/detection/config").json()

    # assert
    assert body["audio_enabled"] is True


def test_given_audio_enabled_set_when_store_reloaded_then_value_persists(tmp_path):
    """The whole point of moving toggles into config: they survive
    container restart. Mirror the iter-125 enabled-toggle pin."""
    # arrange
    from app.services.detection_config import DetectionConfigStore
    path = tmp_path / "cfg.json"
    s = DetectionConfigStore(path=path)
    s.update(audio_enabled=True)

    # act
    s2 = DetectionConfigStore(path=path)

    # assert
    assert s2.get().audio_enabled is True


# ---------- iter-356.62 slice 3 (privacy controls): face_capture fields ----------


def test_when_loaded_default_then_face_capture_enabled_is_true_and_retention_30(
    client: TestClient,
):
    # arrange / act
    body = client.get("/api/detection/config").json()

    # assert
    assert body["face_capture_enabled"] is True
    assert body["face_capture_retention_days"] == 30


def test_given_patch_with_retention_15_when_save_then_persisted(client: TestClient):
    # arrange / act
    r = client.patch(
        "/api/detection/config",
        json={"face_capture_retention_days": 15},
    )

    # assert
    assert r.status_code == 200, r.text
    assert r.json()["face_capture_retention_days"] == 15
    body = client.get("/api/detection/config").json()
    assert body["face_capture_retention_days"] == 15


def test_given_invalid_retention_when_patch_then_clamped_or_rejected(
    client: TestClient,
):
    # arrange / act — way above the 365 cap → 422 from Pydantic Field
    r_high = client.patch(
        "/api/detection/config",
        json={"face_capture_retention_days": 9999},
    )
    # below the floor (0) → 422
    r_low = client.patch(
        "/api/detection/config",
        json={"face_capture_retention_days": 0},
    )

    # assert
    assert r_high.status_code == 422
    assert r_low.status_code == 422


def test_given_face_capture_enabled_patch_when_get_then_value_round_trips(
    client: TestClient,
):
    # arrange / act
    r = client.patch(
        "/api/detection/config",
        json={"face_capture_enabled": False},
    )

    # assert
    assert r.status_code == 200
    body = client.get("/api/detection/config").json()
    assert body["face_capture_enabled"] is False


def test_given_face_capture_fields_when_store_reloaded_then_persist(tmp_path):
    # arrange
    from app.services.detection_config import DetectionConfigStore
    path = tmp_path / "cfg.json"
    s = DetectionConfigStore(path=path)
    s.update(face_capture_enabled=False, face_capture_retention_days=45)

    # act
    s2 = DetectionConfigStore(path=path)

    # assert
    assert s2.get().face_capture_enabled is False
    assert s2.get().face_capture_retention_days == 45


def test_given_disk_load_with_out_of_range_retention_when_loaded_then_clamped(
    tmp_path,
):
    # arrange — manually-edited config with crazy retention
    from app.services.detection_config import (
        DetectionConfigStore,
        FACE_CAPTURE_RETENTION_MAX,
        FACE_CAPTURE_RETENTION_MIN,
    )
    path = tmp_path / "cfg.json"
    path.write_text('{"face_capture_retention_days": 99999}')

    # act
    s = DetectionConfigStore(path=path)

    # assert
    assert s.get().face_capture_retention_days == FACE_CAPTURE_RETENTION_MAX

    path.write_text('{"face_capture_retention_days": -100}')
    s2 = DetectionConfigStore(path=path)
    assert s2.get().face_capture_retention_days == FACE_CAPTURE_RETENTION_MIN


def test_given_internal_config_endpoint_when_get_then_face_capture_fields_present(
    client_anon: TestClient,
):
    """The worker polls /api/_internal/detection/config (unauth) for
    config every 30s. Slice 1 (worker hot path, parallel worktree)
    will read face_capture_enabled here to gate the JPEG write —
    surface it on the wire."""
    # arrange / act
    r = client_anon.get("/api/_internal/detection/config")

    # assert
    assert r.status_code == 200, r.text
    body = r.json()
    assert "face_capture_enabled" in body
    assert "face_capture_retention_days" in body
