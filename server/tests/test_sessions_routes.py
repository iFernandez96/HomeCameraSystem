from __future__ import annotations

from app.auth import passwords, tokens, users_db
from app.auth.dependencies import COOKIE_ACCESS
from app.config import settings
from app.sessions import sessions_db


def _access_jti_from_client(client) -> str:
    token = client.cookies.get(COOKIE_ACCESS)
    claims = tokens.decode(token, kind="access")
    return claims["jti"]


def test_given_owner_when_listing_sessions_then_current_session_is_returned(client):
    # arrange

    # act
    res = client.get("/api/admin/sessions")

    # assert
    assert res.status_code == 200
    body = res.json()
    assert body["v"] == 1
    assert len(body["sessions"]) >= 1
    current = [s for s in body["sessions"] if s["is_current"]]
    assert len(current) == 1
    assert current[0]["username"] == "testuser"
    assert "device_label" in current[0]
    assert "refresh_jti" not in current[0]
    assert "device_ua_raw" not in current[0]


def test_given_family_user_when_listing_sessions_then_403(client_anon):
    # arrange
    users_db.create_user(
        settings.users_db_path,
        "fam",
        passwords.hash_password("fampass"),
        role="family",
    )
    login = client_anon.post(
        "/api/auth/login",
        json={"username": "fam", "password": "fampass"},
    )
    assert login.status_code == 200

    # act
    res = client_anon.get("/api/admin/sessions")

    # assert
    assert res.status_code == 403


def test_given_owner_when_revoking_session_then_row_is_revoked(client):
    # arrange
    jti = _access_jti_from_client(client)

    # act
    res = client.post("/api/admin/sessions/{}/revoke".format(jti))

    # assert
    assert res.status_code == 200
    assert res.json() == {"ok": True}
    row = sessions_db.get_session(settings.sessions_db_path, jti)
    assert row is not None
    assert row["revoked_ts"] is not None


def test_given_unknown_jti_when_revoking_then_404(client):
    # arrange

    # act
    res = client.post("/api/admin/sessions/notfound/revoke")

    # assert
    assert res.status_code == 404
    assert res.json()["detail"] == "no such session"


def test_given_revoked_current_session_when_requesting_protected_route_then_401(client):
    # arrange
    jti = _access_jti_from_client(client)
    revoke = client.post("/api/admin/sessions/{}/revoke".format(jti))
    assert revoke.status_code == 200

    # act
    res = client.get("/api/status")

    # assert
    assert res.status_code == 401
    assert res.json()["detail"] == "session revoked"


def test_given_watching_event_socket_when_listing_then_session_marks_watching_now(client):
    # arrange
    jti = _access_jti_from_client(client)
    from app.services.event_bus import event_bus

    q = event_bus.subscribe(jti=jti, username="testuser")
    try:
        # act
        res = client.get("/api/admin/sessions")
    finally:
        event_bus.unsubscribe(q)

    # assert
    assert res.status_code == 200
    current = [s for s in res.json()["sessions"] if s["jti"] == jti][0]
    assert current["watching_now"] is True
