"""Auth routes — login, refresh, logout, me (iter-181, Auth Plan Phase 3).

Routes are LIVE here but the rest of ``/api/*`` is NOT yet gated
(Phase 5 / iter-183 does that). These tests pin:

- LoginIn ``extra='forbid'`` + length bounds.
- Cookies set on login + refresh; cleared on logout.
- Timing-oracle defense: 401 on wrong password and 401 on unknown
  user, both shapes identical (the shared-wall-clock property is
  measured implicitly by ``passwords`` tests; here we pin only
  that the response is the same status + same body shape so a
  client can't differentiate by error string either).
- Token kind enforcement: a refresh token presented as access (or
  vice versa) must 401.
- User row deleted while session live: refresh + me both 401.
"""
from __future__ import annotations

import sqlite3

import pytest

from app.auth import passwords, tokens, users_db
from app.auth.login_throttle import LoginThrottle
from app.config import settings
from app.routes import auth as auth_routes
from app.sessions import sessions_db


@pytest.fixture
def auth_env(tmp_path, monkeypatch):
    """Per-test isolated users.db + jwt_secret. Cookie ``Secure``
    flag flipped off so the TestClient (HTTP) actually sends the
    cookies on subsequent requests within the same session."""
    monkeypatch.setattr(settings, "users_db_path", tmp_path / "users.db")
    monkeypatch.setattr(settings, "jwt_secret_path", tmp_path / "jwt.bin")
    monkeypatch.setattr(settings, "sessions_db_path", tmp_path / "sessions.db")
    monkeypatch.setattr(settings, "cookie_secure", False)
    users_db.init_db(tmp_path / "users.db")
    sessions_db.init_db(tmp_path / "sessions.db")
    auth_routes._login_throttle.clear()
    yield tmp_path
    auth_routes._login_throttle.clear()


@pytest.fixture
def seeded_user(auth_env):
    """Insert one known user (alice / hunter2). Returns the
    plaintext credentials so tests can re-submit them."""
    users_db.create_user(
        auth_env / "users.db",
        "alice",
        passwords.hash_password("hunter2"),
        role="admin",
    )
    return {"username": "alice", "password": "hunter2"}


# --- /api/auth/login ----------------------------------------------------


def test_login_with_valid_creds_returns_user_and_sets_cookies(client, seeded_user):
    res = client.post(
        "/api/auth/login",
        json={"username": "alice", "password": "hunter2"},
    )
    assert res.status_code == 200
    assert res.json() == {"user": {"username": "alice", "role": "admin"}}
    assert "homecam_access" in res.cookies
    assert "homecam_refresh" in res.cookies


def test_given_login_when_successful_then_session_row_is_stored(client, seeded_user):
    # arrange / act
    res = client.post(
        "/api/auth/login",
        json={"username": "alice", "password": "hunter2"},
    )

    # assert
    assert res.status_code == 200
    access_claims = tokens.decode(res.cookies["homecam_access"], kind="access")
    refresh_claims = tokens.decode(res.cookies["homecam_refresh"], kind="refresh")
    row = sessions_db.get_session(settings.sessions_db_path, access_claims["jti"])
    assert row is not None
    assert row["username"] == "alice"
    assert row["refresh_jti"] == refresh_claims["jti"]


def test_login_wrong_password_returns_401_no_cookies(client, seeded_user):
    res = client.post(
        "/api/auth/login",
        json={"username": "alice", "password": "wrong"},
    )
    assert res.status_code == 401
    # Both cookie keys MUST be absent — leaking either to a wrong-
    # password response would defeat the whole gating story.
    assert "homecam_access" not in res.cookies
    assert "homecam_refresh" not in res.cookies


def test_login_unknown_user_returns_401(client, auth_env):
    """Same status + same body shape as wrong-password so a client
    can't differentiate by response. The wall-clock equivalence is
    enforced upstream by ``passwords.verify_password(submitted,
    dummy_hash())`` — pinned in test_auth_passwords.py."""
    res = client.post(
        "/api/auth/login",
        json={"username": "ghost", "password": "anything"},
    )
    assert res.status_code == 401
    assert "homecam_access" not in res.cookies


