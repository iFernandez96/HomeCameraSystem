"""iter-356.6X (tiered-inference slice 2): integration tests for the
GET /api/training/export route.
"""
from __future__ import annotations

import csv
import io
import json
import zipfile

import pytest
from PIL import Image


def _make_jpeg(path, w, h, color=(180, 80, 30)):
    path.parent.mkdir(parents=True, exist_ok=True)
    img = Image.new("RGB", (w, h), color)
    img.save(path, format="JPEG", quality=85)


def _make_sidecar(path, **fields):
    path.write_text(json.dumps(fields))


@pytest.fixture
def captures_dir(tmp_path, monkeypatch):
    """Redirect settings.face_captures_dir + person_captures_dir at a
    fresh tmp tree per test."""
    from app.config import settings

    face_root = tmp_path / "face_captures"
    person_root = tmp_path / "person_captures"
    face_root.mkdir()
    person_root.mkdir()
    monkeypatch.setattr(settings, "face_captures_dir", face_root)
    monkeypatch.setattr(settings, "person_captures_dir", person_root)
    return {"face": face_root, "person": person_root}


def test_given_anon_when_get_export_then_401(client_anon, captures_dir):
    # arrange — no captures needed; auth gate runs first
    # act
    resp = client_anon.get("/api/training/export?kind=face&size=224")
    # assert
    assert resp.status_code == 401


def test_given_owner_when_get_export_face_then_200_zip(client, captures_dir):
    # arrange — two face crops, two sidecars
    face_root = captures_dir["face"]
    a = face_root / "alice" / "1700000000000_evt-a.jpg"
    b = face_root / "bob" / "1700000001000_evt-b.jpg"
    _make_jpeg(a, 120, 80)
    _make_jpeg(b, 80, 120)
    _make_sidecar(
        a.with_suffix(".json"),
        predicted_name="alice", confidence=0.91,
        event_id="evt-a", ts_ms=1700000000000, sw_rev="iter-356.6X-abc",
    )
    _make_sidecar(
        b.with_suffix(".json"),
        predicted_name="bob", confidence=0.72,
        event_id="evt-b", ts_ms=1700000001000, sw_rev="iter-356.6X-abc",
    )

    # act
    resp = client.get("/api/training/export?kind=face&size=224")

    # assert
    assert resp.status_code == 200
    assert resp.headers["content-type"] == "application/zip"
    assert "homecam-training-face-224.zip" in resp.headers["content-disposition"]
    zf = zipfile.ZipFile(io.BytesIO(resp.content))
    names = zf.namelist()
    pngs = [n for n in names if n.endswith(".png")]
    assert len(pngs) == 2
    assert "manifest.csv" in names

    # Manifest header columns + row count
    manifest_text = zf.read("manifest.csv").decode("utf-8")
    reader = csv.DictReader(io.StringIO(manifest_text))
    assert set(reader.fieldnames) == {
        "filename", "predicted_name", "confidence",
        "source_w", "source_h", "scale", "pad_x", "pad_y",
        "event_id", "ts_ms", "sw_rev",
    }
    rows = list(reader)
    assert len(rows) == 2
    by_name = {r["predicted_name"]: r for r in rows}
    assert set(by_name) == {"alice", "bob"}
    # alice (120x80 landscape → scale=224/120=1.866...) → pad_y > 0, pad_x = 0
    assert int(by_name["alice"]["source_w"]) == 120
    assert int(by_name["alice"]["source_h"]) == 80
    assert int(by_name["alice"]["pad_x"]) == 0
    assert int(by_name["alice"]["pad_y"]) > 0


def test_given_invalid_kind_when_get_export_then_422(client, captures_dir):
    # arrange / act
    resp = client.get("/api/training/export?kind=banana&size=224")
    # assert
    assert resp.status_code == 422


def test_given_invalid_size_when_get_export_then_422(client, captures_dir):
    # arrange / act
    resp = client.get("/api/training/export?kind=face&size=999")
    # assert
    assert resp.status_code == 422


def test_given_more_than_max_entries_when_get_export_then_413(client, captures_dir):
    # arrange — 5001 jpeg+sidecar pairs in one bucket
    face_root = captures_dir["face"]
    bucket = face_root / "alice"
    bucket.mkdir()
    img = Image.new("RGB", (1, 1), (0, 0, 0))
    buf = io.BytesIO()
    img.save(buf, format="JPEG")
    raw = buf.getvalue()
    for i in range(5001):
        jpeg = bucket / "{0:013d}_evt-x.jpg".format(1700000000000 + i)
        jpeg.write_bytes(raw)
        jpeg.with_suffix(".json").write_text("{}")

    # act
    resp = client.get("/api/training/export?kind=face&size=64")

    # assert
    assert resp.status_code == 413
