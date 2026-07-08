from __future__ import annotations

import logging

from app.auth.dependencies import COOKIE_ACCESS, COOKIE_REFRESH

from server.tests.harness_auth.scratch_server import scratch_auth_server


def test_given_logged_in_scratch_server_when_token_kinds_are_swapped_across_http_boundaries_then_both_are_401(
    scratch_auth_server,
    caplog,
):
    # Given: a logged-in scratch server with real access and refresh cookies.
    server = scratch_auth_server
    login = server.post_login()
    assert login.status_code == 200
    access_token = login.cookies[COOKIE_ACCESS]
    refresh_token = login.cookies[COOKIE_REFRESH]

    # When: the refresh token is presented where an access token belongs.
    server.client.cookies.clear()
    server.client.cookies.set(COOKIE_ACCESS, refresh_token)
    with caplog.at_level(logging.WARNING):
        protected_response = server.client.get("/api/harness/protected")
    protected_rejections = [
        record.getMessage()
        for record in caplog.records
        if record.levelno == logging.WARNING
        and "auth rejected on GET /api/harness/protected:" in record.getMessage()
    ]
    assert any("cookie_present=True" in msg for msg in protected_rejections)

    # And: the access token is presented where a refresh token belongs.
    caplog.clear()
    server.client.cookies.clear()
    server.client.cookies.set(COOKIE_REFRESH, access_token)
    with caplog.at_level(logging.WARNING):
        refresh_response = server.client.post("/api/auth/refresh", json={})
    refresh_rejections = [
        record.getMessage()
        for record in caplog.records
        if record.levelno == logging.WARNING
        and "auth rejected on POST /api/auth/refresh:" in record.getMessage()
    ]
    assert any("cookie_present=True" in msg for msg in refresh_rejections)

    # Then: both HTTP boundaries reject the wrong token kind.
    assert protected_response.status_code == 401
    assert refresh_response.status_code == 401
