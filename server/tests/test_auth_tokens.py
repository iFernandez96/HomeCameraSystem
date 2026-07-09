"""JWT issue + decode (iter-181, Auth Plan Phase 3)."""
from __future__ import annotations

import time

import pytest

from app.auth import tokens
from app.config import settings


@pytest.fixture(autouse=True)
def _isolate_secret(tmp_path, monkeypatch):
    """Fresh JWT secret per test. Prevents one test's tokens from
    decoding under another test's secret when they share a process —
    ``tokens._get_secret()`` reads from ``settings.jwt_secret_path``
    on every call (no caching) so monkeypatching the path before
    each test gives clean isolation."""
    monkeypatch.setattr(settings, "jwt_secret_path", tmp_path / "jwt.bin")
    yield


def test_issue_access_has_expected_claims():
    # Use real `time.time()` so the token isn't already expired by
    # the time `decode` runs the exp check.
    now = time.time()
    token = tokens.issue("alice", "access", now=now)
    claims = tokens.decode(token, kind="access")
    assert claims["sub"] == "alice"
    assert claims["kind"] == "access"
    assert claims["iat"] == int(now)
    assert claims["exp"] == int(now) + settings.access_token_ttl_s


def test_issue_refresh_has_expected_claims():
    now = time.time()
    token = tokens.issue("bob", "refresh", now=now)
    claims = tokens.decode(token, kind="refresh")
    assert claims["sub"] == "bob"
    assert claims["kind"] == "refresh"
    assert claims["exp"] == int(now) + settings.refresh_token_ttl_s


def test_issue_embeds_jti():
    token = tokens.issue("alice", "access")
    claims = tokens.decode(token, kind="access")
    assert isinstance(claims["jti"], str)
    assert claims["jti"]


def test_issue_jti_is_unique_per_call():
    first = tokens.decode(tokens.issue("alice", "access"), kind="access")
    second = tokens.decode(tokens.issue("alice", "access"), kind="access")
    assert first["jti"] != second["jti"]


def test_issue_accepts_explicit_jti():
    token = tokens.issue("alice", "access", jti="abc")
    claims = tokens.decode(token, kind="access")
    assert claims["jti"] == "abc"


def test_decode_returns_jti():
    token = tokens.issue("alice", "refresh", jti="refresh123")
    claims = tokens.decode(token, kind="refresh")
    assert claims["jti"] == "refresh123"


def test_decode_round_trip_preserves_sub():
    token = tokens.issue("alice", "access")
    claims = tokens.decode(token, kind="access")
    assert claims["sub"] == "alice"


def test_decode_rejects_kind_mismatch_refresh_in_access_slot():
    """A refresh token presented as access must NOT decode — the
    ``kind`` claim is the only thing pinning the access/refresh
    boundary, so this is the load-bearing check."""
    token = tokens.issue("alice", "refresh")
    with pytest.raises(tokens.InvalidToken):
        tokens.decode(token, kind="access")


def test_decode_rejects_kind_mismatch_access_in_refresh_slot():
    token = tokens.issue("alice", "access")
    with pytest.raises(tokens.InvalidToken):
        tokens.decode(token, kind="refresh")


def test_decode_rejects_expired_token():
    """Token issued well in the past expires before ``decode`` runs."""
    long_ago = time.time() - settings.access_token_ttl_s - 60
    token = tokens.issue("alice", "access", now=long_ago)
    with pytest.raises(tokens.InvalidToken):
        tokens.decode(token, kind="access")


def test_decode_rejects_garbage():
    with pytest.raises(tokens.InvalidToken):
        tokens.decode("not.a.jwt", kind="access")


def test_decode_rejects_empty_string():
    with pytest.raises(tokens.InvalidToken):
        tokens.decode("", kind="access")


def test_decode_rejects_token_signed_with_different_secret(tmp_path, monkeypatch):
    """Mint under one secret, point ``settings.jwt_secret_path`` at a
    different (auto-generated) one, decode → ``InvalidToken``. This
    is the ``rm jwt_secret.bin && restart`` hard-logout escape hatch
    documented in ``auth_plan_iter177.md``."""
    token = tokens.issue("alice", "access")
    monkeypatch.setattr(settings, "jwt_secret_path", tmp_path / "different.bin")
    with pytest.raises(tokens.InvalidToken):
        tokens.decode(token, kind="access")


def test_issue_unknown_kind_raises_value_error():
    with pytest.raises(ValueError):
        tokens.issue("alice", "wrong-kind")  # type: ignore[arg-type]


# --- iter-192 (Feature #3 RBAC foundation): role claim ---------------------


def test_issue_includes_default_role_claim():
    """Default role is `admin` — every seeded user pre-iter-192 was
    admin, so backwards-compatible default."""
    token = tokens.issue("alice", "access")
    claims = tokens.decode(token, kind="access")
    assert claims["role"] == "admin"


def test_issue_passes_through_explicit_role():
    """Login route reads role from users_db row and threads it in."""
    token = tokens.issue("alice", "access", role="owner")
    claims = tokens.decode(token, kind="access")
    assert claims["role"] == "owner"


def test_issue_role_round_trips_for_refresh_kind():
    """Refresh tokens carry role too — Phase 5 hard cutover means the
    refresh path also needs to mint role-tagged access cookies."""
    token = tokens.issue("alice", "refresh", role="family")
    claims = tokens.decode(token, kind="refresh")
    assert claims["role"] == "family"
