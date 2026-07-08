"""Tests for services/camera_registry.py (docs/multicam_contract.md).

Pure-parse tests exercise `parse_cameras` offline (engineering
principle #2); registry tests pin the settings-backed re-read
behavior the push copy + /api/cameras route rely on.
"""
from __future__ import annotations

import logging

from app.config import settings
from app.services.camera_registry import (
    Camera,
    DEFAULT_CAMERAS,
    CameraRegistry,
    parse_cameras,
)


TWO_CAM_JSON = (
    '[{"id": "front_door", "name": "Front Door", "path": "cam"},'
    ' {"id": "back_yard", "name": "Back Yard", "path": "cam2"}]'
)


class TestParseCameras:
    def test_given_unset_env_when_parsing_then_default_registry_returned(
        self, caplog
    ):
        # arrange / act
        with caplog.at_level(
            logging.WARNING, logger="app.services.camera_registry"
        ):
            for raw in (None, "", "   "):
                cams = parse_cameras(raw)
                # assert
                assert cams == list(DEFAULT_CAMERAS)
        # Unset is the normal single-camera deploy — no warning noise.
        assert not caplog.records

    def test_given_valid_two_camera_json_when_parsing_then_both_returned_in_order(
        self,
    ):
        # act
        cams = parse_cameras(TWO_CAM_JSON)
        # assert
        assert cams == [
            Camera(id="front_door", name="Front Door", path="cam"),
            Camera(id="back_yard", name="Back Yard", path="cam2"),
        ]

    def test_given_malformed_json_when_parsing_then_falls_back_and_logs_why(
        self, caplog
    ):
        # arrange / act
        with caplog.at_level(
            logging.WARNING, logger="app.services.camera_registry"
        ):
            cams = parse_cameras("{not json")
        # assert
        assert cams == list(DEFAULT_CAMERAS)
        assert any("not valid JSON" in r.getMessage() for r in caplog.records)

    def test_given_non_array_json_when_parsing_then_falls_back_and_logs_why(
        self, caplog
    ):
        with caplog.at_level(
            logging.WARNING, logger="app.services.camera_registry"
        ):
            cams = parse_cameras('{"id": "front_door"}')
        assert cams == list(DEFAULT_CAMERAS)
        assert any(
            "non-empty JSON array" in r.getMessage() for r in caplog.records
        )

    def test_given_empty_array_when_parsing_then_falls_back(self, caplog):
        with caplog.at_level(
            logging.WARNING, logger="app.services.camera_registry"
        ):
            cams = parse_cameras("[]")
        assert cams == list(DEFAULT_CAMERAS)
        assert any(
            "non-empty JSON array" in r.getMessage() for r in caplog.records
        )

    def test_given_bad_camera_id_when_parsing_then_falls_back_and_logs_why(
        self, caplog
    ):
        # arrange: id has uppercase + hyphen, both outside the regex.
        raw = '[{"id": "Front-Door", "name": "Front Door", "path": "cam"}]'
        # act
        with caplog.at_level(
            logging.WARNING, logger="app.services.camera_registry"
        ):
            cams = parse_cameras(raw)
        # assert
        assert cams == list(DEFAULT_CAMERAS)
        assert any("id must match" in r.getMessage() for r in caplog.records)

    def test_given_oversized_camera_id_when_parsing_then_falls_back(self):
        raw = '[{{"id": "{}", "name": "X", "path": "cam"}}]'.format("a" * 33)
        assert parse_cameras(raw) == list(DEFAULT_CAMERAS)

    def test_given_duplicate_ids_when_parsing_then_falls_back_and_logs_why(
        self, caplog
    ):
        raw = (
            '[{"id": "front_door", "name": "A", "path": "cam"},'
            ' {"id": "front_door", "name": "B", "path": "cam2"}]'
        )
        with caplog.at_level(
            logging.WARNING, logger="app.services.camera_registry"
        ):
            cams = parse_cameras(raw)
        assert cams == list(DEFAULT_CAMERAS)
        assert any("duplicate id" in r.getMessage() for r in caplog.records)

    def test_given_missing_name_when_parsing_then_falls_back(self, caplog):
        raw = '[{"id": "front_door", "path": "cam"}]'
        with caplog.at_level(
            logging.WARNING, logger="app.services.camera_registry"
        ):
            cams = parse_cameras(raw)
        assert cams == list(DEFAULT_CAMERAS)
        assert any("name must be" in r.getMessage() for r in caplog.records)

    def test_given_bad_path_when_parsing_then_falls_back(self, caplog):
        raw = '[{"id": "front_door", "name": "Front Door", "path": "../x"}]'
        with caplog.at_level(
            logging.WARNING, logger="app.services.camera_registry"
        ):
            cams = parse_cameras(raw)
        assert cams == list(DEFAULT_CAMERAS)
        assert any("path must match" in r.getMessage() for r in caplog.records)

    def test_given_unknown_keys_when_parsing_then_falls_back(self, caplog):
        raw = (
            '[{"id": "front_door", "name": "Front Door", "path": "cam",'
            ' "rtsp": "rtsp://x"}]'
        )
        with caplog.at_level(
            logging.WARNING, logger="app.services.camera_registry"
        ):
            cams = parse_cameras(raw)
        assert cams == list(DEFAULT_CAMERAS)
        assert any("unknown keys" in r.getMessage() for r in caplog.records)


class TestCameraRegistry:
    def test_given_settings_change_when_cameras_called_then_registry_rereads(
        self, monkeypatch
    ):
        # arrange
        registry = CameraRegistry()
        monkeypatch.setattr(settings, "cameras_json", "")
        assert registry.cameras() == list(DEFAULT_CAMERAS)
        # act: flip the setting — no explicit reload step.
        monkeypatch.setattr(settings, "cameras_json", TWO_CAM_JSON)
        cams = registry.cameras()
        # assert
        assert [c.id for c in cams] == ["front_door", "back_yard"]
        assert registry.multi() is True

    def test_given_two_cameras_when_name_for_known_id_then_display_name(
        self, monkeypatch
    ):
        registry = CameraRegistry()
        monkeypatch.setattr(settings, "cameras_json", TWO_CAM_JSON)
        assert registry.name_for("back_yard") == "Back Yard"

    def test_given_unknown_id_when_name_for_then_none(self, monkeypatch):
        registry = CameraRegistry()
        monkeypatch.setattr(settings, "cameras_json", TWO_CAM_JSON)
        assert registry.name_for("garage") is None
        assert registry.get("garage") is None

    def test_given_default_registry_when_multi_then_false(self, monkeypatch):
        registry = CameraRegistry()
        monkeypatch.setattr(settings, "cameras_json", "")
        assert registry.multi() is False
