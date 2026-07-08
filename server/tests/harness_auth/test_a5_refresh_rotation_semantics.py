from __future__ import annotations

import logging

from app.auth import tokens
from app.auth.dependencies import COOKIE_ACCESS, COOKIE_REFRESH

from server.tests.harness_auth.scratch_server import scratch_auth_server


def test_given_logged_in_scratch_server_when_original_refresh_cookie_is_reused_twice_then_both_refreshes_succeed_with_valid_access_tokens(
    scratch_auth_server,
    caplog,
):
    # Given: a logged-in scratch server with the original refresh cookie.
    server = scratch_auth_server
    login = server.post_login()
    assert login.status_code == 200
    original_refresh = login.cookies[COOKIE_REFRESH]

    # When: two racing tabs both post refresh with the same original cookie.
    server.client.cookies.clear()
    server.client.cookies.set(COOKIE_REFRESH, original_refresh)
    with caplog.at_level(logging.WARNING):
        first_refresh = server.client.post("/api/auth/refresh", json={})

    server.client.cookies.clear()
    server.client.cookies.set(COOKIE_REFRESH, original_refresh)
    with caplog.at_level(logging.WARNING):
        second_refresh = server.client.post("/api/auth/refresh", json={})

    # Then: refresh tokens are sliding-window, not single-use; no revocation
    # or jti store exists, so reusing the original refresh cookie is accepted.
    assert first_refresh.status_code == 200
    assert second_refresh.status_code == 200
    assert COOKIE_ACCESS in first_refresh.cookies
    assert COOKIE_ACCESS in second_refresh.cookies

    for response in (first_refresh, second_refresh):
        access_claims = tokens.decode(response.cookies[COOKIE_ACCESS], kind="access")
        assert access_claims["kind"] == "access"
        assert access_claims["sub"] == server.user.username
        assert access_claims["role"] == server.user.role

    refresh_rejections = [
        record.getMessage()
        for record in caplog.records
        if record.levelno == logging.WARNING
        and "auth rejected on POST /api/auth/refresh:" in record.getMessage()
    ]
    assert refresh_rejections == []
