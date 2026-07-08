from __future__ import annotations

import logging
import time

from app.auth import tokens
from app.auth.dependencies import COOKIE_ACCESS, COOKIE_REFRESH

from server.tests.harness_auth.scratch_server import scratch_auth_server


def test_given_expired_access_cookie_and_valid_refresh_cookie_when_refresh_is_posted_then_new_access_cookie_authorizes_protected_route(
    scratch_auth_server,
    caplog,
):
    # Given: a logged-in scratch server whose access token is already expired.
    server = scratch_auth_server
    login = server.post_login()
    assert login.status_code == 200

    expired_access = tokens.issue(
        server.user.username,
        "access",
        role=server.user.role,
        now=time.time() - server.access_token_ttl_s - 1,
    )
    refresh_token = login.cookies[COOKIE_REFRESH]

    server.client.cookies.clear()
    server.client.cookies.set(COOKIE_ACCESS, expired_access)
    server.client.cookies.set(COOKIE_REFRESH, refresh_token)

    with caplog.at_level(logging.WARNING):
        expired_response = server.client.get("/api/harness/protected")
    assert expired_response.status_code == 401
    expired_rejections = [
        record.getMessage()
        for record in caplog.records
        if record.levelno == logging.WARNING
        and "auth rejected on GET /api/harness/protected:" in record.getMessage()
    ]
    assert any("cookie_present=True" in msg for msg in expired_rejections)

    # When: the client posts to refresh with the still-valid refresh cookie.
    refresh_response = server.client.post("/api/auth/refresh", json={})

    # Then: refresh succeeds with a new access cookie for the same user.
    assert refresh_response.status_code == 200
    assert COOKIE_ACCESS in refresh_response.cookies

    new_access = refresh_response.cookies[COOKIE_ACCESS]
    assert new_access != expired_access

    access_claims = tokens.decode(new_access, kind="access")
    assert access_claims["kind"] == "access"
    assert access_claims["sub"] == server.user.username

    # The jar still holds the manually-set expired access cookie alongside
    # the Set-Cookie one from refresh; send ONLY the rotated token.
    server.client.cookies.clear()
    server.client.cookies.set(COOKIE_ACCESS, new_access)

    protected_response = server.client.get("/api/harness/protected")
    assert protected_response.status_code == 200
    assert protected_response.json() == {"user": server.user.username}
