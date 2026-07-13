import asyncio
import hashlib
import json
import tarfile
import time

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


def test_given_config_patch_when_applied_then_audits_keys_not_zone_values(
    client: TestClient, caplog
):
    """Given an owner patches detection config including zone geometry,
    When the route runs, Then the audit log records the changed KEY SET
    but NEVER the zone coordinate values (privacy/PII guardrail §4)."""
    import logging

    # arrange — a patch with a zone polygon carrying distinctive coords
    caplog.set_level(logging.INFO, logger="app.routes.control")
    sentinel = 0.123456
    payload = {
        "threshold": 0.55,
        "zones": [[[sentinel, 0.2], [0.3, 0.4], [0.5, 0.6]]],
    }

    # act
    r = client.patch("/api/detection/config", json=payload)

    # assert
    assert r.status_code == 200, r.text
    audit = [
        rec for rec in caplog.records
        if "detection config patch" in rec.getMessage()
    ]
    assert audit, "expected a detection config patch audit line"
    msg = audit[0].getMessage()
    assert "threshold" in msg and "zones" in msg
    # The zone coordinate value must NOT leak into the log.
    assert str(sentinel) not in msg


def test_system_reboot_queues_reboot_host_action(client: TestClient):
    from app.services import audit_db, host_bridge
    from app.config import settings

    r = client.post("/api/system/reboot", json={"confirm": True})
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert body["request_id"]
    assert body["status"] == "pending"
    rec = host_bridge.get(body["request_id"])
    assert rec["kind"] == "reboot"
    rows = audit_db.host_action_events_between(
        settings.audit_db_path, since=0, until=9999999999
    )
    assert rows[0]["phase"] == "requested"
    assert rows[0]["action"] == "reboot"


def test_given_owner_recover_without_confirm_when_posted_then_rejected(
    client: TestClient,
):
    r = client.post(
        "/api/system/recover",
        json={"action": "mediamtx", "confirm": False},
    )
    assert r.status_code == 400


def test_given_owner_recover_when_posted_then_status_reflects_worker_result(
    client: TestClient,
):
    from app.services import host_bridge

    r = client.post(
        "/api/system/recover",
        json={"action": "nvargus", "confirm": True},
    )
    assert r.status_code == 200, r.text
    request_id = r.json()["request_id"]
    status = client.get(
        "/api/system/recover/status", params={"request_id": request_id}
    )
    assert status.status_code == 200
    assert status.json()["status"] == "pending"

    assert host_bridge.claim(request_id, now=101.0) == "claimed"
    assert host_bridge.record_result(
        request_id, "done", "nvargus restart requested", None, now=102.0
    )
    status = client.get(
        "/api/system/recover/status", params={"request_id": request_id}
    )
    assert status.json()["status"] == "done"
    assert status.json()["detail"] == "nvargus restart requested"


def test_given_owner_when_focus_mode_enabled_then_host_change_is_queued(
    client: TestClient,
):
    from app.services import host_bridge

    response = client.post("/api/camera/focus-mode", json={"enabled": True})
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["timeout_s"] == 300
    rec = host_bridge.get(body["request_id"])
    assert rec["kind"] == "focus_start"


def test_given_anon_when_focus_mode_requested_then_unauthorized(client_anon: TestClient):
    response = client_anon.post("/api/camera/focus-mode", json={"enabled": True})
    assert response.status_code == 401


def test_given_owner_when_exposure_saved_then_config_persists_and_apply_is_queued(
    client: TestClient,
):
    from app.services import host_bridge

    payload = {
        "enabled": True, "x": 0.2, "y": 0.25, "width": 0.5, "height": 0.5,
        "compensation": 0.4, "locked": False,
    }
    response = client.put("/api/camera/exposure", json=payload)
    assert response.status_code == 200, response.text
    body = response.json()
    assert {key: body[key] for key in payload} == payload
    record = host_bridge.get(body["request_id"])
    assert record["kind"] == "exposure_apply"
    assert {key: record["args"][key] for key in payload} == payload
    assert record["args"]["_previous_config"] == {
        "enabled": False,
        "x": 0.25,
        "y": 0.25,
        "width": 0.5,
        "height": 0.5,
        "compensation": 0.0,
        "locked": False,
    }
    assert client.get("/api/camera/exposure").json() == payload


