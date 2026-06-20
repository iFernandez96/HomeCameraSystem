"""iter-351 (Phase 2): pin the face-capture browse routes that the
PWA's /training page (iter-352) consumes. Read-only routes; the
move/delete + retrain routes land iter-353/354.

Three routes:
  GET /api/face/captures              — list of dirs + counts
  GET /api/face/captures/{name}       — list of files in dir
  GET /api/face/captures/{name}/{f}   — serve JPEG

Path-traversal defense is the security-critical surface; auth gating
+ regex on name/filename + resolve+relative_to are tested explicitly.
"""
from __future__ import annotations

import os

import pytest


@pytest.fixture
def captures_root(tmp_path, monkeypatch):
    """Per-test isolated face_captures_dir. Pre-populates a couple of
    sample dirs so the routes have data to return."""
    from app.config import settings

    root = tmp_path / "face_captures"
    monkeypatch.setattr(settings, "face_captures_dir", root)
    root.mkdir()
    # alice/ has 2 files
    alice = root / "alice"
    alice.mkdir()
    (alice / "1700000000000_evt-001.jpg").write_bytes(b"\xff\xd8\xff\xe0fake_alice_1")
    (alice / "1700000060000_evt-002.jpg").write_bytes(b"\xff\xd8\xff\xe0fake_alice_2")
    # __unknown__/ has 1 file
    unknown = root / "__unknown__"
    unknown.mkdir()
    (unknown / "1700000120000_evt-003.jpg").write_bytes(b"\xff\xd8\xff\xe0fake_unknown")
    # empty/ has 0 files — should be filtered out of the listing.
    (root / "empty").mkdir()
    return root


def test_when_owner_lists_captures_then_returns_dirs_with_counts(
    client, captures_root,
):
    # arrange — fixtures pre-populate alice (2) + __unknown__ (1) + empty (0)

    # act
    r = client.get("/api/face/captures")

    # assert
    assert r.status_code == 200
    body = r.json()
    names = {d["name"]: d["count"] for d in body["dirs"]}
    assert names == {"alice": 2, "__unknown__": 1}
    # empty/ filtered out — no count means no triage value.
    assert "empty" not in names


def test_given_no_captures_dir_when_listed_then_returns_empty_dirs(
    client, tmp_path, monkeypatch,
):
    # arrange — face_captures_dir doesn't exist (first deploy state).
    from app.config import settings
    monkeypatch.setattr(settings, "face_captures_dir", tmp_path / "nonexistent")

    # act
    r = client.get("/api/face/captures")

    # assert — 200 with empty list, NOT 404. "No captures yet" is normal.
    assert r.status_code == 200
    assert r.json() == {"dirs": []}


def test_when_anonymous_lists_captures_then_401(client_anon, captures_root):
    # arrange — anon client, face_captures_dir populated.

    # act
    r = client_anon.get("/api/face/captures")

    # assert
    assert r.status_code == 401


def test_when_owner_lists_dir_then_returns_files_newest_first(
    client, captures_root,
):
    # arrange — alice/ has 2 files at ts 1700000000000 + 1700000060000

    # act
    r = client.get("/api/face/captures/alice")

    # assert
    assert r.status_code == 200
    body = r.json()
    assert body["name"] == "alice"
    files = body["files"]
    assert len(files) == 2
    # Newest first (1700000060000 > 1700000000000).
    assert files[0]["ts_ms"] == 1700000060000
    assert files[0]["event_id"] == "evt-002"
    assert files[0]["url"] == "/api/face/captures/alice/1700000060000_evt-002.jpg"
    assert files[1]["ts_ms"] == 1700000000000


def test_given_unknown_name_when_listed_then_returns_empty_files(
    client, captures_root,
):
    # arrange — name doesn't exist on disk.

    # act
    r = client.get("/api/face/captures/charlie")

    # assert — 200 (regex matched, dir just empty/missing) with empty files.
    assert r.status_code == 200
    assert r.json() == {"name": "charlie", "files": []}


def test_given_traversal_in_name_when_listed_then_404(client, captures_root):
    # arrange — `..%2F` URL-encoded path traversal attempt.

    # act
    r = client.get("/api/face/captures/..%2Fetc")

    # assert
    assert r.status_code == 404


