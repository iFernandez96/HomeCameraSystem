from __future__ import annotations

from http.cookies import SimpleCookie

from app.auth.dependencies import COOKIE_ACCESS, COOKIE_REFRESH

from server.tests.harness_auth.scratch_server import scratch_auth_server


def _set_cookie_morsels(response):
    morsels = {}
    for value in response.headers.get_list("set-cookie"):
        parsed = SimpleCookie()
        parsed.load(value)
        morsels.update(parsed)
    return morsels


def test_given_fresh_scratch_server_and_seeded_user_when_login_succeeds_then_auth_cookies_match_declared_contract(
    scratch_auth_server,
):
    # Given: a fresh scratch server and a seeded user.
    server = scratch_auth_server

    # When: POST /api/auth/login succeeds.
    response = server.post_login()

    # Then: both auth cookies carry the exact declared cookie attributes.
    assert response.status_code == 200
    morsels = _set_cookie_morsels(response)
    assert set(morsels) == {COOKIE_ACCESS, COOKIE_REFRESH}

    for name in (COOKIE_ACCESS, COOKIE_REFRESH):
        morsel = morsels[name]
        assert morsel["path"] == "/api"
        assert morsel["httponly"] is True
        assert morsel["samesite"] == "strict"
        if server.cookie_secure:
            assert morsel["secure"] is True
        else:
            assert morsel["secure"] == ""