def test_given_repeated_bad_passwords_when_limit_reached_then_login_is_throttled(
    client, seeded_user, monkeypatch
):
    # arrange — a small deterministic gate keeps the route test fast.
    now = [100.0]
    monkeypatch.setattr(
        auth_routes,
        "_login_throttle",
        LoginThrottle(failure_limit=2, base_block_s=7, clock=lambda: now[0]),
    )
    body = {"username": "alice", "password": "wrong"}

    # act
    first = client.post("/api/auth/login", json=body)
    second = client.post("/api/auth/login", json=body)
    blocked = client.post("/api/auth/login", json=body)

    # assert
    assert first.status_code == 401
    assert second.status_code == 401
    assert blocked.status_code == 429
    assert blocked.headers["retry-after"] == "7"
    assert blocked.json() == {"detail": "too many login attempts; try again shortly"}
    assert "homecam_access" not in blocked.cookies


def test_given_throttled_username_when_different_peer_logs_in_then_attempt_is_independent(
    client, seeded_user, monkeypatch
):
    # arrange
    throttle = LoginThrottle(failure_limit=1, base_block_s=30)
    throttle.record_failure("alice", "198.51.100.8")
    monkeypatch.setattr(auth_routes, "_login_throttle", throttle)

    # act — TestClient's socket peer is not the blocked address.
    response = client.post(
        "/api/auth/login",
        json={"username": "alice", "password": "hunter2"},
    )

    # assert
    assert response.status_code == 200


def test_login_extra_field_rejected_as_422(client, seeded_user):
    res = client.post(
        "/api/auth/login",
        json={"username": "alice", "password": "hunter2", "extra": "x"},
    )
    assert res.status_code == 422


def test_login_missing_password_rejected_as_422(client, seeded_user):
    res = client.post("/api/auth/login", json={"username": "alice"})
    assert res.status_code == 422


def test_login_too_long_username_rejected_as_422(client, auth_env):
    res = client.post(
        "/api/auth/login",
        json={"username": "x" * 65, "password": "hunter2"},
    )
    assert res.status_code == 422


def test_login_too_long_password_rejected_as_422(client, auth_env):
    res = client.post(
        "/api/auth/login",
        json={"username": "alice", "password": "p" * 257},
    )
    assert res.status_code == 422


# --- /api/auth/me -------------------------------------------------------


def test_me_without_cookie_returns_401(client_anon, auth_env):
    res = client_anon.get("/api/auth/me")
    assert res.status_code == 401


def test_me_after_login_returns_user(client, seeded_user):
    client.post(
        "/api/auth/login",
        json={"username": "alice", "password": "hunter2"},
    )
    res = client.get("/api/auth/me")
    assert res.status_code == 200
    assert res.json() == {"user": {"username": "alice", "role": "admin"}}


def test_me_with_invalid_access_cookie_returns_401(client_anon, auth_env):
    client_anon.cookies.set(
        "homecam_access", "not-a-real-jwt", domain="testserver", path="/api"
    )
    res = client_anon.get("/api/auth/me")
    assert res.status_code == 401


def test_me_with_refresh_token_in_access_slot_returns_401(client_anon, seeded_user):
    """Kind mismatch — must be rejected even though signature is valid."""
    refresh_token = tokens.issue("alice", "refresh")
    client_anon.cookies.set(
        "homecam_access", refresh_token, domain="testserver", path="/api"
    )
    res = client_anon.get("/api/auth/me")
    assert res.status_code == 401


def test_me_with_deleted_user_returns_401(client_anon, seeded_user):
    """Token signed by current secret, but the user row was deleted —
    server must NOT trust the claim and resurrect the session."""
    access_token = tokens.issue("alice", "access")
    client_anon.cookies.set(
        "homecam_access", access_token, domain="testserver", path="/api"
    )
    with sqlite3.connect(settings.users_db_path) as conn:
        conn.execute("DELETE FROM users WHERE username = ?", ("alice",))
        conn.commit()
    res = client_anon.get("/api/auth/me")
    assert res.status_code == 401


# --- /api/auth/refresh --------------------------------------------------


def test_refresh_without_cookie_returns_401(client_anon, auth_env):
    res = client_anon.post("/api/auth/refresh", json={})
    assert res.status_code == 401


