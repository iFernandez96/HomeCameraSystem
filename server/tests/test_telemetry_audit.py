from __future__ import annotations

import time

import httpx
import pytest
from fastapi import FastAPI

from app.auth import passwords, users_db
from app.config import settings
from app.services import audit_db


@pytest.fixture
def audit_app(_auth_setup) -> FastAPI:
    from app.routes import auth, telemetry

    audit_db.init_db(settings.audit_db_path)
    audit_db.reset(settings.audit_db_path)
    app = FastAPI()
    app.include_router(auth.router, prefix="/api")
    app.include_router(telemetry.router, prefix="/api")
    return app


def _transport(app: FastAPI) -> httpx.ASGITransport:
    return httpx.ASGITransport(app=app)


def _create_user(username: str, password: str, role: str) -> None:
    users_db.create_user(
        settings.users_db_path,
        username,
        passwords.hash_password(password),
        role=role,
    )


async def _login(client: httpx.AsyncClient, username: str, password: str) -> None:
    r = await client.post(
        "/api/auth/login", json={"username": username, "password": password}
    )
    assert r.status_code == 200, r.text


@pytest.mark.asyncio
async def test_given_real_login_flow_when_success_and_fail_then_auth_events_recorded(
    audit_app: FastAPI,
):
    _create_user("alice", "hunter2", "family")
    ua = "AuditTest/1.0" + ("x" * 300)

    async with httpx.AsyncClient(
        transport=_transport(audit_app), base_url="http://testserver"
    ) as client:
        ok = await client.post(
            "/api/auth/login",
            json={"username": "alice", "password": "hunter2"},
            headers={"user-agent": ua},
        )
        bad = await client.post(
            "/api/auth/login",
            json={"username": "alice", "password": "wrong"},
            headers={"user-agent": ua},
        )

    assert ok.status_code == 200
    assert bad.status_code == 401
    rows = audit_db.auth_events_between(
        settings.audit_db_path,
        since=0,
        until=time.time() + 60,
    )
    actions = [row["action"] for row in rows if row["username"] == "alice"]
    assert "login_ok" in actions
    assert "login_fail" in actions
    assert all(len(row["ua"]) <= 256 for row in rows)


@pytest.mark.asyncio
async def test_given_refresh_and_logout_when_called_then_auth_events_recorded(
    audit_app: FastAPI,
):
    _create_user("alice", "hunter2", "family")
    async with httpx.AsyncClient(
        transport=_transport(audit_app), base_url="http://testserver"
    ) as client:
        await _login(client, "alice", "hunter2")

        refresh = await client.post("/api/auth/refresh", json={})
        logout = await client.post("/api/auth/logout", json={})

    assert refresh.status_code == 200
    assert logout.status_code == 200
    rows = audit_db.auth_events_between(
        settings.audit_db_path,
        since=0,
        until=time.time() + 60,
    )
    assert {"refresh", "logout"}.issubset(
        {row["action"] for row in rows if row["username"] == "alice"}
    )


@pytest.mark.asyncio
async def test_given_view_post_when_valid_then_username_is_server_side(
    audit_app: FastAPI,
):
    _create_user("alice", "hunter2", "family")
    async with httpx.AsyncClient(
        transport=_transport(audit_app), base_url="http://testserver"
    ) as client:
        await _login(client, "alice", "hunter2")

        r = await client.post(
            "/api/telemetry/view",
            json={
                "v": 1,
                "kind": "page",
                "name": "/events",
                "dwell_ms": 1234,
                "ts": 1000.0,
            },
        )

    assert r.status_code == 200, r.text
    assert r.json() == {"ok": True}
    rows = audit_db.view_events_between(
        settings.audit_db_path,
        since=0,
        until=2000,
    )
    assert rows == [
        {
            "ts": 1000.0,
            "username": "alice",
            "kind": "page",
            "name": "/events",
            "dwell_ms": 1234,
        }
    ]


@pytest.mark.asyncio
async def test_given_view_post_when_extra_field_then_422(audit_app: FastAPI):
    async with httpx.AsyncClient(
        transport=_transport(audit_app), base_url="http://testserver"
    ) as client:
        await _login(client, "testuser", "testpass")
        r = await client.post(
            "/api/telemetry/view",
            json={
                "v": 1,
                "kind": "page",
                "name": "/live",
                "dwell_ms": 1,
                "ts": 1.0,
                "username": "mallory",
            },
        )

    assert r.status_code == 422