def test_given_invalid_name_chars_when_listed_then_404(client, captures_root):
    # arrange — characters outside [A-Za-z0-9_-].

    # act
    r = client.get("/api/face/captures/al ice")

    # assert
    assert r.status_code == 404


def test_when_owner_fetches_capture_file_then_returns_jpeg(
    client, captures_root,
):
    # arrange — alice/1700000000000_evt-001.jpg exists.

    # act
    r = client.get("/api/face/captures/alice/1700000000000_evt-001.jpg")

    # assert
    assert r.status_code == 200
    assert r.headers["content-type"] == "image/jpeg"
    assert r.content == b"\xff\xd8\xff\xe0fake_alice_1"


def test_given_invalid_filename_when_fetched_then_404(client, captures_root):
    # arrange — filename doesn't match the strict ts_event.jpg shape.

    # act
    r = client.get("/api/face/captures/alice/notaface.txt")

    # assert
    assert r.status_code == 404


def test_given_traversal_chars_in_filename_when_fetched_then_404(
    client, captures_root,
):
    # arrange — TestClient URL-decodes `%2F` to `/` which then no
    # longer matches the {filename} path param. So the path-traversal
    # surface that actually applies is filenames like `..jpg` (dots
    # outside the strict ts_event.jpg shape) — the _FILENAME_RE
    # rejects ANY chars not in [0-9]_[A-Za-z0-9_-].jpg.
    # This pins that the regex IS the defense (not just resolve).

    # act
    r = client.get("/api/face/captures/alice/...jpg")

    # assert
    assert r.status_code == 404


def test_given_filename_with_dot_in_eventid_when_fetched_then_404(
    client, captures_root,
):
    # arrange — embedding `.` in the event_id portion (e.g. an attacker
    # tries `1234_../etc.jpg`) is rejected by the regex.

    # act
    r = client.get("/api/face/captures/alice/1234_..jpg")

    # assert
    assert r.status_code == 404


def test_when_anonymous_fetches_capture_file_then_401(
    client_anon, captures_root,
):
    # arrange — file exists, anon client.

    # act
    r = client_anon.get("/api/face/captures/alice/1700000000000_evt-001.jpg")

    # assert — auth gate fires before path resolution.
    assert r.status_code == 401


def test_given_event_id_with_underscores_when_listed_then_round_trips(
    client, captures_root,
):
    # arrange — recording_service event_ids may legitimately contain
    # underscores (e.g. "person_2026-04-30_12-34-56"). The route's
    # filename split on FIRST underscore must preserve them.
    bob_dir = captures_root / "bob"
    bob_dir.mkdir()
    (bob_dir / "1700000000000_person_2026-04-30_12-34-56.jpg").write_bytes(b"x")

    # act
    r = client.get("/api/face/captures/bob")

    # assert
    assert r.status_code == 200
    files = r.json()["files"]
    assert len(files) == 1
    assert files[0]["event_id"] == "person_2026-04-30_12-34-56"
    assert files[0]["ts_ms"] == 1700000000000


def test_given_subdir_under_name_when_listed_then_ignored(
    client, captures_root,
):
    # arrange — operator drops a subdir inside alice/ (e.g. by mistake
    # during retrain). The route must NOT recurse — only direct .jpg
    # children count.
    nested = captures_root / "alice" / "subdir"
    nested.mkdir()
    (nested / "1700000000000_evt-x.jpg").write_bytes(b"nope")

    # act
    r = client.get("/api/face/captures/alice")

    # assert — still only the 2 originals.
    assert r.status_code == 200
    files = r.json()["files"]
    assert len(files) == 2


def test_given_non_jpg_file_in_dir_when_listed_then_filtered(
    client, captures_root,
):
    # arrange — operator drops a stray README in alice/.
    (captures_root / "alice" / "README.txt").write_bytes(b"hello")

    # act
    r = client.get("/api/face/captures/alice")

    # assert — README ignored, only the 2 .jpgs return.
    files = r.json()["files"]
    assert len(files) == 2
    assert all(f["filename"].endswith(".jpg") for f in files)


# iter-353 (Phase 3): move + delete tests.

