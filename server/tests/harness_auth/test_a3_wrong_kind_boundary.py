from __future__ import annotations

from app.auth.dependencies import COOKIE_ACCESS, COOKIE_REFRESH

from server.tests.harness_auth.scratch_server import scratch_auth_server


def test_given_logged_in_scratch_server_when_token_kinds_are_swapped_across_http_boundaries_then_both_are_401(
    scratch_auth_server,
):
    # Given: a logged-in scratch server with real access and refresh cookies.
    server = scratch_auth_server
    login = server.post_login()
    assert login.status_code == 200
    access_token = login.cookies[COOKIE_ACCESS]
    refresh_token = login.cookies[COOKIE_REFRESH]

    # When: the refresh token is presented where an access token belongs.
    server.client.cookies.clear()
    server.client.cookies.set(
        COOKIE_ACCESS, refresh_token, domain="testserver", path="/api"
    )
    protected_response = server.client.get("/api/harness/protected")

    # And: the access token is presented where a refresh token belongs.
    server.client.cookies.clear()
    server.client.cookies.set(
        COOKIE_REFRESH, access_token, domain="testserver", path="/api"
    )
    refresh_response = server.client.post("/api/auth/refresh", json={})

    # Then: both HTTP boundaries reject the wrong token kind.
    assert protected_response.status_code == 401
    assert refresh_response.status_code == 401
