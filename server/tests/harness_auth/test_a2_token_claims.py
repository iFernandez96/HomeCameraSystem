from __future__ import annotations

from app.auth import tokens
from app.auth.dependencies import COOKIE_ACCESS, COOKIE_REFRESH

from server.tests.harness_auth.scratch_server import scratch_auth_server


def test_given_successful_login_when_cookie_tokens_are_decoded_then_claims_match_seeded_user_and_ttls(
    scratch_auth_server,
):
    # Given: a successful login on the scratch server.
    server = scratch_auth_server
    response = server.post_login()
    assert response.status_code == 200

    # When: both cookie tokens are decoded with the server token helper.
    access_claims = tokens.decode(response.cookies[COOKIE_ACCESS], kind="access")
    refresh_claims = tokens.decode(response.cookies[COOKIE_REFRESH], kind="refresh")

    # Then: token kind, seeded user claims, and injected TTL-derived expiry match.
    assert access_claims["kind"] == "access"
    assert refresh_claims["kind"] == "refresh"

    for claims in (access_claims, refresh_claims):
        assert claims["sub"] == server.user.username
        assert claims["role"] == server.user.role

    assert access_claims["exp"] - access_claims["iat"] == server.access_token_ttl_s
    assert refresh_claims["exp"] - refresh_claims["iat"] == server.refresh_token_ttl_s