def test_refresh_with_valid_cookie_returns_user_and_rotates_cookies(
    client, seeded_user
):
    client.post(
        "/api/auth/login",
        json={"username": "alice", "password": "hunter2"},
    )
    res = client.post("/api/auth/refresh", json={})
    assert res.status_code == 200
    assert res.json() == {"user": {"username": "alice", "role": "admin"}}
    # Both cookies re-issued — sliding window per the plan.
    assert "homecam_access" in res.cookies
    assert "homecam_refresh" in res.cookies


def test_given_refresh_when_session_row_exists_then_it_rotates_same_session(
    client, seeded_user
):
    # arrange
    login = client.post(
        "/api/auth/login",
        json={"username": "alice", "password": "hunter2"},
    )
    old_access = tokens.decode(login.cookies["homecam_access"], kind="access")["jti"]
    old_refresh = tokens.decode(login.cookies["homecam_refresh"], kind="refresh")["jti"]
    old_row = sessions_db.get_session(settings.sessions_db_path, old_access)

    # act
    res = client.post("/api/auth/refresh", json={})

    # assert
    assert res.status_code == 200
    new_access = tokens.decode(res.cookies["homecam_access"], kind="access")["jti"]
    new_refresh = tokens.decode(res.cookies["homecam_refresh"], kind="refresh")["jti"]
    assert new_access != old_access
    assert new_refresh != old_refresh
    assert sessions_db.get_session(settings.sessions_db_path, old_access) is None
    new_row = sessions_db.get_session(settings.sessions_db_path, new_access)
    assert new_row is not None
    assert new_row["refresh_jti"] == new_refresh
    assert new_row["created_ts"] == old_row["created_ts"]


def test_given_revoked_session_when_refreshing_then_401(client, seeded_user):
    # arrange
    login = client.post(
        "/api/auth/login",
        json={"username": "alice", "password": "hunter2"},
    )
    access_jti = tokens.decode(login.cookies["homecam_access"], kind="access")["jti"]
    sessions_db.revoke_by_jti(settings.sessions_db_path, access_jti, 123.0)

    # act
    res = client.post("/api/auth/refresh", json={})

    # assert
    assert res.status_code == 401


def test_refresh_with_access_token_in_refresh_slot_returns_401(
    client_anon, seeded_user
):
    access_token = tokens.issue("alice", "access")
    client_anon.cookies.set(
        "homecam_refresh", access_token, domain="testserver", path="/api"
    )
    res = client_anon.post("/api/auth/refresh", json={})
    assert res.status_code == 401


def test_refresh_with_deleted_user_returns_401(client_anon, seeded_user):
    refresh_token = tokens.issue("alice", "refresh")
    client_anon.cookies.set(
        "homecam_refresh", refresh_token, domain="testserver", path="/api"
    )
    with sqlite3.connect(settings.users_db_path) as conn:
        conn.execute("DELETE FROM users WHERE username = ?", ("alice",))
        conn.commit()
    res = client_anon.post("/api/auth/refresh", json={})
    assert res.status_code == 401


# --- /api/auth/logout ---------------------------------------------------


def test_logout_after_login_clears_session(client, seeded_user):
    client.post(
        "/api/auth/login",
        json={"username": "alice", "password": "hunter2"},
    )
    res = client.post("/api/auth/logout", json={})
    assert res.status_code == 200
    assert res.json() == {"ok": True}
    # /me after logout must 401 — proves the cookie was actually
    # cleared, not just a no-op response.
    me_res = client.get("/api/auth/me")
    assert me_res.status_code == 401


def test_logout_without_prior_login_still_returns_200(client, auth_env):
    res = client.post("/api/auth/logout", json={})
    assert res.status_code == 200
    assert res.json() == {"ok": True}


# iter-258: self-service password change + owner-only admin reset.

def test_change_password_with_correct_current_succeeds(client, seeded_user):
    client.post(
        "/api/auth/login",
        json={"username": "alice", "password": "hunter2"},
    )
    r = client.post(
        "/api/auth/change_password",
        json={"current_password": "hunter2", "new_password": "newpass1"},
    )
    assert r.status_code == 200
    assert r.json() == {"ok": True}
    # Re-login with the new password works.
    r2 = client.post(
        "/api/auth/login",
        json={"username": "alice", "password": "newpass1"},
    )
    assert r2.status_code == 200