def test_when_owner_moves_capture_then_file_lands_in_target_dir(
    client, captures_root,
):
    # arrange — alice has 2 files, bob doesn't exist yet.
    src_filename = "1700000000000_evt-001.jpg"
    src_path = captures_root / "alice" / src_filename

    # act
    r = client.post(
        "/api/face/captures/alice/{}/move".format(src_filename),
        json={"target_name": "bob"},
    )

    # assert
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert body["moved_to"] == "bob/{}".format(src_filename)
    assert not src_path.exists()
    assert (captures_root / "bob" / src_filename).is_file()


def test_given_rename_oserror_when_moving_then_500_and_error_logged(
    client, captures_root, monkeypatch, caplog,
):
    """Given the underlying os.rename fails (disk RO / unmounted),
    When the operator moves a capture, Then the route 500s AND logs an
    ERROR naming the src/dst — the failure was a bare swallow before."""
    import logging

    from app.routes import face as face_route

    # arrange
    src_filename = "1700000000000_evt-001.jpg"

    def boom(*_a, **_k):
        raise OSError("simulated EROFS")

    monkeypatch.setattr(face_route.os, "rename", boom)
    caplog.set_level(logging.ERROR, logger="app.routes.face")

    # act
    r = client.post(
        "/api/face/captures/alice/{}/move".format(src_filename),
        json={"target_name": "bob"},
    )

    # assert
    assert r.status_code == 500
    errors = [
        rec for rec in caplog.records
        if rec.levelno == logging.ERROR
        and "move failed" in rec.getMessage()
    ]
    assert errors, "expected a 'move failed' ERROR"
    assert src_filename in errors[0].getMessage()


def test_given_collision_when_moving_then_filename_suffixed(
    client, captures_root,
):
    # arrange — pre-create the same filename under target dir.
    src_filename = "1700000000000_evt-001.jpg"
    bob_dir = captures_root / "bob"
    bob_dir.mkdir()
    # Same content placeholder; the move shouldn't overwrite it.
    (bob_dir / src_filename).write_bytes(b"\xff\xd8\xff\xe0pre_existing")

    # act
    r = client.post(
        "/api/face/captures/alice/{}/move".format(src_filename),
        json={"target_name": "bob"},
    )

    # assert
    assert r.status_code == 200
    body = r.json()
    # _2 suffix inserted before .jpg.
    assert body["moved_to"] == "bob/1700000000000_evt-001_2.jpg"
    # Pre-existing file untouched.
    assert (bob_dir / src_filename).read_bytes() == b"\xff\xd8\xff\xe0pre_existing"
    # New file at the suffixed name has the moved bytes.
    assert (bob_dir / "1700000000000_evt-001_2.jpg").read_bytes() == b"\xff\xd8\xff\xe0fake_alice_1"


def test_given_same_target_when_moving_then_noop_success(
    client, captures_root,
):
    # arrange — operator retried the same move (network blip).
    src_filename = "1700000000000_evt-001.jpg"

    # act
    r = client.post(
        "/api/face/captures/alice/{}/move".format(src_filename),
        json={"target_name": "alice"},
    )

    # assert — 200, file still in place.
    assert r.status_code == 200
    assert (captures_root / "alice" / src_filename).is_file()


def test_given_invalid_target_name_when_moving_then_422(
    client, captures_root,
):
    # arrange — target_name has unsafe chars, would-be-traversal.
    src_filename = "1700000000000_evt-001.jpg"

    # act
    r = client.post(
        "/api/face/captures/alice/{}/move".format(src_filename),
        json={"target_name": "../escape"},
    )

    # assert — 422 for bad body, NOT 404.
    assert r.status_code == 422


def test_given_extra_body_field_when_moving_then_422(
    client, captures_root,
):
    # arrange — extra='forbid' rejects unknown fields.
    src_filename = "1700000000000_evt-001.jpg"

    # act
    r = client.post(
        "/api/face/captures/alice/{}/move".format(src_filename),
        json={"target_name": "bob", "rm_rf": True},
    )

    # assert
    assert r.status_code == 422


def test_when_anonymous_moves_capture_then_401(client_anon, captures_root):
    # arrange — no auth.

    # act
    r = client_anon.post(
        "/api/face/captures/alice/1700000000000_evt-001.jpg/move",
        json={"target_name": "bob"},
    )

    # assert
    assert r.status_code == 401