def test_given_worker_exposure_failure_when_result_posts_then_server_rolls_back(
    client: TestClient,
):
    previous = client.get("/api/camera/exposure").json()
    desired = {
        "enabled": True,
        "x": 0.1,
        "y": 0.15,
        "width": 0.5,
        "height": 0.5,
        "compensation": 0.8,
        "locked": True,
    }
    queued = client.put("/api/camera/exposure", json=desired)
    assert queued.status_code == 200
    request_id = queued.json()["request_id"]
    assert client.get("/api/camera/exposure").json() == desired

    claimed = client.post(
        "/api/_internal/host_action/claim", json={"id": request_id}
    )
    assert claimed.json() == {"result": "claimed"}
    failed = client.post(
        "/api/_internal/host_action/result",
        json={
            "id": request_id,
            "status": "failed",
            "detail": "camera exposure failed; previous settings restored",
            "result": None,
        },
    )
    assert failed.status_code == 200 and failed.json() == {"ok": True}
    assert client.get("/api/camera/exposure").json() == previous

    # A later accepted config must not be overwritten by a replay of the old
    # failed callback (worker retries are expected after network loss).
    later = {**desired, "compensation": -0.4, "locked": False}
    later_response = client.put("/api/camera/exposure", json=later)
    assert later_response.status_code == 200
    replay = client.post(
        "/api/_internal/host_action/result",
        json={
            "id": request_id,
            "status": "failed",
            "detail": "duplicate retry",
            "result": None,
        },
    )
    assert replay.status_code == 200 and replay.json() == {"ok": False}
    assert client.get("/api/camera/exposure").json() == later


def test_given_other_host_action_pending_when_exposure_put_then_409_and_no_mutation(
    client: TestClient,
):
    from app.services import host_bridge

    previous = client.get("/api/camera/exposure").json()
    host_bridge.enqueue("mediamtx", {}, requested_by="testuser", now=time.time())
    response = client.put(
        "/api/camera/exposure",
        json={
            **previous,
            "enabled": True,
            "compensation": 0.5,
        },
    )
    assert response.status_code == 409
    assert client.get("/api/camera/exposure").json() == previous


def test_given_exposure_apply_expires_when_worker_polls_then_previous_is_requeued(
    client: TestClient,
):
    from dataclasses import asdict

    from app.services import host_bridge
    from app.services.camera_exposure import CameraExposureConfig, camera_exposure

    previous = camera_exposure.get()
    desired = CameraExposureConfig(
        enabled=True,
        x=0.1,
        y=0.1,
        width=0.5,
        height=0.5,
        compensation=1.0,
        locked=True,
    )
    camera_exposure.save(desired)
    stale = host_bridge.enqueue(
        "exposure_apply",
        {**asdict(desired), "_previous_config": asdict(previous)},
        requested_by="testuser",
        now=0.0,
    )

    polled = client.get("/api/_internal/host_action")
    assert polled.status_code == 200
    rollback = polled.json()["action"]
    assert rollback["id"] != stale["id"]
    assert rollback["kind"] == "exposure_apply"
    assert {
        key: rollback["args"][key] for key in asdict(previous)
    } == asdict(previous)
    assert host_bridge.get(stale["id"])["status"] == "expired"
    assert client.get("/api/camera/exposure").json() == asdict(previous)


def test_given_exposure_region_outside_frame_when_saved_then_rejected(client: TestClient):
    response = client.put("/api/camera/exposure", json={
        "enabled": True, "x": 0.7, "y": 0.1, "width": 0.5, "height": 0.5,
        "compensation": 0, "locked": False,
    })
    assert response.status_code == 422


def test_given_anon_when_exposure_saved_then_unauthorized(client_anon: TestClient):
    response = client_anon.put("/api/camera/exposure", json={
        "enabled": False, "x": 0.25, "y": 0.25, "width": 0.5, "height": 0.5,
        "compensation": 0, "locked": False,
    })
    assert response.status_code == 401


