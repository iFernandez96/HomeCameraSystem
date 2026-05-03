"""iter-178 / Auth Plan Phase 1: JWT secret loader tests.

Mirrors the iter-170 VAPID `load_keys` tolerant-disk-load pattern."""
from __future__ import annotations

from app.auth import jwt_secret


def test_load_or_generate_creates_on_first_boot(tmp_path):
    """File doesn't exist — `load_or_generate` mints one, persists
    it, returns the bytes."""
    path = tmp_path / "jwt_secret.bin"
    assert not path.exists()
    secret = jwt_secret.load_or_generate(path)
    assert path.exists()
    assert len(secret) == 32
    assert isinstance(secret, bytes)
    # File must contain the same bytes that were returned.
    assert path.read_bytes() == secret


def test_load_or_generate_persists_across_calls(tmp_path):
    """Second call on the same path returns the SAME bytes — no
    re-generation. This is what happens on every server boot
    after the first."""
    path = tmp_path / "jwt_secret.bin"
    first = jwt_secret.load_or_generate(path)
    second = jwt_secret.load_or_generate(path)
    assert first == second


def test_load_or_generate_regenerates_on_wrong_size(tmp_path, caplog):
    """Truncated / corrupted file (wrong size) → regenerate, log
    warning, return fresh bytes."""
    path = tmp_path / "jwt_secret.bin"
    path.write_bytes(b"truncated")  # 9 bytes, wrong
    with caplog.at_level("WARNING"):
        secret = jwt_secret.load_or_generate(path)
    assert len(secret) == 32
    assert path.read_bytes() == secret
    assert any(
        "wrong size" in r.message and "regenerating" in r.message
        for r in caplog.records
    )


def test_load_or_generate_creates_parent_dirs(tmp_path):
    """Parent dir doesn't exist → mkdir + create file. Mirrors the
    iter-6 push_subs persistence pattern."""
    path = tmp_path / "nested" / "secrets" / "jwt_secret.bin"
    assert not path.parent.exists()
    secret = jwt_secret.load_or_generate(path)
    assert path.exists()
    assert len(secret) == 32


def test_generated_file_is_mode_0o600(tmp_path):
    """File mode after generation is 0o600 (owner read+write only).
    Critical: this is a signing secret. Set BEFORE the rename to
    avoid the iter-169 Security S1 chmod-after-replace race."""
    path = tmp_path / "jwt_secret.bin"
    jwt_secret.load_or_generate(path)
    mode = path.stat().st_mode & 0o777
    assert mode & 0o077 == 0, (
        "JWT secret file mode {:o} grants group/other access".format(mode)
    )


def test_load_or_generate_handles_unreadable_file(tmp_path, caplog):
    """File exists but unreadable (permission flip) → regenerate
    fresh, log warning. Tests have to skip-on-root since chmod
    0o000 doesn't restrict root."""
    import os
    path = tmp_path / "jwt_secret.bin"
    path.write_bytes(b"x" * 32)
    path.chmod(0o000)
    if os.geteuid() == 0:
        path.chmod(0o600)
        import pytest
        pytest.skip("test runs as root; chmod 0o000 doesn't restrict it")
    try:
        with caplog.at_level("WARNING"):
            secret = jwt_secret.load_or_generate(path)
        assert len(secret) == 32
        # Warning logged about the unreadable file.
        assert any(
            "unreadable" in r.message and "regenerating" in r.message
            for r in caplog.records
        )
    finally:
        # Restore for tmp_path cleanup.
        try:
            path.chmod(0o600)
        except OSError:
            pass


def test_returns_in_memory_on_unwritable_dir(tmp_path, caplog):
    """If the parent dir is unwritable (volume mount weirdness),
    return an in-memory-only secret — log a warning, but the
    server still boots. Tokens issued during this session won't
    survive a restart but auth still works for now."""
    import os
    parent = tmp_path / "ro_dir"
    parent.mkdir()
    parent.chmod(0o500)  # r-x — can't create files
    path = parent / "jwt_secret.bin"
    if os.geteuid() == 0:
        parent.chmod(0o700)
        import pytest
        pytest.skip("test runs as root; chmod 0o500 doesn't restrict it")
    try:
        with caplog.at_level("WARNING"):
            secret = jwt_secret.load_or_generate(path)
        # Got bytes regardless.
        assert len(secret) == 32
        # File doesn't exist (couldn't create it).
        assert not path.exists()
        # Warning logged.
        assert any(
            "write to" in r.message and "failed" in r.message
            for r in caplog.records
        )
    finally:
        parent.chmod(0o700)
