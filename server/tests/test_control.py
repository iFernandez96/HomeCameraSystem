from fastapi.testclient import TestClient


def test_capture_copies_latest_jpg_to_timestamped_file(client: TestClient, tmp_path, monkeypatch):
    """When the worker has produced a recent latest.jpg, /api/capture
    copies it to a snap_<ms>.jpg in the snapshots dir."""
    from app.config import settings
    from app.services.camera import CameraService, camera_service

    monkeypatch.setattr(settings, "snapshots_dir", tmp_path)
    latest = tmp_path / CameraService.LATEST_NAME
    latest.write_bytes(b"\xff\xd8\xff\xe0fake-jpeg-bytes\xff\xd9")

    r = client.post("/api/capture")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["url"].startswith("/snapshots/snap_")
    assert body["url"].endswith(".jpg")
    # Verify the copy happened and matches the source bytes.
    name = body["url"].rsplit("/", 1)[-1]
    copied = tmp_path / name
    assert copied.exists()
    assert copied.read_bytes() == latest.read_bytes()
    # Singleton state restored automatically by monkeypatch teardown.
    _ = camera_service  # silence unused-import warning


def test_capture_returns_503_when_no_latest_jpg(client: TestClient, tmp_path, monkeypatch):
    from app.config import settings

    monkeypatch.setattr(settings, "snapshots_dir", tmp_path)
    r = client.post("/api/capture")
    assert r.status_code == 503


def test_capture_refuses_stale_latest_jpg(client: TestClient, tmp_path, monkeypatch):
    """Older than LATEST_MAX_AGE_S means the worker is stalled — don't
    serve a 30-second-old frame as if it were a fresh snapshot."""
    import os
    import time as _time

    from app.config import settings
    from app.services.camera import CameraService

    monkeypatch.setattr(settings, "snapshots_dir", tmp_path)
    latest = tmp_path / CameraService.LATEST_NAME
    latest.write_bytes(b"old")
    stale_mtime = _time.time() - (CameraService.LATEST_MAX_AGE_S + 5)
    os.utime(latest, (stale_mtime, stale_mtime))

    r = client.post("/api/capture")
    assert r.status_code == 503


def test_capture_returns_503_when_camera_inactive(client: TestClient, monkeypatch):
    from app.services.camera import camera_service

    monkeypatch.setattr(camera_service, "active", False)
    r = client.post("/api/capture")
    assert r.status_code == 503


def test_capture_prunes_oldest_snapshots_past_cap(
    client: TestClient, tmp_path, monkeypatch
):
    """Without pruning, repeated /api/capture calls accumulate
    snap_*.jpg files indefinitely on the Jetson disk. Pin the cap so
    the most recent SNAP_MAX_KEEP snapshots are kept and older ones
    are unlinked. Filenames are `snap_<ms>.jpg` so alphabetic sort
    matches creation order."""
    from app.config import settings
    from app.services.camera import CameraService

    monkeypatch.setattr(settings, "snapshots_dir", tmp_path)
    latest = tmp_path / CameraService.LATEST_NAME
    latest.write_bytes(b"\xff\xd8\xff\xe0frame\xff\xd9")

    # Pre-seed (SNAP_MAX_KEEP) older snapshot files plus an unrelated
    # file (latest.jpg, thumb_*.jpg) — those must NOT be pruned.
    cap = CameraService.SNAP_MAX_KEEP
    for i in range(cap):
        # Distinct timestamp prefixes so sort order is deterministic
        # and these all sort before any new snap from the call below.
        (tmp_path / f"snap_{1_000_000_000_000 + i:013d}.jpg").write_bytes(b"old")
    (tmp_path / "thumb_999.jpg").write_bytes(b"thumb")

    # The fresh capture pushes us one over the cap → exactly one of
    # the seeded files should be unlinked (the oldest by name).
    r = client.post("/api/capture")
    assert r.status_code == 200, r.text

    snap_files = sorted(p.name for p in tmp_path.glob("snap_*.jpg"))
    assert len(snap_files) == cap
    # The oldest seeded file (lowest ms) is gone.
    assert f"snap_{1_000_000_000_000:013d}.jpg" not in snap_files
    # The thumbnail and latest.jpg are untouched.
    assert (tmp_path / "thumb_999.jpg").exists()
    assert latest.exists()


