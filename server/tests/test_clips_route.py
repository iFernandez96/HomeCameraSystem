"""iter-201 (Feature #1 slice 1): /api/events/{id}/clip route.

Until slice 2 ships the host-side ffmpeg recorder, every clip
fetch 404s — but the route + auth gate are in place. Tests pin
the auth-gated 401 anonymously, the 404 when no clip exists, and
the FileResponse delivery when the file is present (we manually
drop a fake mp4 into the recordings dir to exercise the happy
path without spawning ffmpeg).
"""
from __future__ import annotations

import logging
import json

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


def test_clip_404_log_includes_ledger_state(
    client: TestClient,
    rec_dir,
    caplog,
):
    rec_dir.mkdir()
    (rec_dir / ".clip_state.json").write_text(json.dumps({
        "v": 1,
        "events": {"evt-recording": {"state": "recording"}},
    }))

    with caplog.at_level(logging.INFO, logger="app.routes.clips"):
        r = client.get("/api/events/evt-recording/clip")

    assert r.status_code == 404
    assert any(
        "event_id=evt-recording clip_state=recording" in rec.getMessage()
        for rec in caplog.records
    )


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


def test_clip_status_returns_ledger_state_when_recording(
    client: TestClient,
    rec_dir,
):
    rec_dir.mkdir()
    (rec_dir / ".clip_state.json").write_text(json.dumps({
        "v": 1,
        "events": {
            "evt-recording": {
                "event_id": "evt-recording",
                "state": "recording",
                "last_seen": 123.0,
            },
        },
    }))

    r = client.get("/api/events/evt-recording/clip/status")

    assert r.status_code == 200
    assert r.json()["state"] == "recording"
    assert r.json()["source"] == "ledger"
    assert r.json()["last_seen"] == 123.0


def test_clip_status_returns_available_when_file_exists(
    client: TestClient,
    rec_dir,
):
    rec_dir.mkdir()
    (rec_dir / "evt-have.mp4").write_bytes(b"fake")

    r = client.get("/api/events/evt-have/clip/status")

    assert r.status_code == 200
    assert r.json()["state"] == "available"
    assert r.json()["source"] == "disk"
    assert r.json()["bytes"] == 4


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


# iter-356.53 (bbox-track sidecar): /api/events/{id}/tracks delivers
# the JSON sidecar written by `detection/tracks.py`. Auth-gated +
# path-traversal-defended identically to the clip route. Client
# `ClipModal` reads it on mount; 404 falls back to the static
# `event.boxes` overlay (legacy clips have no sidecar).


def test_given_anon_when_get_tracks_then_401(client_anon: TestClient, rec_dir):
    # arrange + act
    r = client_anon.get("/api/events/evt-001/tracks")

    # assert
    assert r.status_code == 401


def test_given_authed_no_sidecar_when_get_tracks_then_404(
    client: TestClient, rec_dir,
):
    # arrange — recordings dir empty.

    # act
    r = client.get("/api/events/evt-missing/tracks")

    # assert
    assert r.status_code == 404
    assert "tracks" in r.json().get("detail", "").lower()


def test_given_authed_sidecar_present_when_get_tracks_then_200_json(
    client: TestClient, rec_dir,
):
    # arrange — drop a fake sidecar at the canonical path.
    rec_dir.mkdir()
    fake_payload = (
        b'{"v":1,"event_id":"evt-have","pre_roll_s":3.0,"post_roll_s":7.0,'
        b'"samples":[{"ts_offset_s":1.5,"boxes":[{"x":0.1,"y":0.1,"w":0.2,'
        b'"h":0.2,"label":"person","score":0.9}]}]}'
    )
    (rec_dir / "evt-have.tracks.json").write_bytes(fake_payload)

    # act
    r = client.get("/api/events/evt-have/tracks")

    # assert
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("application/json")
    assert r.content == fake_payload