def test_given_named_exposure_zone_when_saved_then_thumbnail_and_config_can_be_restored(
    client: TestClient,
):
    config = {
        "enabled": True, "x": 0.1, "y": 0.2, "width": 0.4, "height": 0.5,
        "compensation": 0.7, "locked": False,
    }
    thumbnail = "data:image/jpeg;base64,AAAA"
    created = client.post("/api/camera/exposure-presets", json={
        "name": "  Bright doorway  ", "thumbnail": thumbnail, "config": config,
    })
    assert created.status_code == 200, created.text
    preset = created.json()
    assert preset["name"] == "Bright doorway"
    assert preset["thumbnail"] == thumbnail
    assert preset["config"] == config

    listed = client.get("/api/camera/exposure-presets")
    assert listed.status_code == 200
    assert listed.json()["presets"] == [preset]

    deleted = client.delete("/api/camera/exposure-presets/{}".format(preset["id"]))
    assert deleted.json() == {"deleted": True, "id": preset["id"]}
    assert client.get("/api/camera/exposure-presets").json() == {"presets": []}


def test_given_invalid_exposure_thumbnail_when_preset_saved_then_rejected(client: TestClient):
    response = client.post("/api/camera/exposure-presets", json={
        "name": "Door", "thumbnail": "data:text/html;base64,PHNjcmlwdD4=", "config": {
            "enabled": False, "x": 0.25, "y": 0.25, "width": 0.5, "height": 0.5,
            "compensation": 0, "locked": False,
        },
    })
    assert response.status_code == 422


def test_given_anon_when_fetching_system_logs_then_401(client_anon: TestClient):
    r = client_anon.get("/api/system/logs", params={"unit": "mediamtx"})
    assert r.status_code == 401


def test_given_bad_log_unit_when_fetching_system_logs_then_422(client: TestClient):
    r = client.get("/api/system/logs", params={"unit": "mediamtx;reboot"})
    assert r.status_code == 422