def test_given_missing_source_when_moving_then_404(client, captures_root):
    # arrange — filename doesn't exist on disk.

    # act
    r = client.post(
        "/api/face/captures/alice/9999999999999_evt-nope.jpg/move",
        json={"target_name": "bob"},
    )

    # assert
    assert r.status_code == 404


def test_when_owner_deletes_capture_then_file_removed(
    client, captures_root,
):
    # arrange
    src_filename = "1700000000000_evt-001.jpg"
    src_path = captures_root / "alice" / src_filename
    assert src_path.is_file()

    # act
    r = client.delete("/api/face/captures/alice/{}".format(src_filename))

    # assert
    assert r.status_code == 200
    assert r.json() == {"ok": True}
    assert not src_path.exists()


def test_given_double_delete_when_called_then_404(client, captures_root):
    # arrange — file already gone (operator double-tapped).
    src_filename = "1700000000000_evt-001.jpg"
    (captures_root / "alice" / src_filename).unlink()

    # act
    r = client.delete("/api/face/captures/alice/{}".format(src_filename))

    # assert — clear "already gone" not a lying-success.
    assert r.status_code == 404


def test_when_anonymous_deletes_capture_then_401(client_anon, captures_root):
    # arrange — no auth.

    # act
    r = client_anon.delete(
        "/api/face/captures/alice/1700000000000_evt-001.jpg",
    )

    # assert
    assert r.status_code == 401


def test_given_invalid_filename_when_deleted_then_404(
    client, captures_root,
):
    # arrange — same regex defense as GET; this pins the DELETE side.

    # act
    r = client.delete("/api/face/captures/alice/notaface.txt")

    # assert
    assert r.status_code == 404


# iter-354 (Phase 4 scaffold): bootstrap + re-train stub tests.
# Until iter-355 wires the host-helper subprocess, both routes are
# stub-with-note: they accept input + validate, return ok=True with a
# `note` field the client checks (per the iter-197 stub-with-note
# pattern documented in CLAUDE.md sharp edges).


def test_when_owner_uploads_bootstrap_photo_then_jpeg_lands_under_name_dir(
    client, captures_root,
):
    # arrange — fresh upload of a JPEG with the iter-354 stub.
    fake_jpeg = b"\xff\xd8\xff\xe0fake_uploaded_jpeg"

    # act
    r = client.post(
        "/api/face/bootstrap",
        data={"name": "carol"},
        files={"image": ("face.jpg", fake_jpeg, "image/jpeg")},
    )

    # assert
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    # Stub-with-note pattern: client branches on `r.note`.
    assert "scaffold" in body["note"].lower()
    assert body["saved_to"].startswith("carol/")
    assert body["saved_to"].endswith("_bootstrap.jpg")
    # File actually written.
    target_dir = captures_root / "carol"
    assert target_dir.is_dir()
    written = list(target_dir.glob("*_bootstrap.jpg"))
    assert len(written) == 1
    assert written[0].read_bytes() == fake_jpeg


def test_given_invalid_name_when_bootstrapping_then_422(
    client, captures_root,
):
    # arrange — name has unsafe chars.

    # act
    r = client.post(
        "/api/face/bootstrap",
        data={"name": "../etc"},
        files={"image": ("face.jpg", b"\xff\xd8\xff\xe0", "image/jpeg")},
    )

    # assert
    assert r.status_code == 422


def test_given_unsupported_mime_type_when_bootstrapping_then_415(
    client, captures_root,
):
    # arrange — text/plain, NOT an image.

    # act
    r = client.post(
        "/api/face/bootstrap",
        data={"name": "carol"},
        files={"image": ("face.txt", b"not an image", "text/plain")},
    )

    # assert
    assert r.status_code == 415


def test_given_empty_image_when_bootstrapping_then_400(client, captures_root):
    # arrange

    # act
    r = client.post(
        "/api/face/bootstrap",
        data={"name": "carol"},
        files={"image": ("face.jpg", b"", "image/jpeg")},
    )

    # assert
    assert r.status_code == 400