def test_capture_pruning_unlink_failure_does_not_block_snapshot(
    client: TestClient, tmp_path, monkeypatch, caplog
):
    """If the disk goes unwritable for stale entries (race with another
    process, transient error), the snapshot still succeeds — pruning is
    best-effort. Caller still gets the new file URL back."""
    from pathlib import Path

    from app.config import settings
    from app.services.camera import CameraService

    monkeypatch.setattr(settings, "snapshots_dir", tmp_path)
    latest = tmp_path / CameraService.LATEST_NAME
    latest.write_bytes(b"\xff\xd8\xff\xe0frame\xff\xd9")

    cap = CameraService.SNAP_MAX_KEEP
    for i in range(cap + 5):
        (tmp_path / f"snap_{1_000_000_000_000 + i:013d}.jpg").write_bytes(b"old")

    real_unlink = Path.unlink

    def explode(self, *a, **kw):
        if self.name.startswith("snap_") and self.name.endswith(".jpg") and self != latest:
            # Simulate a stale-FS unlink failure on the prune path.
            raise OSError("simulated EIO")
        return real_unlink(self, *a, **kw)

    monkeypatch.setattr(Path, "unlink", explode)

    r = client.post("/api/capture")
    # Capture itself succeeded — the new snap_*.jpg was copy2'd before
    # pruning ran, so the route still returns 200 with a URL.
    assert r.status_code == 200, r.text
    assert r.json()["url"].startswith("/snapshots/snap_")


def test_detection_toggle_flips_state(client: TestClient):
    s1 = client.get("/api/status").json()
    initial = s1["detection_active"]
    r = client.post("/api/detection/toggle")
    assert r.status_code == 200
    assert r.json()["active"] != initial


def test_system_reboot_returns_ok_with_scaffold_note(client: TestClient):
    r = client.post("/api/system/reboot")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    # Scaffold returns a note flagging that this is stubbed; remove this assertion
    # once the route is wired to actually call systemctl.
    assert "note" in body


def test_system_backup_returns_ok_with_scaffold_note(client: TestClient):
    """iter-210 (Feature #10 slice 1): /api/system/backup mirrors
    the reboot scaffold pattern. Returns a `note` field flagging the
    stub; remove this assertion once the host-helper is wired up."""
    r = client.post("/api/system/backup")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert "note" in body
    assert "stub" in body["note"].lower()


# iter-212 (Feature #10 slice 3): /api/system/restore. Stub-with-note
# pattern + two-tier path-traversal defense (Pydantic regex + service-
# layer Path.resolve().relative_to() check). Same body validation
# style as the SPA traversal-guard sharp edge in `app/main.py`.

def _patch_backup_target(tmp_path, monkeypatch):
    """Helper: scope `settings.backup_target_dir` to a tmp dir for
    the test. Creates the dir so resolve() lands somewhere real."""
    from app.config import settings

    target = tmp_path / "backups"
    target.mkdir()
    monkeypatch.setattr(settings, "backup_target_dir", target)
    return target