def test_given_owner_logs_request_when_enqueued_then_args_bounded_and_audited(
    client: TestClient,
):
    from app.config import settings
    from app.services import audit_db, host_bridge

    r = client.get(
        "/api/system/logs",
        params={
            "unit": "homecam-detect",
            "since": "30 minutes ago",
            "lines": 5000,
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["request_id"]
    assert body["status"] == "pending"

    rec = host_bridge.get(body["request_id"])
    assert rec["kind"] == "logs"
    assert rec["args"] == {
        "unit": "homecam-detect",
        "since": "30 minutes ago",
        "lines": 1000,
    }
    rows = audit_db.host_action_events_between(
        settings.audit_db_path, since=0, until=9999999999
    )
    assert rows[0]["action"] == "logs"
    assert rows[0]["phase"] == "requested"
    assert rows[0]["request_id"] == body["request_id"]
    assert rows[0]["detail"] == "unit=homecam-detect"
    assert "secret" not in json.dumps(rows[0]).lower()


def test_given_logs_result_when_worker_returns_lines_then_route_returns_scrubbed_payload(
    client: TestClient,
):
    from app.services import host_bridge

    r = client.get("/api/system/logs", params={"unit": "mediamtx", "lines": 10})
    assert r.status_code == 200, r.text
    request_id = r.json()["request_id"]
    assert host_bridge.claim(request_id, now=101.0) == "claimed"
    assert host_bridge.record_result(
        request_id,
        "done",
        "logs fetched",
        {"lines": ["normal line", "password=***"]},
        now=102.0,
    )

    result = client.get(
        "/api/system/logs/result", params={"request_id": request_id}
    )
    assert result.status_code == 200, result.text
    body = result.json()
    assert body["request_id"] == request_id
    assert body["unit"] == "mediamtx"
    assert body["status"] == "done"
    assert body["lines"] == ["normal line", "password=***"]
    assert body["detail"] == "logs fetched"


def _write_backup_route_state():
    from app.auth import jwt_secret
    from app.config import settings
    from app.scripts import gen_vapid
    from app.services.detection_config import DetectionConfigStore

    jwt_secret.load_or_generate(settings.jwt_secret_path)
    gen_vapid.main()
    settings.push_subs_path.write_text("[]", encoding="utf-8")
    DetectionConfigStore(path=settings.detection_config_path).get()


def _assert_backup_ledger_metadata(metadata: dict):
    assert metadata["archive_digest"]
    assert metadata["included_paths"]
    assert metadata["compatibility_decision"]
    assert isinstance(metadata["changed_files_count"], int)
    assert metadata["restart_health_result"]
    assert metadata["rollback_status"]
    summary = metadata["source_file_manifest_summary"]
    assert summary["file_count"] >= 4
    assert summary["included_count"] >= 4


def test_system_backup_wires_real_chain_and_records_parity_ledger(
    client: TestClient,
):
    from app.config import settings
    from app.services.backup_ledger import read_attempts

    _write_backup_route_state()

    r = client.post("/api/system/backup")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert "note" not in body
    assert body["filename"].startswith("homecam-backup-")
    assert body["filename"].endswith(".tar.gz")
    assert body["size"] > 0
    assert len(body["manifest_id"]) == 64
    assert len(body["archive_digest"]) == 64
    assert body["ledger_id"].startswith("route-")
    assert (settings.backup_target_dir / body["filename"]).is_file()
    assert (settings.backup_target_dir / f"{body['filename']}.manifest.json").is_file()

    rows = read_attempts(settings.backup_ledger_path)
    assert len(rows) == 1
    assert rows[0]["attempt_id"] == body["ledger_id"]
    assert rows[0]["operation"] == "backup"
    assert rows[0]["ok"] is True
    _assert_backup_ledger_metadata(rows[0]["metadata"])


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


def test_system_restore_wires_real_chain_and_records_parity_ledger(
    client: TestClient, tmp_path, monkeypatch
):
    from app.config import settings
    from app.services.backup_ledger import read_attempts

    _write_backup_route_state()
    backup_response = client.post("/api/system/backup")
    assert backup_response.status_code == 200
    filename = backup_response.json()["filename"]

    r = client.post(
        "/api/system/restore",
        json={"backup_path": filename},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert body["restored"] is True
    assert body["filename"] == filename
    assert body["changed_file_count"] >= 4
    assert body["restart_required"] is False
    assert body["ledger_id"].startswith("route-")

    rows = read_attempts(settings.backup_ledger_path)
    assert [row["operation"] for row in rows] == ["backup", "restore"]
    assert rows[-1]["attempt_id"] == body["ledger_id"]
    assert rows[-1]["ok"] is True
    metadata = rows[-1]["metadata"]
    _assert_backup_ledger_metadata(metadata)
    assert metadata["compatibility_decision"] == "compatible"
    assert metadata["changed_files_count"] == body["changed_file_count"]


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


def test_given_double_dot_path_when_restore_then_rejects_and_warns(
    client: TestClient, tmp_path, monkeypatch, caplog
):
    """Given an owner-authed restore with a '..' traversal in the path,
    When the route runs, Then it 400s AND emits a security WARNING
    (the rejected fragment must be greppable in journald)."""
    import logging

    # arrange
    _patch_backup_target(tmp_path, monkeypatch)
    caplog.set_level(logging.WARNING, logger="app.routes.control")

    # act
    r = client.post(
        "/api/system/restore",
        json={"backup_path": "../etc/passwd"},
    )

    # assert
    assert r.status_code == 400
    warnings = [
        rec for rec in caplog.records
        if rec.levelno == logging.WARNING and "restore rejected" in rec.getMessage()
    ]
    assert warnings, "expected a 'restore rejected' WARNING"
    assert "etc/passwd" in warnings[0].getMessage()


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


def _patch_build_async(monkeypatch, *, ok, clip_count, error=None):
    """Replace timelapse.build_async with a PURE-async fake (no thread, no
    ffmpeg) so the route's background build completes deterministically in
    the event loop. The route maps the result → status; build()'s own logic
    is covered by test_timelapse_build_real_ffmpeg.py."""
    from pathlib import Path as _P
    from app.services import timelapse as _tl
    from app.services.timelapse import TimelapseResult

    async def _fake(date):
        return TimelapseResult(
            output_path=_P("/tmp/{0}.mp4".format(date)),
            clip_count=clip_count,
            ok=ok,
            error=error,
        )

    monkeypatch.setattr(_tl, "build_async", _fake)


def _poll_status(client: TestClient, date, tries=60):
    """Drive the loop via repeated status GETs until the background build
    settles (building=False). No fixed sleep — each GET advances the loop."""
    st = None
    for _ in range(tries):
        st = client.get(f"/api/system/timelapse/status?date={date}").json()
        if not st["building"]:
            return st
    return st


def test_when_no_clips_for_day_then_status_reports_no_events_error(
    client: TestClient, tmp_path, monkeypatch
):
    """Async build: POST returns building:true immediately; the 'no clips
    that day' outcome surfaces via the status endpoint, not the POST body."""
    # arrange
    _patch_timelapses(tmp_path, monkeypatch)
    _patch_build_async(monkeypatch, ok=False, clip_count=0)

    # act — kick off the background build
    r = client.post("/api/system/timelapse", json={"date": "2026-04-30"})

    # assert immediate response
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True and body["building"] is True
    assert body["date"] == "2026-04-30"
    assert body["url"] == "/api/timelapses/2026-04-30.mp4"

    # assert outcome via status poll
    st = _poll_status(client, "2026-04-30")
    assert st["building"] is False and st["ready"] is False
    assert "no recorded events" in (st["error"] or "").lower()


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


# --- timestamp sidecar (de-overlap + overlay feature) ----------------------


def test_given_a_sidecar_when_listing_then_manifest_url_is_exposed(
    client: TestClient, tmp_path, monkeypatch
):
    """The reel list advertises the `<date>.json` timestamp sidecar URL when
    present (so the client can fetch the offset→time map); reels built before
    the feature have no sidecar and report manifest_url=None."""
    target = _patch_timelapses(tmp_path, monkeypatch)
    (target / "2026-05-02.mp4").write_bytes(b"\x00" * 10)
    (target / "2026-05-02.json").write_text('{"v":1,"date":"2026-05-02","segments":[]}')
    (target / "2026-05-03.mp4").write_bytes(b"\x00" * 10)  # no sidecar
    r = client.get("/api/system/timelapses")
    assert r.status_code == 200
    by_date = {it["date"]: it for it in r.json()["items"]}
    assert by_date["2026-05-02"]["manifest_url"] == "/api/timelapses/2026-05-02.json"
    assert by_date["2026-05-03"]["manifest_url"] is None


def test_given_a_sidecar_when_fetched_then_served_as_json(
    client: TestClient, tmp_path, monkeypatch
):
    """The auth-gated timelapse file route serves the `<date>.json` sidecar
    (not only the mp4) so the overlay can load the offset→time map."""
    target = _patch_timelapses(tmp_path, monkeypatch)
    payload = '{"v":1,"date":"2026-05-02","segments":[{"offset_s":0,"capture_ts":1.5}]}'
    (target / "2026-05-02.json").write_text(payload)
    r = client.get("/api/timelapses/2026-05-02.json")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("application/json")
    assert r.json()["segments"][0]["capture_ts"] == 1.5


def test_given_missing_sidecar_when_fetched_then_404(
    client: TestClient, tmp_path, monkeypatch
):
    """A reel with no sidecar (older build) yields a benign 404 — the client
    degrades to no overlay."""
    _patch_timelapses(tmp_path, monkeypatch)
    r = client.get("/api/timelapses/2026-05-02.json")
    assert r.status_code == 404


def _patch_ota_paths(tmp_path, monkeypatch):
    from app.config import settings

    ota_root = tmp_path / "dist-ota"
    artifacts = ota_root / "artifacts"
    artifacts.mkdir(parents=True)
    staging = ota_root / "staging"
    active_pointer = ota_root / "active-version"
    active_pointer.write_text("1.2.3\n", encoding="utf-8")
    client_dist_target = tmp_path / "client_dist"
    client_dist_target.mkdir()
    (client_dist_target / "index.html").write_text("old client\n", encoding="utf-8")
    monkeypatch.setattr(settings, "version", "1.2.3")
    monkeypatch.setattr(settings, "ota_root", ota_root)
    monkeypatch.setattr(
        settings, "ota_manifest_path", ota_root / "update-manifest.json"
    )
    monkeypatch.setattr(settings, "ota_artifacts_dir", artifacts)
    monkeypatch.setattr(settings, "ota_staging_root", staging)
    monkeypatch.setattr(settings, "ota_active_pointer", active_pointer)
    monkeypatch.setattr(settings, "ota_ledger_path", ota_root / "ota-ledger.jsonl")
    monkeypatch.setattr(settings, "ota_client_dist_target", client_dist_target)
    monkeypatch.setattr(
        settings,
        "ota_restart_command",
        ("docker", "restart", "homecam-server"),
    )
    return ota_root


def _write_ota_artifact_bundle(ota_root):
    source = ota_root / "source"
    source.mkdir()
    (source / "client" / "dist").mkdir(parents=True)
    (source / "client" / "dist" / "index.html").write_text("new client\n", encoding="utf-8")
    (source / "detection").mkdir()
    (source / "detection" / "detect.py").write_text("print('detect')\n", encoding="utf-8")
    artifact = ota_root / "artifacts" / "homecam-1.2.4.tar"
    with tarfile.open(artifact, "w") as archive:
        for child in sorted(source.rglob("*")):
            archive.add(child, arcname=child.relative_to(source))
    digest = hashlib.sha256(artifact.read_bytes()).hexdigest()
    manifest = ota_root / "update-manifest.json"
    manifest.write_text(
        json.dumps(
            {
                "version": "1.2.4",
                "artifact": {"name": artifact.name, "sha256": digest},
            }
        ),
        encoding="utf-8",
    )
    return digest, hashlib.sha256(manifest.read_bytes()).hexdigest()


def test_system_update_returns_unavailable_scaffold_note_only_without_manifest(
    tmp_path, monkeypatch
):
    from app.services.ota_ledger import read_events
    from app.routes.control import system_update

    ota_root = _patch_ota_paths(tmp_path, monkeypatch)
    body = asyncio.run(system_update(None))
    assert body["status"] == "rejected"
    assert body["applied"] is False
    assert body["reason"] == "missing"
    assert body["restart_required"] is False
    assert "manifest" in body["note"].lower()
    rows = read_events(ota_root / "ota-ledger.jsonl")
    assert [row["status"] for row in rows] == ["requested", "rejected"]


def test_system_update_wires_real_orchestrator_and_records_parity_ledger(
    tmp_path, monkeypatch
):
    from app.config import settings
    from app.routes.control import SystemUpdateRequest, system_update
    from app.services.ota_ledger import read_events

    ota_root = _patch_ota_paths(tmp_path, monkeypatch)
    artifact_digest, manifest_id = _write_ota_artifact_bundle(ota_root)

    body = asyncio.run(system_update(SystemUpdateRequest(version="1.2.4")))
    assert body["status"] == "applied"
    assert body["applied"] is True
    assert body["version"] == "1.2.4"
    assert body["ledger_id"].startswith("route-")
    assert body["restart_required"] is True
    assert body["applied_components"] == ["client"]
    assert body["host_commands"][-1] == "docker restart homecam-server"
    assert "note" not in body
    assert settings.ota_active_pointer.read_text(encoding="utf-8") == "1.2.4\n"
    assert settings.ota_client_dist_target.joinpath("index.html").read_text(
        encoding="utf-8"
    ) == "new client\n"

    rows = read_events(settings.ota_ledger_path)
    assert [row["status"] for row in rows] == ["requested", "started", "applied"]
    for row in rows:
        metadata = row["metadata"]
        assert metadata["current_version"] == "1.2.3"
        assert metadata["target_version"] == "1.2.4"
        assert metadata["manifest_id"] == manifest_id
        assert metadata["artifact_digest"] == artifact_digest
        assert metadata["strategy"] == "rsync-artifact"
    assert rows[-1]["metadata"]["health_result"] == "restart_deferred"
    assert rows[-1]["metadata"]["applied_components"] == ["client"]
    assert rows[-1]["metadata"]["host_commands"] == body["host_commands"]


def test_system_update_returns_typed_disabled_result_when_kill_switch_is_set(
    tmp_path, monkeypatch
):
    from app.config import settings
    from app.routes.control import SystemUpdateRequest, system_update
    from app.services.ota_ledger import read_events

    ota_root = _patch_ota_paths(tmp_path, monkeypatch)
    _write_ota_artifact_bundle(ota_root)
    monkeypatch.setenv("HOMECAM_OTA_DISABLED", "1")

    body = asyncio.run(system_update(SystemUpdateRequest(version="1.2.4")))

    assert body["status"] == "rejected"
    assert body["applied"] is False
    assert body["reason"] == "kill_switch_disabled"
    assert body["phase"] == "manifest_gate"
    assert body["restart_required"] is False
    assert settings.ota_active_pointer.read_text(encoding="utf-8") == "1.2.3\n"
    assert settings.ota_client_dist_target.joinpath("index.html").read_text(
        encoding="utf-8"
    ) == "old client\n"

    rows = read_events(settings.ota_ledger_path)
    assert [row["status"] for row in rows] == ["requested", "rejected"]


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

def test_when_ffmpeg_fails_then_status_reports_error(
    client: TestClient, tmp_path, monkeypatch
):
    """Build failure (e.g. ffmpeg missing) surfaces via the status
    endpoint as ready:false + a human error — the POST still returns
    building:true immediately."""
    # arrange
    _patch_timelapses(tmp_path, monkeypatch)
    _patch_build_async(
        monkeypatch, ok=False, clip_count=5, error="ffmpeg not in container"
    )

    # act
    r = client.post("/api/system/timelapse", json={"date": "2026-04-30"})

    # assert immediate
    assert r.json()["building"] is True

    # assert outcome
    st = _poll_status(client, "2026-04-30")
    assert st["building"] is False and st["ready"] is False
    assert "ffmpeg" in (st["error"] or "").lower()
    assert st["url"] is None  # no playable video to point at


def test_when_build_succeeds_then_status_reports_ready_with_url(
    client: TestClient, tmp_path, monkeypatch
):
    """Success path: status flips to ready:true with the playable URL."""
    # arrange
    _patch_timelapses(tmp_path, monkeypatch)
    _patch_build_async(monkeypatch, ok=True, clip_count=3)

    # act
    r = client.post("/api/system/timelapse", json={"date": "2026-04-30"})

    # assert immediate
    body = r.json()
    assert body["ok"] is True and body["building"] is True
    assert body["url"] == "/api/timelapses/2026-04-30.mp4"

    # assert outcome
    st = _poll_status(client, "2026-04-30")
    assert st["building"] is False and st["ready"] is True
    assert st["error"] is None
    assert st["url"] == "/api/timelapses/2026-04-30.mp4"


# --- requester push-notification on build done/failed ---------------------


def _spy_send_to_user(monkeypatch):
    """Replace push_service.send_to_user with an async spy recording calls."""
    from app.services.push_service import push_service
    calls = []

    async def _spy(user_id, payload):
        calls.append((user_id, payload))
        return 1

    monkeypatch.setattr(push_service, "send_to_user", _spy)
    return calls


def test_given_successful_build_when_done_then_requester_is_push_notified(
    client: TestClient, tmp_path, monkeypatch
):
    """The user who triggered the build gets a Web Push when it's ready — so
    they hear about it even with the app closed (the in-app poll only runs
    while the Settings tab is open). The default `client` is authed testuser."""
    # arrange
    _patch_timelapses(tmp_path, monkeypatch)
    _patch_build_async(monkeypatch, ok=True, clip_count=3)
    calls = _spy_send_to_user(monkeypatch)

    # act
    client.post("/api/system/timelapse", json={"date": "2026-04-30"})
    st = _poll_status(client, "2026-04-30")

    # assert — ready, and the REQUESTER (testuser) was notified with a
    # success payload pointing at /settings.
    assert st["ready"] is True
    assert len(calls) == 1
    user_id, payload = calls[0]
    assert user_id == "testuser"
    assert "ready" in payload["title"].lower()
    assert "2026-04-30" in payload["body"]
    assert payload["url"] == "/settings"
    assert payload["tag"] == "timelapse:2026-04-30"


def test_given_failed_build_when_done_then_requester_is_push_notified(
    client: TestClient, tmp_path, monkeypatch
):
    """A FAILED build notifies the requester too (not just success)."""
    # arrange
    _patch_timelapses(tmp_path, monkeypatch)
    _patch_build_async(monkeypatch, ok=False, clip_count=5, error="ffmpeg boom")
    calls = _spy_send_to_user(monkeypatch)

    # act
    client.post("/api/system/timelapse", json={"date": "2026-04-30"})
    st = _poll_status(client, "2026-04-30")

    # assert
    assert st["ready"] is False
    assert len(calls) == 1
    user_id, payload = calls[0]
    assert user_id == "testuser"
    assert "fail" in payload["title"].lower()
    assert payload["url"] == "/settings"


def test_given_push_send_raises_when_build_done_then_status_still_settles(
    client: TestClient, tmp_path, monkeypatch
):
    """A push failure (backend down) must NEVER break the build outcome the
    client polls — the notification is strictly best-effort."""
    # arrange
    _patch_timelapses(tmp_path, monkeypatch)
    _patch_build_async(monkeypatch, ok=True, clip_count=3)
    from app.services.push_service import push_service

    async def _boom(user_id, payload):
        raise RuntimeError("push backend down")

    monkeypatch.setattr(push_service, "send_to_user", _boom)

    # act
    client.post("/api/system/timelapse", json={"date": "2026-04-30"})
    st = _poll_status(client, "2026-04-30")

    # assert — still ready despite the push blowing up.
    assert st["ready"] is True


def test_when_build_already_running_then_second_post_dedupes(
    client: TestClient, tmp_path, monkeypatch
):
    """A second POST while a build is in flight must NOT spawn a second
    concurrent ffmpeg (they'd race on the same .tmp) — it reports
    'already building'."""
    # arrange — seed an in-flight build for the day.
    from app.routes import control as _control

    _patch_timelapses(tmp_path, monkeypatch)
    _control._TIMELAPSE_STATUS["2026-04-30"] = {
        "building": True, "ready": False, "error": None,
    }

    # act
    r = client.post("/api/system/timelapse", json={"date": "2026-04-30"})

    # assert
    body = r.json()
    assert body["ok"] is True and body["building"] is True
    assert "already building" in body["note"].lower()

    # cleanup the module-global so it doesn't leak to other tests.
    _control._TIMELAPSE_STATUS.pop("2026-04-30", None)


def test_status_falls_back_to_file_existence_when_no_memory_record(
    client: TestClient, tmp_path, monkeypatch
):
    """After a server restart there's no in-memory status; the endpoint
    falls back to whether the <date>.mp4 exists on disk."""
    # arrange — a finished timelapse on disk, no in-memory record.
    from app.routes import control as _control

    target = _patch_timelapses(tmp_path, monkeypatch)
    _control._TIMELAPSE_STATUS.pop("2026-04-30", None)
    (target / "2026-04-30.mp4").write_bytes(b"a-finished-video")

    # act
    st = client.get("/api/system/timelapse/status?date=2026-04-30").json()

    # assert
    assert st["building"] is False and st["ready"] is True
    assert st["url"] == "/api/timelapses/2026-04-30.mp4"


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

    # arrange — also drop a sibling timestamp sidecar.
    (settings.timelapses_dir / "2026-04-30.json").write_text(
        '{"v":1,"date":"2026-04-30","segments":[]}'
    )

    # act
    r = client.delete("/api/system/timelapse?date=2026-04-30")

    # assert — both the reel AND its sidecar are removed (a stale sidecar
    # would otherwise survive a rebuild with the wrong offset→time map).
    assert r.status_code == 200
    assert r.json() == {"deleted": True, "date": "2026-04-30"}
    assert not (settings.timelapses_dir / "2026-04-30.mp4").exists()
    assert not (settings.timelapses_dir / "2026-04-30.json").exists()


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
