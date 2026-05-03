"""iter-178 / Auth Plan Phase 1: argon2 password-hashing tests."""
from __future__ import annotations

from app.auth import passwords


def test_hash_format_is_argon2id():
    """argon2-cffi produces self-describing strings starting with
    `$argon2id$v=19$...`. Future param changes don't break old
    hashes because the params are stored in the string itself."""
    h = passwords.hash_password("hunter2")
    assert h.startswith("$argon2id$"), (
        "hash should start with `$argon2id$`; got {!r}".format(h[:30])
    )
    # Embedded params must reflect the Jetson-tuned defaults.
    assert "m=65536" in h, "memory_cost should be 64 MB"
    assert "t=2" in h, "time_cost should be 2"
    assert "p=2" in h, "parallelism should match Nano's 2 cores"


def test_hash_then_verify_round_trip():
    """Right password verifies True."""
    h = passwords.hash_password("hunter2")
    assert passwords.verify_password("hunter2", h) is True


def test_verify_wrong_password_returns_false():
    """Wrong password returns False, doesn't raise."""
    h = passwords.hash_password("hunter2")
    assert passwords.verify_password("wrong", h) is False


def test_verify_malformed_hash_returns_false():
    """Corrupt or non-argon2 hash strings return False (don't
    raise). The route handler should treat False as "auth
    failed" — no need to differentiate corrupt-hash from
    wrong-password."""
    assert passwords.verify_password("anything", "not-a-real-hash") is False
    assert passwords.verify_password("anything", "") is False


def test_hashes_use_random_salt():
    """Hashing the same password twice produces different output
    (different salts). Without per-call salt, identical passwords
    would hash identically — leaking equality across users."""
    h1 = passwords.hash_password("samepw")
    h2 = passwords.hash_password("samepw")
    assert h1 != h2


def test_dummy_hash_returns_constant():
    """The pre-computed dummy hash is the same across calls — used
    by Phase 3 to verify against on user-not-found, defeating the
    timing-oracle that would otherwise distinguish wrong-user from
    wrong-password."""
    d1 = passwords.dummy_hash()
    d2 = passwords.dummy_hash()
    assert d1 == d2
    assert d1.startswith("$argon2id$")


def test_dummy_hash_does_not_match_real_passwords():
    """Sanity check: the dummy hash is unguessable. No reasonable
    plaintext should verify against it."""
    dummy = passwords.dummy_hash()
    assert passwords.verify_password("password", dummy) is False
    assert passwords.verify_password("admin", dummy) is False
    assert passwords.verify_password("", dummy) is False


def test_needs_rehash_false_for_current_params():
    """A hash freshly generated with the current hasher params
    doesn't need rehashing."""
    h = passwords.hash_password("hunter2")
    assert passwords.needs_rehash(h) is False
