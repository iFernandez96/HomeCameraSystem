"""iter-356.62 slice 3 (privacy controls): tests for the owner-only
purge + consent admin endpoints in `routes/training_admin.py`.
"""
from __future__ import annotations

import json
import os
import stat
from pathlib import Path

import pytest

from app.config import settings


@pytest.fixture
def isolated_capture_dirs(tmp_path, monkeypatch):
    face_root = tmp_path / "face_captures"
    person_root = tmp_path / "person_captures"
    face_root.mkdir()
    person_root.mkdir()
    monkeypatch.setattr(settings, "face_captures_dir", face_root)
    monkeypatch.setattr(settings, "person_captures_dir", person_root)
    return face_root, person_root


def _seed_capture(dir_: Path, basename: str) -> tuple[Path, Path]:
    dir_.mkdir(parents=True, exist_ok=True)
    jpg = dir_ / "{}.jpg".format(basename)
    sidecar = dir_ / "{}.json".format(basename)
    jpg.write_bytes(b"\xff\xd8\xff\xd9")
    sidecar.write_text('{"predicted_name": "alice"}')
    return jpg, sidecar


# ---------- DELETE /api/training/captures ----------


def test_given_anon_when_delete_captures_then_401(client_anon, isolated_capture_dirs):
    # arrange
    face_root, _ = isolated_capture_dirs
    _seed_capture(face_root / "alice", "1700000000_evt")

    # act
    r = client_anon.delete("/api/training/captures", params={"name": "alice"})

    # assert
    assert r.status_code == 401


def test_given_owner_when_delete_captures_then_both_subtrees_purged_and_count_returned(
    client, isolated_capture_dirs,
):
    # arrange
    face_root, person_root = isolated_capture_dirs
    f_jpg, f_sidecar = _seed_capture(face_root / "alice", "1700000000_evt")
    p_jpg, p_sidecar = _seed_capture(person_root / "alice", "1700000001_evt")
    p2_jpg, _ = _seed_capture(person_root / "alice", "1700000002_evt")

    # act
    r = client.delete("/api/training/captures", params={"name": "alice"})

    # assert
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is True
    assert body["deleted"] == 3
    assert not f_jpg.exists()
    assert not f_sidecar.exists()
    assert not p_jpg.exists()
    assert not p_sidecar.exists()
    assert not p2_jpg.exists()


def test_given_invalid_name_when_delete_then_422_or_404(
    client, isolated_capture_dirs,
):
    # arrange — name with traversal chars / disallowed punctuation
    # act
    r = client.delete("/api/training/captures", params={"name": "../etc"})

    # assert
    assert r.status_code in (404, 422)


def test_given_traversal_attempt_when_delete_then_404(
    client, isolated_capture_dirs,
):
    # arrange — _NAME_RE rejects path-sep + dot-dot, so this is a 404
    # act
    r = client.delete("/api/training/captures", params={"name": "..%2Fetc"})

    # assert
    assert r.status_code == 404


def test_given_unknown_name_when_delete_then_404(client, isolated_capture_dirs):
    # arrange — no dir for "ghost"
    # act
    r = client.delete("/api/training/captures", params={"name": "ghost"})

    # assert
    assert r.status_code == 404


# ---------- POST /api/face/captures/{name}/consent ----------


def test_given_anon_when_post_consent_then_401(client_anon, isolated_capture_dirs):
    # arrange
    body = {"granted": True, "consent_text_version": "v1"}

    # act
    r = client_anon.post("/api/face/captures/alice/consent", json=body)

    # assert
    assert r.status_code == 401


def test_given_owner_when_post_consent_then_consent_json_written_with_0o600(
    client, isolated_capture_dirs,
):
    # arrange
    face_root, _ = isolated_capture_dirs
    body = {"granted": True, "consent_text_version": "household-2026-05"}

    # act
    r = client.post("/api/face/captures/alice/consent", json=body)

    # assert
    assert r.status_code == 200, r.text
    rec = r.json()
    assert rec["granted"] is True
    assert rec["consent_text_version"] == "household-2026-05"
    assert rec["recorded_by"] == "testuser"
    assert isinstance(rec["recorded_at_ms"], int) and rec["recorded_at_ms"] > 0

    consent_path = face_root / "alice" / "consent.json"
    assert consent_path.is_file()
    mode = stat.S_IMODE(consent_path.stat().st_mode)
    assert mode == 0o600, "expected 0o600 got {}".format(oct(mode))
    on_disk = json.loads(consent_path.read_text())
    assert on_disk == rec


def test_given_post_consent_with_unknown_field_then_422(
    client, isolated_capture_dirs,
):
    # arrange — extra='forbid' on _ConsentBody
    body = {"granted": True, "consent_text_version": "v1", "extra": "nope"}

    # act
    r = client.post("/api/face/captures/alice/consent", json=body)

    # assert
    assert r.status_code == 422


# ---------- GET /api/face/captures/{name}/consent ----------


def test_given_consent_get_when_no_record_then_returns_default_with_granted_false(
    client, isolated_capture_dirs,
):
    # arrange — no consent.json on disk
    # act
    r = client.get("/api/face/captures/alice/consent")

    # assert
    assert r.status_code == 200, r.text
    body = r.json()
    assert body == {
        "granted": False,
        "recorded_at_ms": None,
        "consent_text_version": None,
        "recorded_by": None,
    }


def test_given_consent_get_when_record_exists_then_returns_stored_record(
    client, isolated_capture_dirs,
):
    # arrange — write via the POST so we round-trip the same shape
    post = client.post(
        "/api/face/captures/alice/consent",
        json={"granted": True, "consent_text_version": "v1"},
    )
    assert post.status_code == 200

    # act
    r = client.get("/api/face/captures/alice/consent")

    # assert
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["granted"] is True
    assert body["consent_text_version"] == "v1"
    assert body["recorded_by"] == "testuser"
    assert isinstance(body["recorded_at_ms"], int)


def test_given_anon_when_get_consent_then_401(client_anon, isolated_capture_dirs):
    # act
    r = client_anon.get("/api/face/captures/alice/consent")

    # assert
    assert r.status_code == 401
