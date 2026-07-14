"""Tests for the iter-103 security-headers middleware.

Pin the headers on representative responses: API JSON, the SPA
fallback, and (when present) static-mounted files. The middleware
runs on every HTTP response routed through the FastAPI app.
"""
from fastapi.testclient import TestClient


_EXPECTED = {
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "same-origin",
}


def _assert_security_headers(headers):
    for k, v in _EXPECTED.items():
        assert headers.get(k) == v, f"{k} expected {v!r}, got {headers.get(k)!r}"


def test_status_response_has_security_headers(client: TestClient):
    r = client.get("/api/status")
    assert r.status_code == 200
    _assert_security_headers(r.headers)


def test_events_list_response_has_security_headers(client: TestClient):
    r = client.get("/api/events?limit=5")
    assert r.status_code == 200
    _assert_security_headers(r.headers)


def test_validation_error_response_has_security_headers(client: TestClient):
    """422 responses (Pydantic rejection) flow through the same
    middleware. Non-2xx must still get hardened headers."""
    r = client.post("/api/_internal/event", json={"bad": "shape"})
    assert r.status_code == 422
    _assert_security_headers(r.headers)


def test_413_body_too_large_response_has_security_headers(client: TestClient):
    """The body-size middleware short-circuits the request with 413
    BEFORE the security-headers middleware decorates it. ASGI
    middleware ordering: outer wraps inner, so the security-headers
    middleware (declared after) is the *outer* wrapper and decorates
    the 413 PlainTextResponse."""
    from app.main import MAX_REQUEST_BODY_BYTES

    big = b"x" * (MAX_REQUEST_BODY_BYTES + 1)
    r = client.post(
        "/api/_internal/event",
        content=big,
        headers={"Content-Type": "application/json"},
    )
    assert r.status_code == 413
    _assert_security_headers(r.headers)


# iter-264 (security-auditor D2): Permissions-Policy lockdown.
# BDD-lite: name encodes Given/When/Then; body is AAA-shaped.

def test_given_status_response_when_security_middleware_runs_then_permissions_policy_allows_own_mic_only(
    client: TestClient,
):
    # Given: an authenticated /api/status request.
    # When: the response flows through the iter-264 security-headers middleware.
    r = client.get("/api/status")

    # Talk publishes the phone microphone, but only this origin may request it.
    # Camera/geolocation/payment remain denied.
    assert r.status_code == 200
    pp = r.headers.get("permissions-policy", "")
    assert "camera=()" in pp
    assert "microphone=(self)" in pp
    assert "geolocation=()" in pp
    assert "payment=()" in pp


# iter-264 (security-auditor D1): Cache-Control: no-store on auth
# endpoints so a forward proxy (Tailscale Funnel, future Caddy front)
# can never cache a response that includes Set-Cookie.

def test_given_login_when_response_carries_set_cookie_then_cache_control_is_no_store(
    client_anon: TestClient,
):
    # Given: an anonymous client with a seeded user.
    # (The shared `client_anon` fixture seeds testuser/testpass.)

    # When: that user POSTs to /api/auth/login successfully.
    r = client_anon.post(
        "/api/auth/login",
        json={"username": "testuser", "password": "testpass"},
    )

    # Then: response sets cookies AND Cache-Control: no-store, so
    # an upstream cache can't accidentally serve user A's cookies
    # to user B on the same URL.
    assert r.status_code == 200
    assert any(c.lower().startswith("set-cookie") or c == "set-cookie"
               for c in r.headers.keys())
    assert r.headers.get("cache-control") == "no-store"


def test_given_logout_when_response_clears_cookies_then_cache_control_is_no_store(
    client: TestClient,
):
    # Given: an authenticated client.
    # When: that client POSTs /api/auth/logout.
    r = client.post("/api/auth/logout")

    # Then: clear-cookie response is also marked uncacheable.
    assert r.status_code == 200
    assert r.headers.get("cache-control") == "no-store"


def test_given_me_when_response_carries_user_identity_then_cache_control_is_no_store(
    client: TestClient,
):
    # Given: an authenticated GET /api/auth/me.
    # When: server returns the user's identity.
    r = client.get("/api/auth/me")

    # Then: identity response is uncacheable so a proxy can't serve
    # user A's identity to user B.
    assert r.status_code == 200
    assert r.headers.get("cache-control") == "no-store"


def test_given_me_anon_when_401_then_cache_control_is_no_store(
    client_anon: TestClient,
):
    # Given: an anonymous client (no auth cookie).
    # When: it hits /api/auth/me.
    r = client_anon.get("/api/auth/me")

    # Then: the 401 itself is uncacheable. The 401 path is the one
    # that pre-iter-264-middleware-fix dropped Cache-Control because
    # `HTTPException` builds a fresh JSONResponse that doesn't merge
    # headers from the injected `Response` parameter — so Cache-Control
    # MUST be applied at the middleware tier (path-prefix branch).
    assert r.status_code == 401
    assert r.headers.get("cache-control") == "no-store"


def test_given_login_with_bad_credentials_when_401_then_cache_control_is_no_store(
    client_anon: TestClient,
):
    # Given: anonymous client.
    # When: invalid login credentials.
    r = client_anon.post(
        "/api/auth/login",
        json={"username": "ghost", "password": "anything"},
    )

    # Then: 401 still carries Cache-Control: no-store (middleware-tier).
    assert r.status_code == 401
    assert r.headers.get("cache-control") == "no-store"
