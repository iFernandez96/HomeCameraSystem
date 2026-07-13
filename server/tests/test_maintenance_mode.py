from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from threading import Event

import pytest
from fastapi.testclient import TestClient

from app.routes import control


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("POST", "/api/events/seen_all"),
        ("PUT", "/api/detection/enabled"),
        ("PATCH", "/api/detection/config"),
        ("DELETE", "/api/events/not-present"),
    ],
)
def test_active_restore_rejects_every_ordinary_mutation_with_typed_503(
    client: TestClient,
    method: str,
    path: str,
):
    with control._BACKUP_RESTORE_LOCK.acquire("restore"):
        response = client.request(method, path, json={})

    assert response.status_code == 503
    assert response.headers["Retry-After"] == "1"
    assert response.json() == {
        "ok": False,
        "status": "maintenance",
        "maintenance": {
            "code": "maintenance_conflict",
            "active_operation": "restore",
            "requested_operation": "{} {}".format(method, path),
            "retryable": True,
        },
    }


def test_status_read_remains_available_and_reports_typed_maintenance_state(
    client: TestClient,
):
    with control._BACKUP_RESTORE_LOCK.acquire("restore"):
        response = client.get("/api/status")

    assert response.status_code == 200
    assert response.json()["maintenance"] == {
        "active": True,
        "operation": "restore",
        "blocks_mutations": True,
    }


def test_concurrent_restore_reaches_lock_and_returns_typed_conflict(
    client: TestClient,
):
    with control._BACKUP_RESTORE_LOCK.acquire("restore"):
        response = client.post(
            "/api/system/restore",
            json={"backup_path": "backup.hcbk"},
        )

    assert response.status_code == 409
    assert response.headers["Retry-After"] == "1"
    body = response.json()
    assert body["status"] == "not_restored"
    assert body["reason"] == "maintenance_conflict"
    assert body["maintenance"] == {
        "code": "maintenance_conflict",
        "active_operation": "restore",
        "requested_operation": "restore",
        "retryable": True,
    }


def test_released_restore_gate_allows_mutations_again(client: TestClient):
    with control._BACKUP_RESTORE_LOCK.acquire("restore"):
        blocked = client.post("/api/events/seen_all")
    allowed = client.post("/api/events/seen_all")

    assert blocked.status_code == 503
    assert allowed.status_code == 200


def test_restore_route_keeps_event_loop_responsive_during_validation(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
):
    entered_validation = Event()
    release_validation = Event()

    def fake_restore(_request, *, maintenance_lock):
        with maintenance_lock.acquire("restore"):
            entered_validation.set()
            assert release_validation.wait(timeout=5)
        return {"ok": True, "restored": True, "status": "restored"}

    monkeypatch.setattr(control, "restore_api_response_from_orchestrator", fake_restore)

    with ThreadPoolExecutor(max_workers=1) as executor:
        future = executor.submit(
            client.post,
            "/api/system/restore",
            json={"backup_path": "backup.hcbk"},
        )
        assert entered_validation.wait(timeout=5)
        try:
            mutation = client.post("/api/events/seen_all")
        finally:
            release_validation.set()
        restore = future.result(timeout=5)

    assert mutation.status_code == 503
    assert mutation.json()["maintenance"]["active_operation"] == "restore"
    assert restore.status_code == 200
    assert restore.json()["status"] == "restored"
