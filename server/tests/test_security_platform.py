from __future__ import annotations

import time
import asyncio
import hashlib
import json
import shutil
import subprocess
from types import SimpleNamespace

import pytest


def _box():
    return {"x": 0.1, "y": 0.1, "w": 0.2, "h": 0.3, "label": "person", "score": 0.9}


def _event(client, event_id: str, **extra):
    body = {"id": event_id, "label": "person", "score": 0.9, "boxes": [_box()]}
    body.update(extra)
    response = client.post("/api/_internal/event", json=body)
    assert response.status_code == 200, response.text


def test_security_routes_require_auth(client_anon):
    response = client_anon.get(
        "/api/security/timeline",
        params={"camera_id": "front_door", "since_ts": 1, "until_ts": 2},
    )
    assert response.status_code == 401


def test_smart_rule_config_round_trips_and_rejects_wrong_geometry(client):
    rule = {
        "id": "driveway_line",
        "name": "Driveway line",
        "kind": "line_crossing",
        "enabled": True,
        "camera_id": "front_door",
        "points": [[0.1, 0.2], [0.8, 0.7]],
        "labels": ["person"],
        "direction": "forward",
        "dwell_s": 0,
        "threshold": 0.8,
    }
    response = client.patch(
        "/api/detection/config",
        json={
            "smart_rules": [rule],
            "package_change_threshold": 0.4,
            "package_stable_s": 12,
            "audio_event_enabled": True,
            "audio_event_labels": ["audio_smoke_alarm"],
            "deterrence_enabled": True,
            "deterrence_action": "warning",
            "deterrence_duration_s": 5,
        },
    )
    assert response.status_code == 200, response.text
    assert response.json()["smart_rules"] == [rule]
    bad = client.patch(
        "/api/detection/config",
        json={"smart_rules": [{**rule, "points": rule["points"] + [[0.5, 0.5]]}]},
    )
    assert bad.status_code == 422


