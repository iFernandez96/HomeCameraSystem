"""iter-179 / Auth Plan Phase 2: env-var first-boot bootstrap tests."""
from __future__ import annotations

from app.auth import bootstrap, passwords, users_db


def test_seeds_admin_when_db_empty_and_env_set(tmp_path):
    """Empty users.db + both env vars present → user inserted, returns True."""
    db = tmp_path / "users.db"
    pw_hash = passwords.hash_password("hunter2")
    inserted = bootstrap.seed_from_env_if_empty(db, "alice", pw_hash)
    assert inserted is True
    user = users_db.get_user(db, "alice")
    assert user is not None
    assert user["role"] == "admin"
    assert user["password_hash"] == pw_hash


def test_no_op_when_db_already_has_users(tmp_path, caplog):
    """Pre-existing user → seed is a no-op (the env var would
    overwrite an operator-managed user otherwise)."""
    db = tmp_path / "users.db"
    users_db.init_db(db)
    users_db.create_user(db, "alice", "$argon2id$existing")
    pw_hash = passwords.hash_password("different")
    with caplog.at_level("DEBUG"):
        inserted = bootstrap.seed_from_env_if_empty(db, "bob", pw_hash)
    assert inserted is False
    # Original alice is untouched.
    alice = users_db.get_user(db, "alice")
    assert alice is not None
    assert alice["password_hash"] == "$argon2id$existing"
    # Bob was NOT inserted.
    assert users_db.get_user(db, "bob") is None


def test_no_op_when_env_user_missing(tmp_path):
    """Empty username env → no-op, returns False. Server boots
    user-less; operator runs gen_admin later."""
    db = tmp_path / "users.db"
    pw_hash = passwords.hash_password("hunter2")
    inserted = bootstrap.seed_from_env_if_empty(db, "", pw_hash)
    assert inserted is False
    assert users_db.count_users(db) == 0


def test_no_op_when_env_hash_missing(tmp_path):
    """Empty password_hash env → no-op, returns False."""
    db = tmp_path / "users.db"
    inserted = bootstrap.seed_from_env_if_empty(db, "alice", "")
    assert inserted is False
    assert users_db.count_users(db) == 0


def test_refuses_to_seed_plaintext_password_in_env(tmp_path, caplog):
    """The hash env var should contain a self-describing argon2 hash
    string (`$argon2id$...`). If it doesn't, the operator probably
    put plaintext there. Refuse and log a loud warning rather than
    storing the wrong thing — even though the result of attempting
    to verify against a non-argon2 hash would be 'auth failed' (per
    `passwords.verify_password`), seeding garbage into the DB
    masks the operator's mistake."""
    db = tmp_path / "users.db"
    with caplog.at_level("WARNING"):
        inserted = bootstrap.seed_from_env_if_empty(
            db, "alice", "this-looks-like-plaintext"
        )
    assert inserted is False
    assert users_db.count_users(db) == 0
    assert any(
        "argon2" in r.message and "Refusing" in r.message
        for r in caplog.records
    )


def test_seed_creates_db_and_parent_dirs(tmp_path):
    """Bootstrap on a non-existent DB path must create both the
    parent directories AND the schema (`init_db` call)."""
    db = tmp_path / "nested" / "secrets" / "users.db"
    assert not db.exists()
    pw_hash = passwords.hash_password("hunter2")
    bootstrap.seed_from_env_if_empty(db, "alice", pw_hash)
    assert db.exists()


def test_seed_is_idempotent_on_repeat_calls(tmp_path):
    """Two calls in a row with the same env: first inserts, second
    no-ops because the table now has a row. No exception, no double
    insert."""
    db = tmp_path / "users.db"
    pw_hash = passwords.hash_password("hunter2")
    assert bootstrap.seed_from_env_if_empty(db, "alice", pw_hash) is True
    assert bootstrap.seed_from_env_if_empty(db, "alice", pw_hash) is False
    assert users_db.count_users(db) == 1