def test_change_password_with_wrong_current_returns_401(client, seeded_user):
    client.post(
        "/api/auth/login",
        json={"username": "alice", "password": "hunter2"},
    )
    r = client.post(
        "/api/auth/change_password",
        json={"current_password": "wrong", "new_password": "newpass1"},
    )
    assert r.status_code == 401


def test_change_password_anonymous_returns_401(client_anon):
    r = client_anon.post(
        "/api/auth/change_password",
        json={"current_password": "x", "new_password": "newpass1"},
    )
    assert r.status_code == 401


def test_admin_reset_password_owner_can_reset_other_user(client, auth_env):
    # Owner logs in.
    users_db.create_user(
        auth_env / "users.db",
        "boss",
        passwords.hash_password("bosspass"),
        role="owner",
    )
    users_db.create_user(
        auth_env / "users.db",
        "babage",
        passwords.hash_password("oldpass"),
        role="family",
    )
    client.post(
        "/api/auth/login",
        json={"username": "boss", "password": "bosspass"},
    )
    r = client.post(
        "/api/auth/admin/reset_password",
        json={"username": "babage", "new_password": "newpass1"},
    )
    assert r.status_code == 200
    # Babage can now log in with the new password.
    r2 = client.post(
        "/api/auth/login",
        json={"username": "babage", "password": "newpass1"},
    )
    assert r2.status_code == 200


def test_admin_reset_password_family_role_403(client, auth_env):
    users_db.create_user(
        auth_env / "users.db",
        "fam",
        passwords.hash_password("fampass"),
        role="family",
    )
    users_db.create_user(
        auth_env / "users.db",
        "victim",
        passwords.hash_password("v"),
        role="family",
    )
    client.post(
        "/api/auth/login",
        json={"username": "fam", "password": "fampass"},
    )
    r = client.post(
        "/api/auth/admin/reset_password",
        json={"username": "victim", "new_password": "newpass1"},
    )
    assert r.status_code == 403


def test_admin_reset_password_for_unknown_user_returns_404(client, seeded_user):
    # `seeded_user` is admin role — owner-tier per the iter-197
    # transitional carve-out.
    client.post(
        "/api/auth/login",
        json={"username": "alice", "password": "hunter2"},
    )
    r = client.post(
        "/api/auth/admin/reset_password",
        json={"username": "ghost", "new_password": "newpass1"},
    )
    assert r.status_code == 404


# iter-265: admin user management — list + create + delete.
# BDD-lite: name encodes Given/When/Then; body is AAA-shaped.

def test_given_owner_when_listing_users_then_returns_every_row_without_password_hashes(
    client, auth_env
):
    # Given: an owner + two family members in the DB.
    users_db.create_user(
        auth_env / "users.db",
        "owner1",
        passwords.hash_password("ownerpass"),
        role="owner",
    )
    users_db.create_user(
        auth_env / "users.db",
        "family1",
        passwords.hash_password("famp1"),
        role="family",
    )
    users_db.create_user(
        auth_env / "users.db",
        "viewer1",
        passwords.hash_password("viewp1"),
        role="viewer",
    )
    client.post("/api/auth/login", json={"username": "owner1", "password": "ownerpass"})

    # When: owner GETs /api/auth/admin/users.
    r = client.get("/api/auth/admin/users")

    # Then: 200 with rows for every user, NO password hash field.
    assert r.status_code == 200
    body = r.json()
    usernames = {row["username"] for row in body["users"]}
    assert {"owner1", "family1", "viewer1"}.issubset(usernames)
    for row in body["users"]:
        assert "password_hash" not in row
        assert set(row.keys()) == {"username", "role", "created_at"}


def test_given_family_when_listing_users_then_403(client, auth_env):
    # Given: a family-role user (not owner).
    users_db.create_user(
        auth_env / "users.db",
        "fam",
        passwords.hash_password("fampass"),
        role="family",
    )
    client.post("/api/auth/login", json={"username": "fam", "password": "fampass"})

    # When: family POSTs the admin list.
    r = client.get("/api/auth/admin/users")

    # Then: forbidden — the require_role("owner") gate rejects.
    assert r.status_code == 403