def test_given_oversized_image_when_bootstrapping_then_413(
    client, captures_root,
):
    # arrange — 6 MB > the 5 MB cap.
    big = b"\xff\xd8\xff\xe0" + (b"a" * (6 * 1024 * 1024))

    # act
    r = client.post(
        "/api/face/bootstrap",
        data={"name": "carol"},
        files={"image": ("face.jpg", big, "image/jpeg")},
    )

    # assert
    assert r.status_code == 413


def test_when_anonymous_bootstraps_then_401(client_anon, captures_root):
    # arrange — anon client.

    # act
    r = client_anon.post(
        "/api/face/bootstrap",
        data={"name": "carol"},
        files={"image": ("face.jpg", b"\xff\xd8\xff\xe0", "image/jpeg")},
    )

    # assert
    assert r.status_code == 401


def test_when_owner_calls_retrain_then_returns_stub_with_note(
    client, captures_root,
):
    # arrange — Phase 4 stub.

    # act
    r = client.post("/api/face/retrain")

    # assert
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    # The "scaffold" wording is the discriminator the client checks.
    # If a future iter wires the actual subprocess, this assertion
    # FIRES (caught by test failure) so the wording can't drift
    # without the audit.
    assert "scaffold" in body["note"].lower()


def test_when_anonymous_calls_retrain_then_401(client_anon, captures_root):
    # arrange — anon client.

    # act
    r = client_anon.post("/api/face/retrain")

    # assert
    assert r.status_code == 401


# iter-355a: sidecar JSON read + propagation tests.


def test_when_sidecar_present_then_listing_includes_predicted_name_and_confidence(
    client, captures_root,
):
    # arrange — write a sidecar next to the existing alice JPEG.
    import json
    sidecar = captures_root / "alice" / "1700000000000_evt-001.json"
    sidecar.write_text(json.dumps({
        "predicted_name": "alice",
        "confidence": 0.73,
        "event_id": "evt-001",
        "ts_ms": 1700000000000,
    }))

    # act
    r = client.get("/api/face/captures/alice")

    # assert
    body = r.json()
    matched = next(f for f in body["files"] if f["filename"].startswith("1700000000000_"))
    assert matched["predicted_name"] == "alice"
    assert matched["confidence"] == 0.73


def test_given_sidecar_missing_when_listed_then_predicted_name_falls_back_to_dirname(
    client, captures_root,
):
    # arrange — pre-populated alice files have NO sidecar (legacy state).

    # act
    r = client.get("/api/face/captures/alice")

    # assert
    body = r.json()
    for f in body["files"]:
        assert f["predicted_name"] == "alice"
        assert f["confidence"] is None


def test_given_corrupt_sidecar_when_listed_then_falls_back_to_defaults(
    client, captures_root,
):
    # arrange — sidecar that's not valid JSON.
    sidecar = captures_root / "alice" / "1700000000000_evt-001.json"
    sidecar.write_text("{not valid json")

    # act
    r = client.get("/api/face/captures/alice")

    # assert — fall back to defaults; route does NOT 500.
    assert r.status_code == 200
    body = r.json()
    matched = next(f for f in body["files"] if f["filename"].startswith("1700000000000_"))
    assert matched["predicted_name"] == "alice"
    assert matched["confidence"] is None


def test_given_string_confidence_in_sidecar_when_listed_then_drops_field_not_500(
    client, captures_root,
):
    # iter-356.5 (security G1): a compromised worker writing
    # `"confidence": "0.5"` (JSON string, not number) used to flow
    # through `<= 0.5` comparison and raise TypeError → unhandled →
    # HTTP 500 forever. The fix in _read_sidecar drops the bad field
    # cleanly. arrange — JPG + sidecar with stringly-typed confidence.
    (captures_root / "alice" / "1700000000001_evt-002.jpg").write_bytes(b"\xff\xd8\xff\xe0jpg")
    (captures_root / "alice" / "1700000000001_evt-002.json").write_text(
        '{"confidence": "0.5", "predicted_name": "alice"}'
    )

    # act
    r = client.get("/api/face/captures/alice")

    # assert — 200 not 500; confidence is None (rejected); name kept.
    assert r.status_code == 200
    body = r.json()
    matched = next(f for f in body["files"] if f["filename"].startswith("1700000000001_"))
    assert matched["confidence"] is None
    assert matched["predicted_name"] == "alice"