def test_timeline_maps_registry_id_to_mediamtx_path_and_reports_gaps(
    client, tmp_path, monkeypatch
):
    from app.config import settings
    from app.services import security_timeline

    root = tmp_path / "continuous"
    archive = root / "cam"
    archive.mkdir(parents=True)
    (archive / "1000.mp4").write_bytes(b"segment")
    monkeypatch.setattr(settings, "continuous_recordings_dir", root)
    monkeypatch.setattr(security_timeline, "_probe_duration", lambda _path: 300.0)

    response = client.get(
        "/api/security/timeline",
        params={"camera_id": "front_door", "since_ts": 900, "until_ts": 1400},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["spans"][0]["url"].endswith("/front_door/1000.mp4")
    assert body["spans"][0]["size_bytes"] == 7
    assert body["gaps"] == [
        {"start_ts": 900.0, "end_ts": 1000.0, "reason": "not_recorded"},
        {"start_ts": 1300.0, "end_ts": 1400.0, "reason": "not_recorded"},
    ]


def test_signal_is_strict_worker_authed_and_retry_deduplicated(client):
    from app.config import settings
    from app.services import events_db
    from app.services.detection_config import detection_config

    detection_config.config.audio_event_enabled = True
    detection_config.config.audio_event_labels = ["audio_smoke_alarm"]
    payload = {
        "id": "audio-1",
        "source": "audio",
        "label": "audio_smoke_alarm",
        "score": 0.98,
        "camera_id": "front_door",
        "observed_at": time.time(),
        "duration_s": 2.5,
        "correlation_id": "audio-correlation-1",
    }
    first = client.post("/api/_internal/signal", json=payload)
    second = client.post("/api/_internal/signal", json=payload)
    assert first.status_code == 200 and first.json()["duplicate"] is False
    assert second.status_code == 200 and second.json()["duplicate"] is True
    rows = events_db.get_by_ids(settings.events_db_path, ["audio-1"])
    assert len(rows) == 1
    assert rows[0]["source"] == "audio"
    assert rows[0]["boxes"] == []
    assert rows[0]["ts"] == payload["observed_at"]
    assert client.post(
        "/api/_internal/signal", json={**payload, "observed_at": "2026-07-10T00:00:00Z"}
    ).status_code == 422


def test_automation_secret_is_write_only_and_test_is_dry_run(client, monkeypatch):
    _event(client, "automation-event")
    body = {
        "name": "Porch webhook",
        "enabled": True,
        "triggers": {"labels": ["person"], "sources": [], "camera_ids": [], "rule_ids": []},
        "conditions": {"operating_modes": [], "person": "any", "min_score": 0.5},
        "actions": [{"kind": "webhook", "url": "https://example.test/hook?token=secret", "secret": "signing-secret"}],
    }
    created = client.post("/api/security/automations", json=body)
    assert created.status_code == 201, created.text
    action = created.json()["actions"][0]
    assert action == {"kind": "webhook", "target": "https://example.test/hook", "secret_set": True}
    assert "signing-secret" not in created.text and "token=secret" not in created.text

    def _must_not_send(*_args, **_kwargs):
        raise AssertionError("dry-run sent a webhook")

    monkeypatch.setattr("app.services.security_automation._webhook_sync", _must_not_send)
    tested = client.post(
        "/api/security/automations/{}/test".format(created.json()["id"]),
        json={"event_id": "automation-event"},
    )
    assert tested.status_code == 200
    assert tested.json()["dry_run"] is True
    assert tested.json()["results"][0]["status"] == "planned"
    toggled = client.patch(
        "/api/security/automations/{}".format(created.json()["id"]),
        json={"enabled": False},
    )
    assert toggled.status_code == 200 and toggled.json()["enabled"] is False
    from app.services.security_store import security_store

    persisted = security_store.read()["automations"][created.json()["id"]]
    assert persisted["actions"][0]["url"].endswith("?token=secret")
    assert persisted["actions"][0]["secret"] == "signing-secret"


def test_visits_group_known_adjacent_but_never_unknown_by_time(client):
    _event(client, "known-1", person_name="Alice")
    _event(client, "known-2", person_name="Alice")
    _event(client, "unknown-1")
    _event(client, "unknown-2")
    response = client.get("/api/security/visits")
    assert response.status_code == 200
    items = response.json()["items"]
    assert sorted(len(item["events"]) for item in items) == [1, 1, 2]
    assert all(set(item) == {"id", "start_ts", "end_ts", "camera_ids", "people", "labels", "events"} for item in items)


def test_given_admin_owns_incident_when_mutating_then_full_lifecycle_succeeds(client):
    # arrange
    _event(client, "incident-event")

    # act
    created = client.post("/api/security/incidents", json={"title": "Porch", "notes": "Review"})

    # assert
    assert created.status_code == 201
    assert created.json()["owner_username"] == "testuser"
    incident_id = created.json()["id"]
    added = client.post(
        "/api/security/incidents/{}/events/incident-event".format(incident_id)
    )
    assert added.status_code == 200
    assert added.json()["event_count"] == 1
    removed = client.delete(
        "/api/security/incidents/{}/events/incident-event".format(incident_id)
    )
    assert removed.status_code == 200
    deleted = client.delete("/api/security/incidents/{}".format(incident_id))
    assert deleted.json() == {"deleted": True}


@pytest.mark.parametrize("legacy", [False, True], ids=["Israel-owned", "legacy"])
def test_given_israel_or_legacy_incident_when_admin_mutates_then_every_write_is_forbidden(
    client, legacy
):
    # arrange
    from app.config import settings
    from app.services.security_store import security_store

    _event(client, "protected-event")
    _event(client, "new-event")
    incident_id = "legacy-incident" if legacy else "israel-incident"
    row = {
        "id": incident_id,
        "title": "Israel evidence",
        "notes": "Do not let another admin alter this.",
        "status": "open",
        "event_ids": ["protected-event"],
        "created_ts": 100.0,
        "updated_ts": 100.0,
        "audit": [],
    }
    if not legacy:
        row["owner_username"] = "Israel"
    security_store.transact(
        lambda state: state["incidents"].__setitem__(incident_id, row)
    )
    detail = client.get("/api/security/incidents/{}".format(incident_id))
    assert detail.status_code == 200
    assert detail.json()["owner_username"] == "Israel"

    # act
    responses = [
        client.patch(
            "/api/security/incidents/{}".format(incident_id),
            json={"notes": "unauthorized"},
        ),
        client.post(
            "/api/security/incidents/{}/events/new-event".format(incident_id)
        ),
        client.delete(
            "/api/security/incidents/{}/events/protected-event".format(incident_id)
        ),
        client.post("/api/security/incidents/{}/export".format(incident_id)),
        client.delete("/api/security/incidents/{}".format(incident_id)),
    ]

    # assert
    assert [response.status_code for response in responses] == [403] * 5
    persisted = security_store.read()["incidents"][incident_id]
    assert persisted["owner_username"] == "Israel"
    assert persisted["notes"] == "Do not let another admin alter this."
    assert persisted["event_ids"] == ["protected-event"]
    assert persisted["audit"] == []
    assert not list(settings.security_exports_dir.glob("incident-*.zip"))
    on_disk = json.loads(settings.security_state_path.read_text(encoding="utf-8"))
    assert on_disk["incidents"][incident_id]["owner_username"] == "Israel"


def test_identity_alias_rejects_unsafe_name_and_face_pref_suppresses(client):
    _event(client, "identity-event")
    unsafe = client.post(
        "/api/events/identity-event/identity-feedback",
        json={"verdict": "incorrect", "correct_name": "../../escape"},
    )
    assert unsafe.status_code == 422
    assigned = client.post(
        "/api/events/identity-event/identity-feedback",
        json={"verdict": "incorrect", "correct_name": "Alice"},
    )
    assert assigned.status_code == 200
    assert assigned.json()["event"]["person_name"] == "Alice"
    preference = client.put(
        "/api/face/preferences/Alice", json={"alerts_enabled": False}
    )
    assert preference.status_code == 200
    assert preference.json()["alerts_enabled"] is False
    assert client.get("/api/face/preferences").json()["items"][0]["name"] == "Alice"


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg unavailable")
def test_timeline_export_real_ffmpeg_trims_each_side_of_gap_and_expires(
    client, tmp_path, monkeypatch
):
    from app.config import settings
    from app.services import security_timeline

    root = tmp_path / "continuous"
    archive = root / "cam"
    archive.mkdir(parents=True)
    base = int(time.time()) - 30
    for start, color in ((base, "red"), (base + 10, "blue")):
        subprocess.run(
            [
                "ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "lavfi",
                "-i", "color=c={}:s=160x90:r=10".format(color), "-t", "5",
                "-c:v", "mpeg4", "-g", "1", "-y", str(archive / "{}.mp4".format(start)),
            ],
            check=True,
        )
    monkeypatch.setattr(settings, "continuous_recordings_dir", root)
    monkeypatch.setattr(settings, "security_exports_dir", tmp_path / "exports")
    monkeypatch.setattr(settings, "security_export_min_free_bytes", 0)
    monkeypatch.setattr(settings, "security_export_max_total_bytes", 1024**3)
    job = security_timeline.create_export_job("front_door", base + 2, base + 12)
    security_timeline.run_export_job(job["id"])
    settled = security_timeline.get_export_job(job["id"])
    assert settled is not None and settled["status"] == "ready", settled
    assert settled["coverage"] == pytest.approx({"recorded_s": 5.0, "gap_s": 5.0}, abs=0.2)
    output = security_timeline.get_export_path(job["id"])
    assert output is not None
    digest = hashlib.sha256(output.read_bytes()).hexdigest()
    assert settled["sha256"] == digest
    assert 2.0 <= security_timeline._probe_duration(output) <= 8.0
    assert security_timeline.prune_export_jobs(
        now=settled["updated_ts"] + 86401
    ) == 1
    assert not output.exists()


def test_deterrence_unavailable_confirm_and_busy_are_audited(
    client, monkeypatch
):
    from app.config import settings
    from app.services.detection_config import detection_config
    from app.services import security_deterrence
    from app.services.security_store import security_store

    detection_config.config.deterrence_enabled = True
    monkeypatch.setattr(settings, "deterrence_driver_path", None)
    unavailable = client.post(
        "/api/security/deterrence",
        json={"action": "siren", "duration_s": 2, "confirm": True},
    )
    assert unavailable.status_code == 200
    assert unavailable.json()["status"] == "unavailable"
    security_deterrence._ACTION_LOCK.acquire()
    try:
        busy = client.post(
            "/api/security/deterrence",
            json={"action": "siren", "duration_s": 2, "confirm": True},
        )
    finally:
        security_deterrence._ACTION_LOCK.release()
    assert busy.json()["status"] == "blocked"
    audit = security_store.read()["deterrence"]["audit"]
    assert [row["status"] for row in audit[-2:]] == ["unavailable", "blocked"]


def test_owner_can_discover_deterrence_capability_without_running_action(
    client, monkeypatch
):
    from app.config import settings
    from app.services.detection_config import detection_config

    monkeypatch.setattr(settings, "deterrence_driver_path", None)
    detection_config.config.deterrence_enabled = False
    response = client.get("/api/security/deterrence/capabilities")
    assert response.status_code == 200
    assert response.json() == {
        "v": 1,
        "available": False,
        "adapter": None,
        "limitation": (
            "The server container has no host GPIO or audio access by default; "
            "a mounted, device-mapped adapter is required for hardware activation."
        ),
        "armed": False,
        "privacy_blocked": False,
        "supported_actions": ["light", "warning", "siren"],
    }


def test_family_cannot_discover_physical_deterrence_capability(client):
    from app.auth import users_db
    from app.config import settings

    assert users_db.update_role(settings.users_db_path, "testuser", "family")
    response = client.get("/api/security/deterrence/capabilities")
    assert response.status_code == 403


def test_outage_interval_contract_closes_on_recovery(tmp_path, monkeypatch):
    from app.config import settings
    from app.services import security_resilience
    from app.services.security_store import security_store

    monkeypatch.setattr(settings, "security_state_path", tmp_path / "security.json")
    security_store.reset_for_tests()
    monkeypatch.setattr(
        security_resilience,
        "_samples",
        lambda _now: [{"component": "camera_frames", "state": "unavailable", "reason": "stale"}],
    )
    security_resilience.record_transitions(1000.0)
    monkeypatch.setattr(
        security_resilience,
        "_samples",
        lambda _now: [{"component": "camera_frames", "state": "healthy", "reason": None}],
    )
    security_resilience.record_transitions(1010.0)
    body = security_resilience.public_outages()
    row = body["items"][0]
    assert set(row) >= {"id", "kind", "start_ts", "end_ts", "reason", "recovered"}
    assert row["end_ts"] == 1010.0 and row["recovered"] is True
    assert body["capabilities"]["self_outage_detection"] is False


@pytest.mark.asyncio
async def test_package_mapping_and_overdue_reminder_is_one_shot(
    client, monkeypatch
):
    from app.services import security_automation, security_resilience
    from app.services.push_service import push_service
    from app.services.security_store import security_store

    now = time.time()
    _event(
        client,
        "package-event",
        label="package_delivered",
        correlation_id="pkg-1",
        package_state="delivered",
        thumb_url="/snapshots/thumb_1.jpg",
    )
    security_automation.note_package_event({
        "id": "package-event", "ts": now - 4 * 3600, "camera_id": "front_door",
        "correlation_id": "pkg-1", "package_state": "delivered",
    })
    security_store.transact(
        lambda state: state["packages"]["pkg-1"].update(
            {"delivered_at": now - 4 * 3600, "overdue_notified": False}
        )
    )
    sent = []

    async def _send(payload):
        sent.append(payload)
        return 1

    monkeypatch.setattr(push_service, "send_all", _send)
    assert await security_resilience.check_package_reminders(now) == 1
    assert await security_resilience.check_package_reminders(now + 60) == 0
    body = client.get("/api/security/packages/current").json()["items"][0]
    assert set(body) >= {
        "correlation_id", "state", "camera_id", "first_seen_ts",
        "updated_ts", "event_id", "thumb_url",
    }
    assert len(sent) == 1


def test_search_status_object_and_normalized_score(client):
    _event(client, "search-event", person_name="Alice")
    body = client.get("/api/security/search", params={"q": "Alice", "limit": 10}).json()
    assert body["index_status"] == {
        "mode": "local_metadata", "status": "ready", "indexed_events": 1,
    }
    assert 0.0 <= body["items"][0]["score"] <= 1.0


def test_face_merge_moves_sidecar_and_renames_historical_event(
    client, tmp_path, monkeypatch
):
    from app.config import settings

    faces = tmp_path / "faces"
    people = tmp_path / "people"
    source = faces / "Alice"
    source.mkdir(parents=True)
    (source / "100_merge-event.jpg").write_bytes(b"jpg")
    (source / "100_merge-event.json").write_text('{"event_id":"merge-event"}')
    target = faces / "Alicia"
    target.mkdir()
    (target / "100_merge-event.jpg").write_bytes(b"existing")
    (target / "100_merge-event.json").write_text('{"existing":true}')
    monkeypatch.setattr(settings, "face_captures_dir", faces)
    monkeypatch.setattr(settings, "person_captures_dir", people)
    _event(client, "merge-event", person_name="Alice")
    assert client.put(
        "/api/face/preferences/Alice", json={"alerts_enabled": False}
    ).status_code == 200
    response = client.post(
        "/api/face/merge", json={"source_name": "Alice", "target_name": "Alicia"}
    )
    assert response.status_code == 200, response.text
    jpg_stems = {path.stem for path in target.glob("*.jpg")}
    json_stems = {path.stem for path in target.glob("*.json")}
    assert jpg_stems == json_stems and len(jpg_stems) == 2
    merged_stem = next(stem for stem in jpg_stems if stem != "100_merge-event")
    assert json.loads((target / "{}.json".format(merged_stem)).read_text())[
        "merged_into"
    ] == "Alicia"
    assert client.get("/api/events").json()[0]["person_name"] == "Alicia"
    preferences = client.get("/api/face/preferences").json()["items"]
    assert preferences == [
        {"name": "Alicia", "notification": "smart", "alerts_enabled": False}
    ]
    assert response.json()["retrain_required"] is True


def test_doorbell_and_tamper_signal_strict_labels_and_retry_gate(client):
    now = time.time()
    doorbell = {
        "id": "door-1", "source": "doorbell", "label": "doorbell",
        "score": 1.0, "camera_id": "front_door", "observed_at": now,
        "duration_s": 0.0, "correlation_id": "door-corr",
    }
    assert client.post("/api/_internal/signal", json=doorbell).status_code == 200
    assert client.post("/api/_internal/signal", json=doorbell).json()["duplicate"] is True
    assert client.post(
        "/api/_internal/signal",
        json={**doorbell, "id": "bad-door", "label": "doorbell_press"},
    ).status_code == 422
    tamper = {
        **doorbell,
        "id": "tamper-1",
        "source": "tamper",
        "label": "camera_covered",
        "correlation_id": "tamper-corr",
    }
    assert client.post("/api/_internal/signal", json=tamper).status_code == 200


def test_rich_notification_actions_are_event_aware_and_never_deter(client):
    from app.routes._internal import _notification_actions
    from app.services.detection_config import detection_config

    detection_config.config.audio_enabled = True
    assert _notification_actions({"source": "doorbell", "label": "doorbell"}) == [
        "view", "talk",
    ]
    assert _notification_actions({"label": "package_delivered"}) == [
        "view", "protect",
    ]
    assert _notification_actions({"label": "person"}) == ["view", "mark_seen"]
    assert all(
        "deterrence" not in actions
        for actions in (
            _notification_actions({"source": "doorbell", "label": "doorbell"}),
            _notification_actions({"label": "package_delivered"}),
            _notification_actions({"label": "person"}),
        )
    )


def test_security_state_is_in_optional_backup_inventory(tmp_path):
    from app.services.backup_manifest import build_persisted_state_inventory

    names = {
        "users_db_path": "users.db",
        "events_db_path": "events.db",
        "audit_db_path": "audit.db",
        "vapid_private_key_path": "private.pem",
        "vapid_public_key_path": "public.pem",
        "push_subs_path": "push.json",
        "detection_config_path": "detection.json",
        "security_state_path": "security.json",
    }
    fake = SimpleNamespace(**{key: tmp_path / value for key, value in names.items()})
    inventory = build_persisted_state_inventory(
        settings_obj=fake, allowed_roots=[tmp_path]
    )
    row = next(entry for entry in inventory if entry.role == "security_state")
    assert row.path == (tmp_path / "security.json").resolve()
    assert row.required is False
