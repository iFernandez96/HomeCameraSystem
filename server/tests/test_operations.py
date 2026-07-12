from __future__ import annotations

import json
from types import SimpleNamespace


def _event(client, event_id: str = "evt_ops"):
    response = client.post(
        "/api/_internal/event",
        json={
            "id": event_id,
            "label": "person",
            "score": 0.91,
            "boxes": [{"x": 0.1, "y": 0.1, "w": 0.2, "h": 0.3, "label": "person", "score": 0.91}],
        },
    )
    assert response.status_code == 200, response.text


def test_profiles_and_schedules_round_trip_without_adding_a_camera_owner(client):
    response = client.put("/api/security/operations/profile", json={"profile": "vacation"})
    assert response.status_code == 200
    assert response.json()["effective_mode"] == "away"

    schedule = {
        "id": "sleep_daily",
        "profile": "sleep",
        "time": "22:30",
        "days": [0, 1, 2, 3, 4, 5, 6],
        "enabled": True,
    }
    saved = client.put("/api/security/operations/mode-schedules", json={"items": [schedule]})
    assert saved.status_code == 200
    state = client.get("/api/security/operations").json()
    assert state["active_profile"] == "vacation"
    assert state["mode_schedules"] == [schedule]


def test_notification_inbox_has_honest_delivery_actions_and_snooze(client):
    from app.services import operations

    _event(client, "evt_notice")
    notification_id, deliverable = operations.prepare_notification(
        {
            "title": "Unknown person",
            "body": "At the front door",
            "event_id": "evt_notice",
            "notification_kind": "unknown-person",
            "url": "/events",
        },
        [{"endpoint": "https://push.example/secret", "user_id": "testuser"}],
        True,
    )
    assert len(deliverable) == 1
    inbox = client.get("/api/security/notifications").json()
    assert inbox["unread"] == 1
    assert inbox["items"][0]["delivery_state"] == "queued"

    assert client.post(f"/api/security/notifications/{notification_id}/seen").status_code == 200
    snooze = client.post(
        f"/api/security/notifications/{notification_id}/snooze",
        json={"duration_s": 3600},
    )
    assert snooze.status_code == 200
    retain = client.put(
        f"/api/security/notifications/{notification_id}/retention",
        json={"retention_class": "permanent"},
    )
    assert retain.status_code == 200
    assert retain.json()["event_id"] == "evt_notice"


def test_notification_success_states_never_regress_across_two_devices(client):
    from app.services import operations

    notification_id, _ = operations.prepare_notification(
        {"title": "Person", "body": "At the door"},
        [
            {"endpoint": "https://push.example/one", "user_id": "testuser"},
            {"endpoint": "https://push.example/two", "user_id": "testuser"},
        ],
        True,
    )
    operations.mark_gateway(notification_id, "testuser", True)
    operations.mark_gateway(notification_id, "testuser", False)
    assert operations.list_notifications("testuser")[0]["delivery_state"] == "gateway_accepted"
    operations.mark_displayed(notification_id, "testuser", True, 100.0)
    operations.mark_displayed(notification_id, "testuser", False, 101.0)
    row = operations.list_notifications("testuser")[0]
    assert row["delivery_state"] == "displayed"
    assert row["displayed_ts"] == 100.0


def test_saved_searches_are_user_owned_and_bounded(client):
    created = client.post(
        "/api/security/saved-searches",
        json={"name": "Unknown at night", "query": "unknown person after 10pm", "semantic": False},
    )
    assert created.status_code == 201
    search_id = created.json()["id"]
    listed = client.get("/api/security/saved-searches").json()["items"]
    assert [(row["name"], row["query"]) for row in listed] == [
        ("Unknown at night", "unknown person after 10pm")
    ]
    assert client.delete(f"/api/security/saved-searches/{search_id}").status_code == 200


def test_retention_preview_separates_ordinary_important_and_permanent(client):
    from app.config import settings
    from app.services import events_db, recording_service

    for event_id, tier in (("evt_regular", "ordinary"), ("evt_keep", "important"), ("evt_forever", "permanent")):
        _event(client, event_id)
        (settings.recordings_dir / f"{event_id}.mp4").write_bytes(b"video" * 100)
        assert events_db.set_retention_class(settings.events_db_path, event_id, tier)
    preview = recording_service.retention_preview(now=1000)
    assert preview["classes"]["important"] == 1
    assert preview["classes"]["permanent"] == 1
    assert {row["event_id"] for row in preview["next_deletions"]} == {"evt_regular", "evt_keep"}


def test_briefing_uses_real_event_and_recording_state(client):
    from datetime import date

    _event(client, "evt_brief")
    response = client.get("/api/security/briefing", params={"day": date.today().isoformat()})
    assert response.status_code == 200
    body = response.json()
    assert body["total"] >= 1
    assert "event" in body["headline"]
    assert body["recording_state"] in {"unknown", "ok", "failed", "stale"}


def test_archive_requires_marker_then_copies_and_verifies_protected_clip(client, tmp_path, monkeypatch):
    from app.config import settings

    _event(client, "evt_archive")
    (settings.recordings_dir / "evt_archive.mp4").write_bytes(b"protected-video")
    assert client.put(
        "/api/security/events/evt_archive/retention",
        json={"retention_class": "permanent"},
    ).status_code == 200
    target = tmp_path / "independent"
    target.mkdir()
    monkeypatch.setattr(settings, "external_archive_dir", target)
    blocked = client.post("/api/security/operations/archive/sync")
    assert blocked.status_code == 409
    (target / ".homecam-external-archive").write_text("HomeCam external archive\n")
    synced = client.post("/api/security/operations/archive/sync")
    assert synced.status_code == 200
    copied = target / "protected-events" / "evt_archive.mp4"
    assert copied.read_bytes() == b"protected-video"
    manifest = json.loads((target / "protected-events" / "manifest.json").read_text())
    assert manifest["files"][0]["event_id"] == "evt_archive"


def test_semantic_companion_is_private_only_and_returns_existing_events(client, monkeypatch):
    from app.services import operations

    _event(client, "evt_semantic")
    public = client.put(
        "/api/security/operations/semantic-companion",
        json={"enabled": True, "base_url": "https://8.8.8.8", "api_token": "secret"},
    )
    assert public.status_code == 422

    configured = client.put(
        "/api/security/operations/semantic-companion",
        json={"enabled": True, "base_url": "http://10.0.0.50:8090", "api_token": "secret"},
    )
    assert configured.status_code == 200
    assert configured.json()["token_set"] is True
    assert "secret" not in configured.text

    class Response:
        status = 200
        def __enter__(self): return self
        def __exit__(self, *_args): return False
        def read(self, _limit): return b'{"event_ids":["evt_semantic","missing"]}'

    monkeypatch.setattr(operations, "_open_companion", lambda *_args, **_kwargs: Response())
    result = client.post("/api/security/semantic/search", json={"query": "red coat", "limit": 10})
    assert result.status_code == 200
    assert [row["id"] for row in result.json()["items"]] == ["evt_semantic"]