def test_given_oversized_predicted_name_when_listed_then_field_dropped(
    client, captures_root,
):
    # iter-356.5 (security G1): an attacker-controlled sidecar with a
    # 50KB predicted_name would inflate the response body. _read_sidecar
    # caps str fields at 64 chars. arrange.
    (captures_root / "alice" / "1700000000002_evt-003.jpg").write_bytes(b"\xff\xd8\xff\xe0jpg")
    huge = "A" * 1000
    (captures_root / "alice" / "1700000000002_evt-003.json").write_text(
        f'{{"confidence": 0.7, "predicted_name": "{huge}"}}'
    )

    # act
    r = client.get("/api/face/captures/alice")

    # assert — confidence kept; oversized predicted_name falls back.
    assert r.status_code == 200
    body = r.json()
    matched = next(f for f in body["files"] if f["filename"].startswith("1700000000002_"))
    assert matched["confidence"] == 0.7
    # Falls back to dirname per route default ("alice"), not the
    # oversized value.
    assert matched["predicted_name"] == "alice"


def test_given_bool_confidence_in_sidecar_when_listed_then_treated_as_invalid(
    client, captures_root,
):
    # iter-356.5 (security G1): isinstance(True, int) is True in
    # Python — explicit bool guard required.
    (captures_root / "alice" / "1700000000003_evt-004.jpg").write_bytes(b"\xff\xd8\xff\xe0jpg")
    (captures_root / "alice" / "1700000000003_evt-004.json").write_text(
        '{"confidence": true, "predicted_name": "alice"}'
    )

    # act
    r = client.get("/api/face/captures/alice")

    # assert — bool rejected, confidence is None.
    assert r.status_code == 200
    body = r.json()
    matched = next(f for f in body["files"] if f["filename"].startswith("1700000000003_"))
    assert matched["confidence"] is None


def test_when_capture_moved_then_sidecar_moves_with_it(client, captures_root):
    # arrange — alice/1700_evt-001.jpg + sidecar; move to bob/.
    import json
    sidecar_src = captures_root / "alice" / "1700000000000_evt-001.json"
    sidecar_src.write_text(json.dumps({
        "predicted_name": "alice",
        "confidence": 0.83,
        "event_id": "evt-001",
        "ts_ms": 1700000000000,
    }))

    # act
    r = client.post(
        "/api/face/captures/alice/1700000000000_evt-001.jpg/move",
        json={"target_name": "bob"},
    )

    # assert
    assert r.status_code == 200
    bob_sidecar = captures_root / "bob" / "1700000000000_evt-001.json"
    assert bob_sidecar.is_file()
    assert not sidecar_src.exists()
    # Listing bob/ now shows the carried-over confidence (0.83).
    r2 = client.get("/api/face/captures/bob")
    body = r2.json()
    assert any(f["confidence"] == 0.83 for f in body["files"])


def test_when_capture_deleted_then_sidecar_also_deleted(client, captures_root):
    # arrange — write sidecar.
    sidecar = captures_root / "alice" / "1700000000000_evt-001.json"
    sidecar.write_text("{}")
    assert sidecar.is_file()

    # act
    r = client.delete("/api/face/captures/alice/1700000000000_evt-001.jpg")

    # assert
    assert r.status_code == 200
    assert not sidecar.exists()


# iter-355c1: review_queue route tests. Surface uncertain captures
# sorted by |confidence - 0.5| ascending. The Tinder-card UI
# (iter-355c2) consumes this.


def _write_sidecar(root, name, basename, predicted_name, confidence):
    """Helper: write a sidecar JSON for an existing JPEG."""
    import json
    sidecar = root / name / (basename + ".json")
    sidecar.write_text(json.dumps({
        "predicted_name": predicted_name,
        "confidence": confidence,
        "event_id": basename.partition("_")[2],
        "ts_ms": int(basename.partition("_")[0]),
    }))


