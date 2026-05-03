"""iter-192 (Feature #3 RBAC foundation): role-aware deps.

Tests the `get_current_user_role` dep that returns ``(username, role)``
and the `require_role(role)` factory that 403s on mismatch. Routes
don't ship role-gated endpoints in iter-192 — the foundation lands
here so a future iter can wire `Depends(require_role("owner"))` on
specific endpoints (control/* / push/* / system_reboot).

Backwards compat: pre-iter-192 access cookies (no `role` claim) are
treated as ``admin`` so existing live sessions don't 401 across the
iter-192 deploy.
"""
from __future__ import annotations

import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from app.auth import passwords, tokens, users_db
from app.auth.dependencies import (
    COOKIE_ACCESS,
    get_current_user_role,
    require_role,
)
from app.config import settings


@pytest.fixture
def auth_env(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "users_db_path", tmp_path / "users.db")
    monkeypatch.setattr(settings, "jwt_secret_path", tmp_path / "jwt.bin")
    monkeypatch.setattr(settings, "cookie_secure", False)
    users_db.init_db(tmp_path / "users.db")
    yield tmp_path


# --- get_current_user_role -------------------------------------------------


def test_role_dep_returns_tuple_with_role_from_jwt(auth_env):
    # iter-266: dep now also re-checks users_db, so the row must
    # exist. Storage role and JWT role agree → expected (alice, owner).
    users_db.create_user(
        auth_env / "users.db",
        "alice",
        passwords.hash_password("hunter2"),
        role="owner",
    )
    token = tokens.issue("alice", "access", role="owner")
    # Build a minimal app that just exposes /whoami via the dep.
    app = FastAPI()

    @app.get("/whoami")
    def whoami(ur: tuple[str, str] = Depends(get_current_user_role)):
        return {"u": ur[0], "r": ur[1]}

    with TestClient(app) as c:
        r = c.get("/whoami", cookies={COOKIE_ACCESS: token})
        assert r.status_code == 200
        assert r.json() == {"u": "alice", "r": "owner"}


def test_role_dep_falls_back_to_admin_for_pre_iter192_tokens(auth_env):
    """A token without a `role` claim (pre-iter-192) decodes as
    `(sub, "admin")` — backwards compat across the deploy.

    iter-266: post-DB-recheck the role now comes from the users_db
    row when present. Seed the legacy user with role='admin' so the
    DB-derived role matches the iter-192 fallback. Test still pins
    the same external behavior: pre-iter-192 token → ('admin')."""
    users_db.create_user(
        auth_env / "users.db",
        "legacy_alice",
        passwords.hash_password("hunter2"),
        role="admin",
    )
    import jwt as pyjwt
    from app.auth import jwt_secret as jws

    secret = jws.load_or_generate(settings.jwt_secret_path)
    # Mint manually WITHOUT a role claim.
    import time
    iat = int(time.time())
    payload = {
        "sub": "legacy_alice",
        "kind": "access",
        "iat": iat,
        "exp": iat + 900,
    }
    token = pyjwt.encode(payload, secret, algorithm="HS256")

    app = FastAPI()

    @app.get("/whoami")
    def whoami(ur: tuple[str, str] = Depends(get_current_user_role)):
        return {"u": ur[0], "r": ur[1]}

    with TestClient(app) as c:
        r = c.get("/whoami", cookies={COOKIE_ACCESS: token})
        assert r.status_code == 200
        assert r.json() == {"u": "legacy_alice", "r": "admin"}


def test_role_dep_401s_without_cookie(auth_env):
    app = FastAPI()

    @app.get("/whoami")
    def whoami(ur: tuple[str, str] = Depends(get_current_user_role)):
        return {"u": ur[0], "r": ur[1]}

    with TestClient(app) as c:
        r = c.get("/whoami")
        assert r.status_code == 401


def test_role_dep_401s_with_invalid_cookie(auth_env):
    app = FastAPI()

    @app.get("/whoami")
    def whoami(ur: tuple[str, str] = Depends(get_current_user_role)):
        return {"u": ur[0], "r": ur[1]}

    with TestClient(app) as c:
        r = c.get("/whoami", cookies={COOKIE_ACCESS: "garbage"})
        assert r.status_code == 401


# --- require_role ----------------------------------------------------------


def _build_role_gated_app() -> FastAPI:
    app = FastAPI()

    @app.get("/owner-only")
    def owner_only(_user: str = Depends(require_role("owner"))) -> dict:
        return {"ok": True, "user": _user}

    @app.get("/family-or-better")
    def family_only(_user: str = Depends(require_role("family"))) -> dict:
        return {"ok": True, "user": _user}

    return app


def test_require_role_403s_on_mismatch(auth_env):
    """A `family`-role user can't pass an `owner-only` gate.
    iter-192 originally tested `admin` → 403, but iter-197 added
    the transitional `admin`-as-effective-`owner` carve-out (so
    legacy seeded users keep working through the deploy). Use
    `family` for the 403 case instead — it's the canonical
    non-owner role per iter-196's vocabulary.

    iter-266: also seeds the user row so the DB-recheck dep finds
    them (otherwise would 401 on missing-row before reaching the
    role gate)."""
    users_db.create_user(
        auth_env / "users.db",
        "alice",
        passwords.hash_password("hunter2"),
        role="family",
    )
    app = _build_role_gated_app()
    token = tokens.issue("alice", "access", role="family")
    with TestClient(app) as c:
        r = c.get("/owner-only", cookies={COOKIE_ACCESS: token})
        assert r.status_code == 403
        assert "owner" in r.json().get("detail", "")


