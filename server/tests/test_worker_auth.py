"""PR-102 direct-peer credential contract for host worker routes."""
from __future__ import annotations

import logging

import httpx
import pytest


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("GET", "/api/_internal/detection/config"),
        ("POST", "/api/_internal/heartbeat"),
        ("POST", "/api/_internal/live_detection"),
        ("POST", "/api/_internal/event"),
        ("POST", "/api/_internal/event/finalized"),
        ("POST", "/api/_internal/signal"),
        ("GET", "/api/_internal/host_action"),
        ("POST", "/api/_internal/host_action/claim"),
        ("POST", "/api/_internal/host_action/result"),
    ],
)
def test_every_worker_route_rejects_missing_credential(client_anon, method, path):
    response = client_anon.request(method, path, content=b"{}")
    assert response.status_code == 401
    assert response.content == b""


def test_correct_credential_reaches_worker_route(client):
    response = client.get("/api/_internal/detection/config")
    assert response.status_code == 200


@pytest.mark.parametrize(
    "value",
    [
        "Bearer " + ("0" * 64),
        "Basic " + ("0" * 64),
        "Bearer short",
    ],
)
def test_wrong_or_malformed_credential_is_empty_401(client_anon, value):
    response = client_anon.get(
        "/api/_internal/detection/config",
        headers={"Authorization": value},
    )
    assert response.status_code == 401
    assert response.content == b""


@pytest.mark.anyio
async def test_duplicate_authorization_headers_are_rejected(worker_auth_header):
    from app.main import app

    transport = httpx.ASGITransport(app=app, client=("127.0.0.1", 12345))
    async with httpx.AsyncClient(
        transport=transport, base_url="http://homecam.test"
    ) as client:
        response = await client.get(
            "/api/_internal/detection/config",
            headers=[
                ("Authorization", worker_auth_header),
                ("Authorization", worker_auth_header),
            ],
        )
    assert response.status_code == 401
    assert response.content == b""


def test_query_and_cookie_credentials_are_ignored(client_anon, worker_auth_header):
    token = worker_auth_header.split(" ", 1)[1]
    response = client_anon.get(
        "/api/_internal/detection/config",
        params={"token": token},
        cookies={"worker_auth": token},
    )
    assert response.status_code == 401
    assert response.content == b""


def test_proxy_markers_are_rejected_before_auth(client_anon, worker_auth_header):
    response = client_anon.get(
        "/api/_internal/detection/config",
        headers={
            "Authorization": worker_auth_header,
            "X-Forwarded-For": "127.0.0.1",
        },
    )
    assert response.status_code == 403
    assert response.content == b""


def test_untrusted_peer_is_rejected_before_auth(worker_auth_header, _auth_setup):
    from app.main import app
    from fastapi.testclient import TestClient

    with TestClient(
        app,
        client=("192.0.2.10", 50000),
        headers={"Authorization": worker_auth_header},
    ) as remote:
        response = remote.get("/api/_internal/detection/config")
    assert response.status_code == 403
    assert response.content == b""


def test_missing_server_secret_disables_only_worker_routes(
    client_anon, worker_auth_header
):
    from app.services import worker_auth

    worker_auth.reset_for_tests()
    try:
        response = client_anon.get("/api/_internal/detection/config")
        assert response.status_code == 503
        assert response.content == b""
        assert client_anon.post(
            "/api/client-log", json={"level": "info", "event": "still-up"}
        ).status_code == 200
    finally:
        worker_auth.reset_for_tests(worker_auth_header.split(" ", 1)[1].encode("ascii"))


def test_rejection_logging_is_bounded_and_never_contains_secret(
    client_anon, worker_auth_header, monkeypatch, caplog
):
    from app.log import RateLimitedLog
    from app.services import worker_auth

    times = iter([100.0] + [101.0] * 99)
    monkeypatch.setitem(
        worker_auth._AUTH_LOG_GATES,
        "invalid",
        RateLimitedLog(60.0, clock=lambda: next(times)),
    )
    invalid = "Bearer " + ("f" * 64)
    with caplog.at_level(logging.WARNING, logger="app.services.worker_auth"):
        for _ in range(100):
            assert client_anon.get(
                "/api/_internal/detection/config",
                headers={"Authorization": invalid},
            ).status_code == 401
    messages = [record.getMessage() for record in caplog.records]
    assert len(messages) == 1
    combined = "\n".join(messages)
    assert worker_auth_header not in combined
    assert invalid not in combined
    assert "category=invalid" in combined


def test_secret_loader_rejects_missing_malformed_and_oversized(tmp_path):
    from app.services import worker_auth

    assert not worker_auth.load_secret(tmp_path / "missing")
    malformed = tmp_path / "malformed"
    malformed.write_text("A" * 64, encoding="ascii")
    assert not worker_auth.load_secret(malformed)
    oversized = tmp_path / "oversized"
    oversized.write_text("a" * 65, encoding="ascii")
    assert not worker_auth.load_secret(oversized)


def test_old_internal_client_log_path_is_gone(client_anon):
    response = client_anon.post(
        "/api/_internal/client_log",
        json={"level": "info", "event": "old-path"},
    )
    assert response.status_code == 404


def test_client_log_is_excluded_from_successful_action_audit(client):
    import time

    from app.config import settings
    from app.services import audit_db

    response = client.post(
        "/api/client-log",
        json={"level": "info", "event": "audit-exclusion"},
    )
    assert response.status_code == 200
    assert audit_db.action_events_between(
        settings.audit_db_path,
        since=0,
        until=time.time() + 1,
    ) == []