@pytest.mark.asyncio
async def test_given_view_post_when_bad_kind_then_422(audit_app: FastAPI):
    async with httpx.AsyncClient(
        transport=_transport(audit_app), base_url="http://testserver"
    ) as client:
        await _login(client, "testuser", "testpass")
        r = await client.post(
            "/api/telemetry/view",
            json={
                "v": 1,
                "kind": "screen",
                "name": "/live",
                "dwell_ms": 1,
                "ts": 1.0,
            },
        )

    assert r.status_code == 422


@pytest.mark.asyncio
async def test_given_view_post_when_oversize_name_then_422(audit_app: FastAPI):
    async with httpx.AsyncClient(
        transport=_transport(audit_app), base_url="http://testserver"
    ) as client:
        await _login(client, "testuser", "testpass")
        r = await client.post(
            "/api/telemetry/view",
            json={
                "v": 1,
                "kind": "page",
                "name": "x" * 129,
                "dwell_ms": 1,
                "ts": 1.0,
            },
        )

    assert r.status_code == 422


@pytest.mark.asyncio
async def test_given_admin_audit_when_anon_then_401(audit_app: FastAPI):
    async with httpx.AsyncClient(
        transport=_transport(audit_app), base_url="http://testserver"
    ) as client:
        r = await client.get("/api/admin/audit")

    assert r.status_code == 401


@pytest.mark.asyncio
async def test_given_admin_audit_when_non_admin_owner_then_403(audit_app: FastAPI):
    _create_user("Israel", "ownerpass", "owner")
    async with httpx.AsyncClient(
        transport=_transport(audit_app), base_url="http://testserver"
    ) as client:
        await _login(client, "Israel", "ownerpass")

        r = await client.get("/api/admin/audit")

    assert r.status_code == 403


@pytest.mark.asyncio
async def test_given_admin_audit_when_literal_admin_owner_then_200(audit_app: FastAPI):
    _create_user("admin", "adminpass", "owner")
    async with httpx.AsyncClient(
        transport=_transport(audit_app), base_url="http://testserver"
    ) as client:
        await _login(client, "admin", "adminpass")

        r = await client.get("/api/admin/audit")

    assert r.status_code == 200, r.text
    assert r.json()["v"] == 1


@pytest.mark.asyncio
async def test_given_seeded_rows_when_admin_reads_audit_then_summary_aggregates(
    audit_app: FastAPI,
):
    _create_user("admin", "adminpass", "owner")
    async with httpx.AsyncClient(
        transport=_transport(audit_app), base_url="http://testserver"
    ) as client:
        await _login(client, "admin", "adminpass")
        audit_db.insert_auth_event(
            settings.audit_db_path,
            ts=10.0,
            username="alice",
            action="login_ok",
            ua="ua",
        )
        audit_db.insert_auth_event(
            settings.audit_db_path,
            ts=11.0,
            username="alice",
            action="login_fail",
            ua="ua",
        )
        audit_db.insert_view_event(
            settings.audit_db_path,
            ts=12.0,
            username="alice",
            kind="page",
            name="/live",
            dwell_ms=100,
        )
        audit_db.insert_view_event(
            settings.audit_db_path,
            ts=13.0,
            username="alice",
            kind="page",
            name="/live",
            dwell_ms=50,
        )
        audit_db.insert_view_event(
            settings.audit_db_path,
            ts=14.0,
            username="alice",
            kind="event",
            name="motion:1",
            dwell_ms=7,
        )

        r = await client.get("/api/admin/audit?since=0&until=20")

    assert r.status_code == 200, r.text
    body = r.json()
    assert [row["ts"] for row in body["logins"]] == sorted(
        [row["ts"] for row in body["logins"]],
        reverse=True,
    )
    alice = body["summary"]["by_user"]["alice"]
    assert alice["logins"] == 1
    assert alice["page_dwell_ms"] == 150
    assert alice["event_views"] == 1
    assert alice["top"] == [["/live", 150]]


@pytest.mark.asyncio
async def test_given_audit_write_failure_when_login_then_auth_still_succeeds(
    audit_app: FastAPI,
    monkeypatch,
):
    _create_user("alice", "hunter2", "family")

    def fail(*_args, **_kwargs):
        raise RuntimeError("audit db down")

    monkeypatch.setattr(audit_db, "insert_auth_event", fail)
    async with httpx.AsyncClient(
        transport=_transport(audit_app), base_url="http://testserver"
    ) as client:
        r = await client.post(
            "/api/auth/login",
            json={"username": "alice", "password": "hunter2"},
        )

    assert r.status_code == 200, r.text
    assert r.json() == {"user": {"username": "alice", "role": "family"}}