def test_when_owner_calls_review_queue_then_returns_uncertain_captures(
    client, captures_root,
):
    # arrange — alice has 2 files; write sidecars with mid-band confidence.
    _write_sidecar(captures_root, "alice", "1700000000000_evt-001",
                   predicted_name="alice", confidence=0.55)
    _write_sidecar(captures_root, "alice", "1700000060000_evt-002",
                   predicted_name="alice", confidence=0.40)

    # act
    r = client.get("/api/face/review_queue")

    # assert
    assert r.status_code == 200
    body = r.json()
    assert body["total_uncertain"] == 2
    # Closest-to-0.5 first → 0.55 (|.05|) before 0.40 (|.10|).
    assert body["items"][0]["confidence"] == 0.55
    assert body["items"][1]["confidence"] == 0.40
    # Each item carries current_dir + url back to the original capture.
    assert body["items"][0]["current_dir"] == "alice"
    assert body["items"][0]["url"].startswith("/api/face/captures/alice/")


def test_given_strong_matches_when_review_queue_called_then_excluded(
    client, captures_root,
):
    # arrange — high-confidence files (>0.75) shouldn't appear in
    # review queue. Low-confidence (<0.3) shouldn't either.
    _write_sidecar(captures_root, "alice", "1700000000000_evt-001",
                   predicted_name="alice", confidence=0.95)
    _write_sidecar(captures_root, "alice", "1700000060000_evt-002",
                   predicted_name="alice", confidence=0.15)
    # __unknown__ has 1 file already — no sidecar; should also be excluded.

    # act
    r = client.get("/api/face/review_queue")

    # assert — both filtered out.
    body = r.json()
    assert body["total_uncertain"] == 0
    assert body["items"] == []


def test_given_no_sidecar_when_review_queue_called_then_excluded(
    client, captures_root,
):
    # arrange — alice's existing files have NO sidecars (legacy state).

    # act
    r = client.get("/api/face/review_queue")

    # assert — captures without sidecars don't appear in the queue
    # (no confidence to sort by).
    body = r.json()
    assert body["total_uncertain"] == 0


def test_when_review_queue_called_with_limit_then_pagination_caps(
    client, captures_root,
):
    # arrange — 5 mid-band captures in alice/.
    for i, conf in enumerate([0.50, 0.51, 0.52, 0.53, 0.54], start=1):
        # Create a JPEG + sidecar pair.
        jpg_name = "{}_evt-{}".format(1700000000000 + i, i)
        (captures_root / "alice" / (jpg_name + ".jpg")).write_bytes(b"\xff\xd8")
        _write_sidecar(captures_root, "alice", jpg_name,
                       predicted_name="alice", confidence=conf)

    # act — limit=2.
    r = client.get("/api/face/review_queue?limit=2")

    # assert
    body = r.json()
    assert body["limit"] == 2
    assert body["total_uncertain"] == 5  # full count regardless of page
    assert len(body["items"]) == 2
    # Top 2 by uncertainty: 0.50 (|.00|) + 0.51 (|.01|).
    assert body["items"][0]["confidence"] == 0.50
    assert body["items"][1]["confidence"] == 0.51


def test_given_oversized_limit_when_review_queue_called_then_capped_at_max(
    client, captures_root,
):
    # arrange — limit cap is 100.

    # act
    r = client.get("/api/face/review_queue?limit=10000")

    # assert
    assert r.json()["limit"] == 100


def test_given_zero_limit_when_review_queue_called_then_clamped_to_one(
    client, captures_root,
):
    # arrange — limit floor is 1.

    # act
    r = client.get("/api/face/review_queue?limit=0")

    # assert
    assert r.json()["limit"] == 1


def test_when_anonymous_calls_review_queue_then_401(client_anon, captures_root):
    # arrange — anon client.

    # act
    r = client_anon.get("/api/face/review_queue")

    # assert
    assert r.status_code == 401


def test_given_no_captures_dir_when_review_queue_called_then_returns_empty(
    client, tmp_path, monkeypatch,
):
    # arrange — face_captures_dir doesn't exist.
    from app.config import settings
    monkeypatch.setattr(settings, "face_captures_dir", tmp_path / "nonexistent")

    # act
    r = client.get("/api/face/review_queue")

    # assert — 200 with empty list (matches list_capture_dirs convention).
    assert r.status_code == 200
    body = r.json()
    assert body["items"] == []
    assert body["total_uncertain"] == 0
