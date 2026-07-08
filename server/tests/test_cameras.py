"""Tests for GET /api/cameras (docs/multicam_contract.md).

Wire-shape mirror: client/src/lib/api.test.ts pins `getCameras()`
against this same `{"cameras": [{id,name,path}]}` shape.
"""
from __future__ import annotations

from fastapi.testclient import TestClient

from app.config import settings


TWO_CAM_JSON = (
    '[{"id": "front_door", "name": "Front Door", "path": "cam"},'
    ' {"id": "back_yard", "name": "Back Yard", "path": "cam2"}]'
)


def test_given_default_registry_when_get_cameras_then_single_front_door_entry(
    client: TestClient,
):
    # act
    r = client.get("/api/cameras")
    # assert
    assert r.status_code == 200, r.text
    assert r.json() == {
        "cameras": [
            {"id": "front_door", "name": "Front Door", "path": "cam"},
        ]
    }


def test_given_two_camera_env_when_get_cameras_then_both_listed_in_order(
    client: TestClient, monkeypatch,
):
    # arrange
    monkeypatch.setattr(settings, "cameras_json", TWO_CAM_JSON)
    # act
    r = client.get("/api/cameras")
    # assert
    assert r.status_code == 200, r.text
    cams = r.json()["cameras"]
    assert [c["id"] for c in cams] == ["front_door", "back_yard"]
    assert cams[1] == {"id": "back_yard", "name": "Back Yard", "path": "cam2"}


def test_given_anon_client_when_get_cameras_then_401(
    client_anon: TestClient,
):
    # act
    r = client_anon.get("/api/cameras")
    # assert
    assert r.status_code == 401


def test_given_invalid_registry_env_when_get_cameras_then_default_not_500(
    client: TestClient, monkeypatch,
):
    """Never-crash pin: a typo'd HOMECAM_CAMERAS serves the default
    registry instead of a 500."""
    # arrange
    monkeypatch.setattr(settings, "cameras_json", "{oops")
    # act
    r = client.get("/api/cameras")
    # assert
    assert r.status_code == 200, r.text
    assert r.json()["cameras"] == [
        {"id": "front_door", "name": "Front Door", "path": "cam"},
    ]