def test_given_event_id_with_traversal_chars_when_get_tracks_then_422(
    client: TestClient, rec_dir,
):
    # arrange — set of disallowed chars mirrors the clip-route test.

    # act + assert
    for bad in ("evt.001", "evt%20space", "evt%24dollar"):
        r = client.get("/api/events/{}/tracks".format(bad))
        assert r.status_code == 422, (
            "expected 422 for {!r}; got {}".format(bad, r.status_code)
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


def test_given_idle_export_semaphore_when_probed_then_capacity_is_one(
    client: TestClient, rec_dir,
):
    """Given the export route, When the module-level semaphore is
    probed, Then its capacity is 1.

    logging-plan §2 lowered the cap 2→1: the production
    "stitch all captures fails" bug was a 512MB-cgroup OOM-kill, and
    Semaphore(2) permitted two concurrent in-RAM builds (>800MB). The
    build now streams to disk, but the cap stays at 1 so two large
    exports can't race for the thread pool / disk I/O. Pins the value
    so a future change can't silently restore the OOM-permitting cap.
    """
    # arrange
    from app.routes import clips as _clips_mod

    # act
    sem = _clips_mod._EXPORT_SEMAPHORE

    # assert — asyncio.Semaphore stores remaining capacity in _value;
    # at idle that equals the initial value.
    assert hasattr(sem, "_value")
    assert sem._value == 1  # noqa: SLF001


# logging-plan (docs/logging_plan.md §2 "Export ZIP"): the export now
# builds the ZIP to a temp file on disk and returns it via FileResponse
# with a BackgroundTask that unlinks the temp file after the response is
# sent. This was the fix for the production "stitch all captures fails"
# OOM bug (the old in-RAM StreamingResponse double-copy OOM-killed the
# 512MB container). These tests pin: the FileResponse contract still
# yields a valid ZIP (same filename + members), the temp file is cleaned
# up afterward, and a clip swept mid-export is skipped + logged (WARN),
# not a 500.


def _export_temp_files(rec_dir):
    """Helper: list any leftover export temp ZIPs in the recordings
    dir. The build writes them with the `homecam_export_` prefix."""
    if not rec_dir.exists():
        return []
    return [p for p in rec_dir.iterdir() if p.name.startswith("homecam_export_")]


def test_given_event_with_clip_when_export_then_fileresponse_zip_and_temp_cleaned_up(
    client: TestClient, rec_dir,
):
    """Given a seeded event with a clip on disk, When export is called,
    Then the response is a valid ZIP (same filename + members as before)
    AND no export temp file is left behind on the data volume.

    logging-plan §2: the response moved from StreamingResponse(BytesIO)
    to FileResponse(temp file) + BackgroundTask unlink. The downloaded
    contract is unchanged; the temp file must not leak (a leak on the
    8.6GB data volume would eventually fill it and break the recorder).
    """
    # arrange
    rec_dir.mkdir()
    _seed_event("evt-fr-1")
    (rec_dir / "evt-fr-1.mp4").write_bytes(b"FAKE_MP4_BYTES")

    # act
    r = client.post("/api/events/export", json={"event_ids": ["evt-fr-1"]})

    # assert — same wire contract: zip content-type, attachment
    # disposition with the homecam_events.zip filename, members intact.
    assert r.status_code == 200
    assert r.headers["content-type"] == "application/zip"
    disp = r.headers.get("content-disposition", "")
    assert disp.startswith("attachment")
    assert "homecam_events.zip" in disp
    zf = zipfile.ZipFile(io.BytesIO(r.content))
    names = set(zf.namelist())
    assert "manifest.json" in names
    assert "evt-fr-1.mp4" in names
    assert zf.read("evt-fr-1.mp4") == b"FAKE_MP4_BYTES"
    # assert — temp file cleaned up. With TestClient the BackgroundTask
    # runs after the response body is fully consumed (r.content above).
    assert _export_temp_files(rec_dir) == [], (
        "export temp ZIP leaked — BackgroundTask unlink did not fire"
    )


def test_given_clip_swept_mid_export_when_export_then_skipped_logged_not_500(
    client: TestClient, rec_dir, monkeypatch, caplog,
):
    """Given a clip that vanishes between clip_exists() and zf.write(),
    When export is called, Then the route returns 200 (clip skipped, not
    500) AND a WARN names the swept event_id.

    logging-plan §2: the race (retention sweep deletes the file mid-zip)
    must be skipped + logged, never crash the whole export.
    """
    # arrange — seed event + clip, then make ZipFile.write raise OSError
    # on the mp4 to simulate the sweep deleting it mid-write.
    rec_dir.mkdir()
    _seed_event("evt-swept")
    (rec_dir / "evt-swept.mp4").write_bytes(b"FAKE")
    import zipfile as _zf_mod

    real_write = _zf_mod.ZipFile.write

    def fake_write(self, filename, *a, **kw):
        if str(filename).endswith("evt-swept.mp4"):
            raise OSError("file vanished")
        return real_write(self, filename, *a, **kw)

    monkeypatch.setattr(_zf_mod.ZipFile, "write", fake_write)

    # act
    with caplog.at_level(logging.WARNING, logger="app.routes.clips"):
        r = client.post("/api/events/export", json={"event_ids": ["evt-swept"]})

    # assert — still 200; manifest records the clip as NOT included.
    assert r.status_code == 200
    zf = zipfile.ZipFile(io.BytesIO(r.content))
    assert "evt-swept.mp4" not in set(zf.namelist())
    manifest = _json.loads(zf.read("manifest.json"))
    assert manifest["events"][0]["clip_included"] is False
    # assert — a WARN naming the swept event_id was logged.
    warn_lines = [
        rec.getMessage()
        for rec in caplog.records
        if rec.levelno == logging.WARNING
    ]
    assert any(
        "swept mid-export" in m and "evt-swept" in m for m in warn_lines
    ), "expected a WARN naming the swept event_id; got {!r}".format(warn_lines)
    # assert — no temp file leaked even on the partial-skip path.
    assert _export_temp_files(rec_dir) == []


def test_given_zero_events_resolved_when_export_then_404_and_info_logged(
    client: TestClient, rec_dir, caplog,
):
    """Given requested ids that resolve to no events, When export is
    called, Then it 404s AND logs an INFO noting 0-of-N resolved.

    logging-plan §2: a stale client selection (events swept since the
    list loaded) should be diagnosable, not silent.
    """
    # arrange — fresh DB per-test; no matching rows.

    # act
    with caplog.at_level(logging.INFO, logger="app.routes.clips"):
        r = client.post(
            "/api/events/export", json={"event_ids": ["nope-1", "nope-2"]},
        )

    # assert
    assert r.status_code == 404
    info_lines = [
        rec.getMessage()
        for rec in caplog.records
        if rec.levelno == logging.INFO
    ]
    assert any(
        "0 events resolved" in m and "2 requested" in m for m in info_lines
    ), "expected INFO noting 0-of-2 resolved; got {!r}".format(info_lines)
