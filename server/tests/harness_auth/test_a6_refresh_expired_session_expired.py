from __future__ import annotations

import logging
import time

from app.auth import tokens
from app.auth.dependencies import COOKIE_ACCESS, COOKIE_REFRESH

from server.tests.harness_auth.scratch_server import scratch_auth_server


def test_given_expired_access_and_refresh_cookies_when_refresh_is_posted_then_session_expired_is_pinned(
    scratch_auth_server,
    caplog,
):
    # Given: a scratch server whose access and refresh tokens are both expired.
    server = scratch_auth_server
    past = time.time() - max(server.access_token_ttl_s, server.refresh_token_ttl_s) - 1
    expired_access = tokens.issue(
        server.user.username,
        "access",
        role=server.user.role,
        now=past,
    )
    expired_refresh = tokens.issue(
        server.user.username,
        "refresh",
        role=server.user.role,
        now=past,
    )

    server.client.cookies.clear()
    server.client.cookies.set(COOKIE_ACCESS, expired_access)
    server.client.cookies.set(COOKIE_REFRESH, expired_refresh)

    # When: the client posts to refresh with the expired refresh cookie.
    with caplog.at_level(logging.WARNING):
        response = server.client.post("/api/auth/refresh", json={})

    # Then: the wire detail stays exactly what api.ts keys session expiry on.
    assert response.status_code == 401
    assert response.json()["detail"] == "session expired"

    refresh_rejections = [
        record.getMessage()
        for record in caplog.records
        if record.levelno == logging.WARNING
        and "auth rejected on POST /api/auth/refresh:" in record.getMessage()
    ]
    assert any("refresh: invalid/expired:" in msg for msg in refresh_rejections)
    assert any("cookie_present=True" in msg for msg in refresh_rejections)