def test_given_owner_when_creating_new_user_then_201_and_user_can_log_in(
    client, auth_env
):
    # Given: an owner.
    users_db.create_user(
        auth_env / "users.db",
        "boss",
        passwords.hash_password("bosspass"),
        role="owner",
    )
    client.post("/api/auth/login", json={"username": "boss", "password": "bosspass"})

    # When: owner creates a new user with role=family.
    r = client.post(
        "/api/auth/admin/users",
        json={"username": "kid", "password": "kidpass1", "role": "family"},
    )

    # Then: 201 and the new user can log in immediately.
    assert r.status_code == 201
    body = r.json()
    assert body["ok"] is True
    assert body["username"] == "kid"
    assert body["role"] == "family"

    r2 = client.post(
        "/api/auth/login",
        json={"username": "kid", "password": "kidpass1"},
    )
    assert r2.status_code == 200


def test_given_owner_when_creating_duplicate_user_then_409(client, auth_env):
    # Given: an existing user.
    users_db.create_user(
        auth_env / "users.db",
        "boss",
        passwords.hash_password("bosspass"),
        role="owner",
    )
    users_db.create_user(
        auth_env / "users.db",
        "exists",
        passwords.hash_password("p1"),
        role="family",
    )
    client.post("/api/auth/login", json={"username": "boss", "password": "bosspass"})

    # When: owner tries to create the same username again.
    r = client.post(
        "/api/auth/admin/users",
        json={"username": "exists", "password": "newpass8", "role": "viewer"},
    )

    # Then: 409 conflict (not 500) so the UI can render a friendly
    # "username already taken" message.
    assert r.status_code == 409


def test_given_owner_when_creating_user_with_short_password_then_422(
    client, auth_env
):
    # Given: an owner.
    users_db.create_user(
        auth_env / "users.db",
        "boss",
        passwords.hash_password("bosspass"),
        role="owner",
    )
    client.post("/api/auth/login", json={"username": "boss", "password": "bosspass"})

    # When: owner submits a 4-char password (below the iter-264 floor).
    r = client.post(
        "/api/auth/admin/users",
        json={"username": "newkid", "password": "abcd", "role": "family"},
    )

    # Then: 422 from Pydantic min_length=8.
    assert r.status_code == 422


def test_given_owner_when_creating_user_with_invalid_role_then_422(
    client, auth_env
):
    # Given: an owner.
    users_db.create_user(
        auth_env / "users.db",
        "boss",
        passwords.hash_password("bosspass"),
        role="owner",
    )
    client.post("/api/auth/login", json={"username": "boss", "password": "bosspass"})

    # When: owner submits a role NOT in ROLE_VOCAB.
    r = client.post(
        "/api/auth/admin/users",
        json={"username": "imp", "password": "passpass", "role": "god"},
    )

    # Then: 422 from the regex pattern on `role`.
    assert r.status_code == 422


def test_given_family_when_creating_user_then_403(client, auth_env):
    # Given: a family member.
    users_db.create_user(
        auth_env / "users.db",
        "fam",
        passwords.hash_password("fampass"),
        role="family",
    )
    client.post("/api/auth/login", json={"username": "fam", "password": "fampass"})

    # When: family tries to create.
    r = client.post(
        "/api/auth/admin/users",
        json={"username": "newkid", "password": "passpass", "role": "viewer"},
    )

    # Then: 403 — only owners can.
    assert r.status_code == 403


def test_given_owner_when_deleting_other_user_then_user_gone(client, auth_env):
    # Given: an owner + a family member.
    users_db.create_user(
        auth_env / "users.db",
        "boss",
        passwords.hash_password("bosspass"),
        role="owner",
    )
    users_db.create_user(
        auth_env / "users.db",
        "fam",
        passwords.hash_password("fampass"),
        role="family",
    )
    client.post("/api/auth/login", json={"username": "boss", "password": "bosspass"})

    # When: owner deletes the family member.
    r = client.post(
        "/api/auth/admin/delete_user",
        json={"username": "fam"},
    )

    # Then: 200 and the family member is gone (login fails).
    assert r.status_code == 200
    r2 = client.post(
        "/api/auth/login",
        json={"username": "fam", "password": "fampass"},
    )
    assert r2.status_code == 401


