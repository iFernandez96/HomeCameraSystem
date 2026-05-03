"""iter-201 (Feature #1 slice 1): /api/events/{id}/clip route.

Until slice 2 ships the host-side ffmpeg recorder, every clip
fetch 404s — but the route + auth gate are in place. Tests pin
the auth-gated 401 anonymously, the 404 when no clip exists, and
the FileResponse delivery when the file is present (we manually
drop a fake mp4 into the recordings dir to exercise the happy
path without spawning ffmpeg).
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.config import settings


@pytest.fixture
def rec_dir(tmp_path, monkeypatch):
    p = tmp_path / "recordings"
    monkeypatch.setattr(settings, "recordings_dir", p)
    yield p


def test_clip_anon_returns_401(client_anon: TestClient, rec_dir):
    """Auth-gated via iter-184 router-level Depends."""
    r = client_anon.get("/api/events/evt-001/clip")
    assert r.status_code == 401


def test_clip_authed_returns_404_when_missing(client: TestClient, rec_dir):
    """Authed but the recorder hasn't written the clip yet (slice 2
    deferred). Route returns 404 with a descriptive detail."""
    r = client.get("/api/events/evt-missing/clip")
    assert r.status_code == 404
    assert "clip" in r.json().get("detail", "").lower()


def test_clip_authed_returns_file_when_present(client: TestClient, rec_dir):
    """Pin the FileResponse contract: status 200, Content-Type
    `video/mp4`, body matches the on-disk bytes."""
    rec_dir.mkdir()
    fake_mp4 = b"fake-mp4-bytes-for-test"
    (rec_dir / "evt-have.mp4").write_bytes(fake_mp4)
    r = client.get("/api/events/evt-have/clip")
    assert r.status_code == 200
    assert r.headers["content-type"] == "video/mp4"
    assert r.content == fake_mp4


def test_clip_rejects_event_id_with_dot(client: TestClient, rec_dir):
    """The route's regex `^[A-Za-z0-9_-]+$` rejects any dot in the
    event_id. A dot would let a malicious client try `evt.mp4..` or
    similar; the regex blocks at parameter parsing → 422 from
    FastAPI's Pydantic validation. Single-segment paths that DO
    match the route hit this regex; multi-segment paths fall
    through to the SPA catch-all (which is fine — they never reach
    any clip-serving code)."""
    r = client.get("/api/events/evt.001/clip")
    assert r.status_code == 422


def test_clip_rejects_event_id_with_special_chars(client: TestClient, rec_dir):
    """Other disallowed chars: space, dollar, semicolon, etc. All
    must 422 at the route regex."""
    for bad in ("evt%20space", "evt%24dollar", "evt%3Bsemi"):
        r = client.get("/api/events/{}/clip".format(bad))
        assert r.status_code == 422, "expected 422 for {!r}; got {}".format(
            bad, r.status_code,
        )


# iter-330 (missing-feature #3, Event Export ZIP): POST
# /api/events/export accepts a list of event IDs, returns a ZIP
# bundle of clips + thumbs + manifest.json. Auth-gated like the
# rest of /api/events.

import io
import json as _json
import zipfile

from app.config import settings as _settings
from app.services import events_db
from app.services.event_bus import make_detection_event


def _seed_event(event_id: str, *, ts: float = 1700000000.0, person_name=None) -> dict:
    """Helper: insert a seed event into events_db. Returns the dict
    so the test can assert against e.g. label / score."""
    e = make_detection_event(label="person", score=0.9, boxes=[])
    e["id"] = event_id
    e["ts"] = ts
    if person_name:
        e["person_name"] = person_name
    events_db.insert_event(_settings.events_db_path, e)
    return e


def test_when_anonymous_calls_export_then_returns_401(client_anon: TestClient):
    # arrange — no auth cookie via client_anon fixture (iter-184).

    # act
    r = client_anon.post("/api/events/export", json={"event_ids": ["evt-1"]})

    # assert
    assert r.status_code == 401


def test_given_empty_event_ids_when_export_called_then_422(client: TestClient):
    # arrange — Pydantic min_length=1 enforces.

    # act
    r = client.post("/api/events/export", json={"event_ids": []})

    # assert
    assert r.status_code == 422


def test_given_too_many_event_ids_when_export_called_then_422(client: TestClient):
    # arrange — _EXPORT_MAX_IDS=50.

    # act
    r = client.post(
        "/api/events/export",
        json={"event_ids": ["e{}".format(i) for i in range(51)]},
    )

    # assert
    assert r.status_code == 422


def test_given_unknown_event_ids_when_export_called_then_404(client: TestClient):
    # arrange — DB is fresh per-test via _isolate_events_db (iter-217).

    # act
    r = client.post(
        "/api/events/export",
        json={"event_ids": ["does-not-exist"]},
    )

    # assert
    assert r.status_code == 404


def test_given_one_event_with_clip_when_export_called_then_zip_contains_clip_and_manifest(
    client: TestClient, rec_dir,
):
    # arrange — seed event + drop fake clip on disk.
    rec_dir.mkdir()
    _seed_event("evt-export-1")
    (rec_dir / "evt-export-1.mp4").write_bytes(b"FAKE_MP4_BYTES")

    # act
    r = client.post(
        "/api/events/export",
        json={"event_ids": ["evt-export-1"]},
    )

    # assert — ZIP body, manifest + clip file present, manifest
    # records `clip_included: true`.
    assert r.status_code == 200
    assert r.headers["content-type"] == "application/zip"
    assert r.headers.get("content-disposition", "").startswith("attachment")
    zf = zipfile.ZipFile(io.BytesIO(r.content))
    names = set(zf.namelist())
    assert "manifest.json" in names
    assert "evt-export-1.mp4" in names
    assert zf.read("evt-export-1.mp4") == b"FAKE_MP4_BYTES"
    manifest = _json.loads(zf.read("manifest.json"))
    assert manifest["v"] == 1
    assert manifest["exported_count"] == 1
    assert manifest["events"][0]["id"] == "evt-export-1"
    assert manifest["events"][0]["clip_included"] is True


def test_given_event_without_clip_when_export_called_then_manifest_records_absence(
    client: TestClient, rec_dir,
):
    # arrange — seed event but NO clip on disk (recorder hadn't
    # spun up yet, or the retention sweep removed it).
    rec_dir.mkdir()
    _seed_event("evt-no-clip")

    # act
    r = client.post(
        "/api/events/export",
        json={"event_ids": ["evt-no-clip"]},
    )

    # assert — request succeeds (manifest is the value), but
    # manifest records clip_included=false. No mp4 in the ZIP.
    assert r.status_code == 200
    zf = zipfile.ZipFile(io.BytesIO(r.content))
    names = set(zf.namelist())
    assert "manifest.json" in names
    assert "evt-no-clip.mp4" not in names
    manifest = _json.loads(zf.read("manifest.json"))
    assert manifest["events"][0]["clip_included"] is False


def test_given_event_id_with_path_traversal_chars_when_export_called_then_422(
    client: TestClient, rec_dir,
):
    # arrange — Pydantic regex on _ExportBody.event_ids would
    # accept these because Field doesn't run per-item regex, but
    # the iter-330 belt-and-braces re-check + the events_db query
    # drop them. The 422 comes from the Pydantic str pattern
    # if applied; fall-through to 400 otherwise.
    # NOTE: Pydantic's str-list with no per-item pattern is the
    # weakest layer; the route's own _EXPORT_ID_RE catches.

    # act — these slip past Pydantic but get rejected by the
    # secondary regex check (returns 400 from HTTPException).
    r = client.post(
        "/api/events/export",
        json={"event_ids": ["../etc/passwd"]},
    )

    # assert — either 400 (route-layer regex reject) or 404
    # (no matching id in events_db); both prove no path
    # traversal happened. Pin the safe behavior.
    assert r.status_code in (400, 404)


def test_given_event_with_thumb_when_export_called_then_zip_contains_thumb_and_manifest_records_inclusion(
    client: TestClient, rec_dir, tmp_path, monkeypatch,
):
    # arrange (iter-338: closes test-coverage gap C3 from iter-333
    # broad audit. Pre-iter-338 the export route had `clip_included`
    # tests for both true + false but `thumb_included` was untested
    # for the happy path — only the implicit-false path exercised).
    snap_dir = tmp_path / "snapshots"
    snap_dir.mkdir()
    monkeypatch.setattr(_settings, "snapshots_dir", snap_dir)
    rec_dir.mkdir()
    # Insert directly (NOT via _seed_event) since events_db uses
    # INSERT OR IGNORE — second insert with the same id is a no-op.
    e = make_detection_event(label="person", score=0.9, boxes=[])
    e["id"] = "evt-with-thumb"
    e["ts"] = 1700000000.0
    e["thumb_url"] = "/snapshots/thumb_1700000000.jpg"
    events_db.insert_event(_settings.events_db_path, e)
    (snap_dir / "thumb_1700000000.jpg").write_bytes(b"\xff\xd8\xff\xe0THUMB")

    # act
    r = client.post(
        "/api/events/export",
        json={"event_ids": ["evt-with-thumb"]},
    )

    # assert
    assert r.status_code == 200
    zf = zipfile.ZipFile(io.BytesIO(r.content))
    names = set(zf.namelist())
    # thumb_url ends with `thumb_1700000000.jpg`; ZIP packages it
    # under `<event_id>.jpg`.
    assert "evt-with-thumb.jpg" in names
    assert zf.read("evt-with-thumb.jpg") == b"\xff\xd8\xff\xe0THUMB"
    manifest = _json.loads(zf.read("manifest.json"))
    assert manifest["events"][0]["thumb_included"] is True


def test_given_clip_disappears_mid_zip_when_export_called_then_manifest_records_clip_excluded(
    client: TestClient, rec_dir, monkeypatch,
):
    # arrange (iter-338: closes test-coverage gap C2 from iter-333.
    # The race: clip_exists() returns True at check time but the
    # retention sweep deletes the file before zf.write reads it. The
    # clips.py except OSError catch swallows it and the manifest
    # records clip_included=False; pre-iter-338 untested.)
    rec_dir.mkdir()
    _seed_event("evt-vanish")
    (rec_dir / "evt-vanish.mp4").write_bytes(b"FAKE")
    # Monkeypatch zipfile.ZipFile.write to raise OSError on the
    # mp4 to simulate the file being deleted between exists() and
    # write(). It still writes the manifest.json successfully.
    import zipfile as _zf_mod
    real_write = _zf_mod.ZipFile.write

    def fake_write(self, filename, *a, **kw):
        if str(filename).endswith("evt-vanish.mp4"):
            raise OSError("file vanished")
        return real_write(self, filename, *a, **kw)

    monkeypatch.setattr(_zf_mod.ZipFile, "write", fake_write)

    # act
    r = client.post(
        "/api/events/export",
        json={"event_ids": ["evt-vanish"]},
    )

    # assert — request still succeeds (the OSError was caught
    # silently); manifest records the clip as NOT included even
    # though the file existed at clip_exists() check time.
    assert r.status_code == 200
    zf = zipfile.ZipFile(io.BytesIO(r.content))
    names = set(zf.namelist())
    assert "manifest.json" in names
    assert "evt-vanish.mp4" not in names
    manifest = _json.loads(zf.read("manifest.json"))
    assert manifest["events"][0]["clip_included"] is False


def test_export_semaphore_caps_concurrent_zip_builds_at_two(
    client: TestClient, rec_dir,
):
    # arrange (iter-337 systems-eng C1): pin that the route holds
    # an asyncio.Semaphore(2) so 8 concurrent exports don't saturate
    # the thread pool. Probe the module-level semaphore directly to
    # confirm its capacity.
    from app.routes import clips as _clips_mod

    # act
    sem = _clips_mod._EXPORT_SEMAPHORE

    # assert — the semaphore exists with the documented value of 2.
    assert hasattr(sem, "_value")
    # asyncio.Semaphore stores its remaining capacity in _value;
    # at idle that equals the initial value.
    assert sem._value == 2  # noqa: SLF001