def test_require_role_owner_accepts_legacy_admin(auth_env):
    """iter-197 transitional carve-out: legacy `admin` users
    (seeded by iter-178/179 bootstrap, JWT-decoded as `admin` per
    iter-192's fallback) MUST pass `require_role("owner")`. Without
    this, every existing seeded user 403s on owner-only routes
    immediately after iter-197 deploys. Drop this test when the
    user vocabulary is fully `owner`/`family`/`viewer` and seeded
    users have been migrated."""
    users_db.create_user(
        auth_env / "users.db",
        "alice",
        passwords.hash_password("hunter2"),
        role="admin",
    )
    app = _build_role_gated_app()
    token = tokens.issue("alice", "access", role="admin")
    with TestClient(app) as c:
        r = c.get("/owner-only", cookies={COOKIE_ACCESS: token})
        assert r.status_code == 200
        assert r.json() == {"ok": True, "user": "alice"}


def test_require_role_passes_on_match(auth_env):
    users_db.create_user(
        auth_env / "users.db",
        "alice",
        passwords.hash_password("hunter2"),
        role="owner",
    )
    app = _build_role_gated_app()
    token = tokens.issue("alice", "access", role="owner")
    with TestClient(app) as c:
        r = c.get("/owner-only", cookies={COOKIE_ACCESS: token})
        assert r.status_code == 200
        assert r.json() == {"ok": True, "user": "alice"}


def test_require_role_401s_without_cookie_before_403(auth_env):
    """Anon → 401 (auth issue). Wrong role → 403 (authz issue).
    The two states are distinguishable to the client."""
    app = _build_role_gated_app()
    with TestClient(app) as c:
        r = c.get("/owner-only")
        assert r.status_code == 401


def test_given_user_deleted_when_authed_request_arrives_then_401_immediately(
    auth_env,
):
    # iter-266 (security-auditor C): the dep re-checks users_db on
    # every request, so deleting a user invalidates their session
    # within ONE request — not after up-to-15-min cookie expiry.
    # Pre-iter-266 the JWT signature alone gated access; a deleted
    # admin/owner could keep hitting owner-only routes for the
    # remainder of the access cookie's TTL.

    # arrange: seed a user, mint a real owner-role token, then delete
    # the row out from under the still-valid token.
    users_db.create_user(
        auth_env / "users.db",
        "ghost",
        passwords.hash_password("hunter2"),
        role="owner",
    )
    token = tokens.issue("ghost", "access", role="owner")
    users_db.delete_user(auth_env / "users.db", "ghost")

    # act: request a role-gated route with the orphaned token.
    app = _build_role_gated_app()

    # assert: 401 (auth issue: user gone), NOT 403 (role mismatch)
    # — the dep raises before reaching require_role.
    with TestClient(app) as c:
        r = c.get("/owner-only", cookies={COOKIE_ACCESS: token})
        assert r.status_code == 401
        assert "user" in r.json().get("detail", "").lower()


def test_given_role_changed_in_db_when_authed_request_then_db_role_used(
    auth_env,
):
    # iter-266 (security-auditor C consequence): once we re-check
    # users_db on every request anyway, role changes propagate
    # immediately too — a JWT minted with role='family' but whose
    # row now says 'owner' resolves to ('user', 'owner'). This is
    # the right shape for a future "promote/demote" UI: the change
    # takes effect on the next request, not after the next refresh.

    # arrange: token says family, db says owner.
    users_db.create_user(
        auth_env / "users.db",
        "alice",
        passwords.hash_password("hunter2"),
        role="owner",
    )
    token = tokens.issue("alice", "access", role="family")  # claim is stale

    # act: hit owner-only with the token.
    app = _build_role_gated_app()

    # assert: 200 — DB role wins over claim. (Pre-iter-266 this
    # was 403 because the family claim was authoritative.)
    with TestClient(app) as c:
        r = c.get("/owner-only", cookies={COOKIE_ACCESS: token})
        assert r.status_code == 200


def test_login_then_role_dep_carries_user_db_role(client, auth_env):
    """End-to-end: login as a user with role='admin' → /api/auth/me
    reflects role from claims (iter-192 added the round trip)."""
    users_db.create_user(
        auth_env / "users.db",
        "bob",
        passwords.hash_password("hunter2"),
        role="admin",
    )
    res = client.post(
        "/api/auth/login",
        json={"username": "bob", "password": "hunter2"},
    )
    assert res.status_code == 200
    # /api/auth/me reads role from the users_db row directly today;
    # iter-192's contribution is that the JWT also carries it. Pin
    # both stay in lockstep.
    me = client.get("/api/auth/me")
    assert me.status_code == 200
    assert me.json()["user"]["role"] == "admin"