def test_given_owner_when_deleting_another_owner_then_400(client, auth_env):
    # 2026-07-09 policy ("users shouldn't be able to delete admin"): an
    # owner cannot delete a DIFFERENT owner/admin account — not just the
    # last one. Only family/viewer users are removable via the API.
    users_db.create_user(
        auth_env / "users.db",
        "boss",
        passwords.hash_password("bosspass"),
        role="owner",
    )
    users_db.create_user(
        auth_env / "users.db",
        "boss2",
        passwords.hash_password("boss2pass"),
        role="owner",
    )
    client.post("/api/auth/login", json={"username": "boss", "password": "bosspass"})

    # When: owner tries to delete the OTHER owner.
    r = client.post(
        "/api/auth/admin/delete_user",
        json={"username": "boss2"},
    )

    # Then: 400 — privileged accounts are protected...
    assert r.status_code == 400
    assert "admin or owner" in r.json()["detail"].lower()
    # ...and boss2 still exists (their login still works).
    r2 = client.post(
        "/api/auth/login",
        json={"username": "boss2", "password": "boss2pass"},
    )
    assert r2.status_code == 200


def test_given_owner_when_deleting_legacy_admin_then_400(client, auth_env):
    # A legacy `admin`-role account is owner-tier, so it's protected too.
    users_db.create_user(
        auth_env / "users.db",
        "boss",
        passwords.hash_password("bosspass"),
        role="owner",
    )
    users_db.create_user(
        auth_env / "users.db",
        "legacy",
        passwords.hash_password("legacypass"),
        role="admin",
    )
    client.post("/api/auth/login", json={"username": "boss", "password": "bosspass"})

    r = client.post(
        "/api/auth/admin/delete_user",
        json={"username": "legacy"},
    )

    assert r.status_code == 400
    assert "admin or owner" in r.json()["detail"].lower()


def test_given_owner_when_deleting_self_then_400(client, auth_env):
    # Given: an owner.
    users_db.create_user(
        auth_env / "users.db",
        "boss",
        passwords.hash_password("bosspass"),
        role="owner",
    )
    # Second owner so the last-owner guard doesn't fire instead.
    users_db.create_user(
        auth_env / "users.db",
        "boss2",
        passwords.hash_password("boss2pass"),
        role="owner",
    )
    client.post("/api/auth/login", json={"username": "boss", "password": "bosspass"})

    # When: owner tries to delete themselves.
    r = client.post(
        "/api/auth/admin/delete_user",
        json={"username": "boss"},
    )

    # Then: 400 — protect from self-lockout (the cookie still works
    # but the next refresh fails because the user row is gone).
    assert r.status_code == 400


def test_given_only_owner_when_deleting_them_then_400(client, auth_env):
    # Given: a single owner. (No second owner.)
    users_db.create_user(
        auth_env / "users.db",
        "boss",
        passwords.hash_password("bosspass"),
        role="owner",
    )
    users_db.create_user(
        auth_env / "users.db",
        "fam",
        passwords.hash_password("fampass"),
        role="family",
    )
    client.post("/api/auth/login", json={"username": "boss", "password": "bosspass"})

    # When: try to delete the only owner.
    # (Owner can't delete themselves, but neither can anyone else
    # delete the last owner — the route-side check blocks both.)
    r = client.post(
        "/api/auth/admin/delete_user",
        json={"username": "boss"},
    )

    # Then: 400 — last-owner guard. Recovery requires SSH +
    # gen_admin --reset; never let a remote actor lock the deploy.
    assert r.status_code == 400


def test_given_family_when_deleting_user_then_403(client, auth_env):
    # Given: a family-role caller.
    users_db.create_user(
        auth_env / "users.db",
        "fam",
        passwords.hash_password("fampass"),
        role="family",
    )
    users_db.create_user(
        auth_env / "users.db",
        "boss",
        passwords.hash_password("bosspass"),
        role="owner",
    )
    client.post("/api/auth/login", json={"username": "fam", "password": "fampass"})

    # When: family POSTs delete.
    r = client.post(
        "/api/auth/admin/delete_user",
        json={"username": "boss"},
    )

    # Then: 403 — owner-only.
    assert r.status_code == 403