def test_system_restore_happy_path_returns_note(
    client: TestClient, tmp_path, monkeypatch
):
    _patch_backup_target(tmp_path, monkeypatch)
    r = client.post(
        "/api/system/restore",
        json={"backup_path": "homecam-2026-04-30.tar.gz"},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert "note" in body
    assert "stub" in body["note"].lower()
    assert body["backup_path"] == "homecam-2026-04-30.tar.gz"


def test_system_restore_accepts_subdir_paths(
    client: TestClient, tmp_path, monkeypatch
):
    _patch_backup_target(tmp_path, monkeypatch)
    r = client.post(
        "/api/system/restore",
        json={"backup_path": "monthly/2026-04.tar.gz"},
    )
    assert r.status_code == 200


def test_system_restore_rejects_double_dot_traversal(
    client: TestClient, tmp_path, monkeypatch
):
    """A `..` segment must 400 — defense-in-depth, even though the
    regex would match `../etc/passwd` (dots are allowed for filename
    extensions)."""
    _patch_backup_target(tmp_path, monkeypatch)
    r = client.post(
        "/api/system/restore",
        json={"backup_path": "../etc/passwd"},
    )
    assert r.status_code == 400
    assert ".." in r.json()["detail"]


def test_system_restore_rejects_leading_slash_absolute(
    client: TestClient, tmp_path, monkeypatch
):
    """A leading `/` makes Pathlib treat it as absolute, blowing
    out of target_root. Must reject."""
    _patch_backup_target(tmp_path, monkeypatch)
    r = client.post(
        "/api/system/restore",
        json={"backup_path": "/etc/passwd"},
    )
    assert r.status_code == 400


def test_system_restore_rejects_shell_metacharacters(client: TestClient):
    """Pydantic regex `^[A-Za-z0-9_./-]+$` 422s any path with shell
    metas or whitespace — keeps the 422 path obvious for typos."""
    r = client.post(
        "/api/system/restore",
        json={"backup_path": "backup;rm -rf /"},
    )
    assert r.status_code == 422


def test_system_restore_rejects_empty_path(client: TestClient):
    r = client.post(
        "/api/system/restore",
        json={"backup_path": ""},
    )
    assert r.status_code == 422


def test_system_restore_rejects_missing_body(client: TestClient):
    r = client.post("/api/system/restore", json={})
    assert r.status_code == 422


def test_system_restore_rejects_extra_fields(client: TestClient):
    """`_RestoreBody` is `extra='forbid'` — unknown root keys 422
    so an attacker can't smuggle metadata."""
    r = client.post(
        "/api/system/restore",
        json={"backup_path": "x.tar", "evil": "yes"},
    )
    assert r.status_code == 422


# iter-213 (Feature #8 slice 1): daily-timelapse trigger + listing.
# Stub-with-note pattern. POST returns the URL where the timelapse
# WILL appear; GET lists files matching `<date>.mp4` in the dir.

def _patch_timelapses(tmp_path, monkeypatch):
    from app.config import settings

    target = tmp_path / "timelapses"
    target.mkdir()
    monkeypatch.setattr(settings, "timelapses_dir", target)
    return target


def test_when_no_clips_for_day_then_timelapse_returns_no_events_note(
    client: TestClient, tmp_path, monkeypatch
):
    """iter-306 changed iter-213's stub-with-note path. Without
    clips on that day, the route still returns 200 + a `note` so
    the iter-211 client toast pattern fires honestly."""
    # arrange — no events seeded, so the day has zero clips.
    _patch_timelapses(tmp_path, monkeypatch)

    # act
    r = client.post(
        "/api/system/timelapse",
        json={"date": "2026-04-30"},
    )

    # assert
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert "note" in body
    assert "no recorded events" in body["note"].lower()
    assert body["date"] == "2026-04-30"
    assert body["url"] == "/api/timelapses/2026-04-30.mp4"


def test_system_timelapse_rejects_malformed_date(client: TestClient):
    """Pydantic regex YYYY-MM-DD — non-matching patterns 422."""
    for bad in ("2026/04/30", "26-04-30", "today", "2026-4-30", "2026-04-30T00:00:00"):
        r = client.post("/api/system/timelapse", json={"date": bad})
        assert r.status_code == 422, f"expected 422 for {bad!r}, got {r.status_code}"


def test_system_timelapse_rejects_extra_fields(client: TestClient):
    """`_TimelapseBody` is `extra='forbid'` — unknown root keys 422."""
    r = client.post(
        "/api/system/timelapse",
        json={"date": "2026-04-30", "format": "webm"},
    )
    assert r.status_code == 422


def test_system_timelapse_rejects_missing_date(client: TestClient):
    r = client.post("/api/system/timelapse", json={})
    assert r.status_code == 422


def test_list_timelapses_returns_empty_when_dir_missing(
    client: TestClient, tmp_path, monkeypatch
):
    """Pre-host-helper state: dir is empty (or doesn't exist).
    Endpoint must not 500 — return `{"items": []}`."""
    from app.config import settings

    monkeypatch.setattr(settings, "timelapses_dir", tmp_path / "nonexistent")
    r = client.get("/api/system/timelapses")
    assert r.status_code == 200
    assert r.json() == {"items": []}


def test_list_timelapses_returns_files_sorted_newest_first(
    client: TestClient, tmp_path, monkeypatch
):
    target = _patch_timelapses(tmp_path, monkeypatch)
    (target / "2026-04-30.mp4").write_bytes(b"\x00" * 100)
    (target / "2026-04-29.mp4").write_bytes(b"\x00" * 200)
    (target / "2026-05-01.mp4").write_bytes(b"\x00" * 50)
    r = client.get("/api/system/timelapses")
    assert r.status_code == 200
    items = r.json()["items"]
    assert [it["date"] for it in items] == ["2026-05-01", "2026-04-30", "2026-04-29"]
    assert items[0]["url"] == "/api/timelapses/2026-05-01.mp4"
    assert items[0]["size_bytes"] == 50
    assert items[1]["size_bytes"] == 100


def test_system_update_returns_ok_with_scaffold_note(client: TestClient):
    """iter-230 (Feature #12 OTA slice 1): mirrors the iter-197/iter-
    210/iter-213 stub-with-note pattern. Returns `note` until the
    host-helper is wired up; client (iter-231) surfaces honestly."""
    r = client.post("/api/system/update")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert "note" in body
    assert "stub" in body["note"].lower()


# iter-238 (Feature #10/12 follow-up): /api/system/backups listing.
# Mirrors iter-213 timelapse listing tests.

def test_list_backups_returns_files_sorted_newest_first(
    client: TestClient, tmp_path, monkeypatch
):
    target = _patch_backup_target(tmp_path, monkeypatch)
    import os, time
    # Create three files with distinct mtimes (newest = third).
    paths = [target / f"backup-{i}.tar.gz" for i in range(3)]
    for i, p in enumerate(paths):
        p.write_bytes(b"\x00" * (100 + i))
        os.utime(p, (time.time() + i * 100, time.time() + i * 100))
    r = client.get("/api/system/backups")
    assert r.status_code == 200
    items = r.json()["items"]
    assert [it["filename"] for it in items] == [
        "backup-2.tar.gz",
        "backup-1.tar.gz",
        "backup-0.tar.gz",
    ]
    assert items[0]["size_bytes"] == 102


def test_list_backups_returns_empty_when_dir_missing(
    client: TestClient, tmp_path, monkeypatch
):
    """Pre-deploy state: backup_target_dir doesn't exist yet. Route
    must not 500 — returns empty items list."""
    from app.config import settings

    monkeypatch.setattr(settings, "backup_target_dir", tmp_path / "nonexistent")
    r = client.get("/api/system/backups")
    assert r.status_code == 200
    assert r.json() == {"items": []}


def test_list_backups_filters_non_matching_files(
    client: TestClient, tmp_path, monkeypatch
):
    """Filename regex `^[A-Za-z0-9_.-]+$` rejects shell metas /
    whitespace / slashes. Subdirs ignored."""
    target = _patch_backup_target(tmp_path, monkeypatch)
    (target / "valid.tar.gz").write_bytes(b"\x00")
    (target / "with space.tar").write_bytes(b"\x00")  # space → reject
    (target / "shell;rm.tar").write_bytes(b"\x00")  # semi → reject
    (target / "subdir").mkdir()
    r = client.get("/api/system/backups")
    items = r.json()["items"]
    names = [it["filename"] for it in items]
    assert names == ["valid.tar.gz"]


def test_system_version_returns_version_string(client: TestClient):
    """iter-232 (Feature #12 OTA slice 3a): exposes the server
    version. Default '0.1.0' from settings; iter-233 client UI
    will surface this in Settings."""
    r = client.get("/api/system/version")
    assert r.status_code == 200
    body = r.json()
    assert "version" in body
    assert isinstance(body["version"], str)
    assert body["version"]  # non-empty


def test_system_version_reflects_settings_override(
    client: TestClient, monkeypatch
):
    """Override via `settings.version` propagates to the route —
    proves the env-var path (HOMECAM_VERSION) is wired correctly
    via the same monkeypatch shape used by other config-aware tests."""
    from app.config import settings

    monkeypatch.setattr(settings, "version", "9.9.9-test")
    r = client.get("/api/system/version")
    assert r.json() == {"version": "9.9.9-test"}


def test_system_version_anon_returns_401(client_anon: TestClient):
    """Auth-gated even though informational — version disclosure to
    unauthenticated callers is unnecessary attack surface."""
    r = client_anon.get("/api/system/version")
    assert r.status_code == 401


def test_list_timelapses_filters_non_matching_files(
    client: TestClient, tmp_path, monkeypatch
):
    """Operator drops random files in the dir → must NOT appear in
    the listing. Filename must strict-match YYYY-MM-DD.mp4."""
    target = _patch_timelapses(tmp_path, monkeypatch)
    (target / "2026-04-30.mp4").write_bytes(b"\x00")
    (target / "README.txt").write_text("hi")
    (target / "2026-04-30.txt").write_text("not mp4")
    (target / "test.mp4").write_bytes(b"\x00")
    (target / "26-04-30.mp4").write_bytes(b"\x00")
    (target / "subdir").mkdir()  # subdirs ignored
    r = client.get("/api/system/timelapses")
    items = r.json()["items"]
    assert len(items) == 1
    assert items[0]["date"] == "2026-04-30"


# iter-306 (user "wireup the timelapse please"): added the ffmpeg-
# based builder. Pin the new branches.

def test_when_clips_exist_but_ffmpeg_missing_then_returns_ffmpeg_error_note(
    client: TestClient, tmp_path, monkeypatch
):
    """iter-306: dev host doesn't have ffmpeg in PATH; the route
    catches the FileNotFoundError and reports it via `note`. Pre-
    iter-306 this would 500."""
    # arrange
    _patch_timelapses(tmp_path, monkeypatch)
    # Patch recordings_dir + seed an event whose clip_url resolves
    # to an existing file on disk.
    from app.config import settings
    from app.services import events_db
    from app.services.event_bus import make_detection_event
    rec_dir = tmp_path / "recordings"
    rec_dir.mkdir()
    monkeypatch.setattr(settings, "recordings_dir", rec_dir)
    e = make_detection_event(label="person", score=0.9, boxes=[])
    e["clip_url"] = f"/api/events/{e['id']}/clip"
    # `clip_id == event.id` per the iter-306 _resolve_clip_path logic.
    (rec_dir / f"{e['id']}.mp4").write_bytes(b"fake-mp4-bytes")
    # Place the event INSIDE 2026-04-30 local-time.
    import time as _time
    e["ts"] = _time.mktime((2026, 4, 30, 12, 0, 0, 0, 0, -1))
    events_db.insert_event(settings.events_db_path, e)
    # Force ffmpeg lookup failure.
    import shutil
    real_which = shutil.which

    def fake_which(cmd, *a, **k):
        if cmd == "ffmpeg":
            return None
        return real_which(cmd, *a, **k)
    # (subprocess.run still tries PATH; easier: use monkeypatch on
    # subprocess.run inside the timelapse module.)
    from app.services import timelapse as _tl

    def fake_run(*a, **k):
        raise FileNotFoundError("ffmpeg")
    monkeypatch.setattr(_tl.subprocess, "run", fake_run)

    # act
    r = client.post(
        "/api/system/timelapse",
        json={"date": "2026-04-30"},
    )

    # assert
    body = r.json()
    assert body["ok"] is True
    assert "note" in body
    assert "couldn't build" in body["note"].lower() or "ffmpeg" in body["note"].lower()


def test_when_clips_exist_and_ffmpeg_succeeds_then_no_note_in_response(
    client: TestClient, tmp_path, monkeypatch
):
    """iter-306 success path: drops the `note` field so the iter-211
    client toast pattern flips to the success branch ("Timelapse
    requested")."""
    # arrange
    _patch_timelapses(tmp_path, monkeypatch)
    from app.config import settings
    from app.services import events_db
    from app.services.event_bus import make_detection_event
    rec_dir = tmp_path / "recordings"
    rec_dir.mkdir()
    monkeypatch.setattr(settings, "recordings_dir", rec_dir)
    e = make_detection_event(label="person", score=0.9, boxes=[])
    e["clip_url"] = f"/api/events/{e['id']}/clip"
    (rec_dir / f"{e['id']}.mp4").write_bytes(b"fake-mp4-bytes")
    import time as _time
    e["ts"] = _time.mktime((2026, 4, 30, 12, 0, 0, 0, 0, -1))
    events_db.insert_event(settings.events_db_path, e)
    # Stub ffmpeg as a successful no-op.
    from app.services import timelapse as _tl
    output_path = settings.timelapses_dir / "2026-04-30.mp4"

    class _FakeResult:
        returncode = 0
        stdout = b""
        stderr = b""

    def fake_run(*a, **k):
        # Pretend ffmpeg wrote the output file.
        output_path.write_bytes(b"fake-output")
        return _FakeResult()
    monkeypatch.setattr(_tl.subprocess, "run", fake_run)

    # act
    r = client.post(
        "/api/system/timelapse",
        json={"date": "2026-04-30"},
    )

    # assert
    body = r.json()
    assert body["ok"] is True
    assert "note" not in body, f"success path must not return a note (got {body})"
    assert body["url"] == "/api/timelapses/2026-04-30.mp4"


# iter-309 (user "add the ability to delete timelapsed videos"):
# DELETE /api/system/timelapse?date=YYYY-MM-DD. Owner-gated,
# regex-validated, soft 200 on missing file.

def test_when_timelapse_exists_and_delete_called_then_returns_deleted_true(
    client: TestClient, tmp_path, monkeypatch
):
    # arrange
    _patch_timelapses(tmp_path, monkeypatch)
    from app.config import settings
    (settings.timelapses_dir / "2026-04-30.mp4").write_bytes(b"fake")

    # act
    r = client.delete("/api/system/timelapse?date=2026-04-30")

    # assert
    assert r.status_code == 200
    assert r.json() == {"deleted": True, "date": "2026-04-30"}
    assert not (settings.timelapses_dir / "2026-04-30.mp4").exists()


def test_when_timelapse_missing_and_delete_called_then_returns_deleted_false(
    client: TestClient, tmp_path, monkeypatch
):
    # arrange
    _patch_timelapses(tmp_path, monkeypatch)

    # act
    r = client.delete("/api/system/timelapse?date=2026-04-30")

    # assert
    assert r.status_code == 200
    assert r.json() == {"deleted": False, "date": "2026-04-30"}


def test_when_delete_timelapse_called_with_malformed_date_then_422(client: TestClient):
    # arrange — Pydantic Query pattern enforces YYYY-MM-DD shape.

    # act
    r = client.delete("/api/system/timelapse?date=2026/04/30")

    # assert
    assert r.status_code == 422


def test_when_anonymous_user_calls_delete_timelapse_then_401(client_anon):
    # act
    r = client_anon.delete("/api/system/timelapse?date=2026-04-30")

    # assert
    assert r.status_code == 401


# iter-317 (security-auditor D1): auth-gated /api/timelapses/<date>.mp4
# replaces the pre-iter-317 unauth /timelapses StaticFiles mount.

def test_when_authenticated_user_fetches_existing_timelapse_then_200_with_video_mp4(
    client: TestClient, tmp_path, monkeypatch
):
    # arrange
    _patch_timelapses(tmp_path, monkeypatch)
    from app.config import settings
    (settings.timelapses_dir / "2026-04-30.mp4").write_bytes(b"fake-mp4-bytes")

    # act
    r = client.get("/api/timelapses/2026-04-30.mp4")

    # assert
    assert r.status_code == 200
    assert r.headers["content-type"] == "video/mp4"
    assert r.content == b"fake-mp4-bytes"


def test_when_anonymous_user_fetches_timelapse_then_401(client_anon, tmp_path, monkeypatch):
    # arrange
    _patch_timelapses(tmp_path, monkeypatch)
    from app.config import settings
    (settings.timelapses_dir / "2026-04-30.mp4").write_bytes(b"fake-mp4-bytes")

    # act
    r = client_anon.get("/api/timelapses/2026-04-30.mp4")

    # assert
    assert r.status_code == 401


def test_when_filename_has_traversal_chars_then_no_mp4_bytes_returned(
    client: TestClient, tmp_path, monkeypatch
):
    """iter-317: even if a malformed path falls through the route
    matcher (URL-decoded `..%2F` becomes a multi-segment path that
    doesn't bind `{filename}` cleanly), the SPA catch-all returns
    HTML — NEVER MP4 bytes. The security guarantee is "no MP4 leaks
    via this URL", not a specific status code."""
    # arrange
    _patch_timelapses(tmp_path, monkeypatch)

    # act + assert
    for bad in (
        "..%2Fetc%2Fpasswd",
        "abc.mp4",          # regex-rejected at handler → 404
        "2026-04-30.txt",   # regex-rejected at handler → 404
        "2026-13-30.mp4",   # invalid month → regex-rejected → 404
    ):
        r = client.get(f"/api/timelapses/{bad}")
        # 404 (handler regex-rejected) OR 200 (SPA HTML fallback)
        # are both acceptable; what matters is no MP4 leaks.
        assert r.status_code in (200, 404), (
            f"unexpected status {r.status_code} for {bad!r}"
        )
        if r.status_code == 200:
            ct = r.headers.get("content-type", "")
            assert "mp4" not in ct, (
                f"path {bad!r} leaked an MP4 (content-type={ct!r})"
            )


def test_when_timelapse_missing_then_404(client: TestClient, tmp_path, monkeypatch):
    # arrange
    _patch_timelapses(tmp_path, monkeypatch)

    # act
    r = client.get("/api/timelapses/2026-04-30.mp4")

    # assert
    assert r.status_code == 404


def test_when_old_unauth_path_used_then_404(client: TestClient, tmp_path, monkeypatch):
    """iter-317: the pre-iter-317 /timelapses StaticFiles mount is
    REMOVED. Hitting the old path returns 404 (no route mounted)."""
    # arrange
    _patch_timelapses(tmp_path, monkeypatch)
    from app.config import settings
    (settings.timelapses_dir / "2026-04-30.mp4").write_bytes(b"fake")

    # act
    r = client.get("/timelapses/2026-04-30.mp4")

    # assert — the SPA catch-all serves index.html for unknown
    # paths, but timelapses dir is NOT a route now. Either 404
    # OR 200 (SPA fallback returning HTML, NOT the MP4 bytes).
    if r.status_code == 200:
        # SPA fallback — verify it's NOT the MP4 content.
        assert r.headers.get("content-type", "").startswith("text/html") or "mp4" not in r.headers.get("content-type", "")
        assert b"fake" not in r.content
    else:
        assert r.status_code == 404


# iter-318 (security-auditor D1, same class as iter-317): /snapshots
# is now auth-gated (was unauth StaticFiles mount). Same URL path
# preserved for backwards compat with stored event thumb_url rows.

def test_when_anon_fetches_snapshot_then_401(client_anon, tmp_path, monkeypatch):
    # arrange
    from app.config import settings
    monkeypatch.setattr(settings, "snapshots_dir", tmp_path)
    (tmp_path / "latest.jpg").write_bytes(b"\xff\xd8\xff\xe0fake-jpeg\xff\xd9")

    # act
    r = client_anon.get("/api/snapshots/latest.jpg")

    # assert
    assert r.status_code == 401


def test_when_authed_fetches_existing_snapshot_then_200_with_image_jpeg(
    client: TestClient, tmp_path, monkeypatch
):
    # arrange
    from app.config import settings
    monkeypatch.setattr(settings, "snapshots_dir", tmp_path)
    (tmp_path / "latest.jpg").write_bytes(b"\xff\xd8\xff\xe0fake-jpeg\xff\xd9")

    # act
    r = client.get("/api/snapshots/latest.jpg")

    # assert
    assert r.status_code == 200
    assert r.headers["content-type"] == "image/jpeg"
    assert r.content.startswith(b"\xff\xd8\xff\xe0")


def test_when_legacy_path_used_then_redirected_to_api_path(
    client: TestClient, tmp_path, monkeypatch
):
    """iter-318: pre-iter-318 events_db rows + worker emits use
    `/snapshots/...` URLs. The legacy passthrough returns 308 →
    `/api/snapshots/...` so old links still work after the auth
    gate is added."""
    # arrange
    from app.config import settings
    monkeypatch.setattr(settings, "snapshots_dir", tmp_path)
    (tmp_path / "latest.jpg").write_bytes(b"\xff\xd8\xff\xe0fake-jpeg\xff\xd9")

    # act — TestClient by default follows redirects. Disable for
    # this assertion so we can verify the 308 is actually emitted.
    r = client.get("/snapshots/latest.jpg", follow_redirects=False)

    # assert
    assert r.status_code == 308
    assert r.headers["location"] == "/api/snapshots/latest.jpg"


def test_when_filename_doesnt_match_pattern_then_404(client: TestClient, tmp_path, monkeypatch):
    """iter-318: regex rejects anything that isn't latest|snap_<ms>|
    thumb_<id>. Defense in depth — even with a regex-clean name,
    the resolve+relative_to check would catch traversal."""
    # arrange
    from app.config import settings
    monkeypatch.setattr(settings, "snapshots_dir", tmp_path)

    # act + assert
    for bad in (
        "evilfile.jpg",                       # not in {latest, snap_*, thumb_*}
        "latest.txt",                          # not .jpg
        "snap_abc.jpg",                        # snap_ requires digits
        "thumb_..%2Fpasswd.jpg",               # traversal in id field
        ".latest.jpg",                         # dotfile
    ):
        r = client.get(f"/api/snapshots/{bad}")
        assert r.status_code in (200, 404), (
            f"unexpected status {r.status_code} for {bad!r}"
        )
        if r.status_code == 200:
            ct = r.headers.get("content-type", "")
            assert "image" not in ct, (
                f"path {bad!r} leaked an image (content-type={ct!r})"
            )


def test_when_existing_snap_file_authed_then_returned(
    client: TestClient, tmp_path, monkeypatch
):
    # arrange — operator-triggered snapshot filename shape `snap_<ms>.jpg`.
    from app.config import settings
    monkeypatch.setattr(settings, "snapshots_dir", tmp_path)
    (tmp_path / "snap_1750000000000.jpg").write_bytes(b"\xff\xd8\xff\xe0snap\xff\xd9")

    # act
    r = client.get("/api/snapshots/snap_1750000000000.jpg")

    # assert
    assert r.status_code == 200
    assert r.content.startswith(b"\xff\xd8\xff\xe0")


def test_when_existing_thumb_file_authed_then_returned(
    client: TestClient, tmp_path, monkeypatch
):
    # arrange — worker-written thumb shape `thumb_<event_id>.jpg`.
    from app.config import settings
    monkeypatch.setattr(settings, "snapshots_dir", tmp_path)
    fname = "thumb_abc123_def-456.jpg"
    (tmp_path / fname).write_bytes(b"\xff\xd8\xff\xe0thumb\xff\xd9")

    # act
    r = client.get(f"/api/snapshots/{fname}")

    # assert
    assert r.status_code == 200
