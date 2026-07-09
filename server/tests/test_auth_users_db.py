"""iter-178 / Auth Plan Phase 1: sqlite users-store tests.

Each test points the store at `tmp_path` so there's no cross-test
state. Tests cover the four public functions (`init_db`, `get_user`,
`create_user`, `update_password`) plus the `count_users` helper that
the Phase 2 bootstrap will use.
"""
from __future__ import annotations

import sqlite3
import stat

import pytest

from app.auth import users_db


def test_init_db_creates_file(tmp_path):
    """First-boot: the file doesn't exist; `init_db` creates it +
    parent dirs + sets mode 0o600."""
    nested = tmp_path / "nested" / "secrets" / "users.db"
    assert not nested.exists()
    users_db.init_db(nested)
    assert nested.exists()
    # Mode 0o600 — owner read+write only. (Skip on systems where
    # chmod is no-op, e.g. some Docker layers; assert via a mask
    # so a more-restrictive umask still passes.)
    mode = nested.stat().st_mode & 0o777
    assert mode & 0o077 == 0, (
        "users.db file mode {:o} grants group/other access".format(mode)
    )


def test_init_db_idempotent(tmp_path):
    """Calling `init_db` twice on the same path must not error and
    must not wipe existing data."""
    db = tmp_path / "users.db"
    users_db.init_db(db)
    users_db.create_user(db, "alice", "$argon2id$dummy", role="admin")
    # Re-init should be a no-op for existing schemas.
    users_db.init_db(db)
    user = users_db.get_user(db, "alice")
    assert user is not None
    assert user["username"] == "alice"


def test_create_and_get_round_trip(tmp_path):
    """Insert a user, look it up by username — fields round-trip
    including the role default."""
    db = tmp_path / "users.db"
    users_db.init_db(db)
    users_db.create_user(db, "alice", "$argon2id$hash-1")
    users_db.create_user(db, "bob", "$argon2id$hash-2", role="admin")
    a = users_db.get_user(db, "alice")
    assert a is not None
    assert a["username"] == "alice"
    assert a["password_hash"] == "$argon2id$hash-1"
    assert a["role"] == "admin"
    assert a["created_at"] > 0
    b = users_db.get_user(db, "bob")
    assert b is not None
    assert b["password_hash"] == "$argon2id$hash-2"


def test_get_user_returns_none_for_missing(tmp_path):
    """Lookups on missing usernames return None (not raise) — the
    timing-oracle defense in Phase 3 expects a falsy return value
    rather than an exception."""
    db = tmp_path / "users.db"
    users_db.init_db(db)
    assert users_db.get_user(db, "nonexistent") is None


def test_create_user_rejects_duplicate(tmp_path):
    """sqlite PRIMARY KEY constraint — duplicate username raises
    `IntegrityError`. The route handler / `gen_admin` script
    translates this into 409 / non-zero exit respectively."""
    db = tmp_path / "users.db"
    users_db.init_db(db)
    users_db.create_user(db, "alice", "$argon2id$h1")
    with pytest.raises(sqlite3.IntegrityError):
        users_db.create_user(db, "alice", "$argon2id$h2")


def test_update_password_changes_hash(tmp_path):
    """Update returns True, subsequent get returns the new hash."""
    db = tmp_path / "users.db"
    users_db.init_db(db)
    users_db.create_user(db, "alice", "$argon2id$old")
    assert users_db.update_password(db, "alice", "$argon2id$new") is True
    user = users_db.get_user(db, "alice")
    assert user is not None
    assert user["password_hash"] == "$argon2id$new"


def test_update_password_returns_false_for_unknown_user(tmp_path):
    """Update on missing username returns False — no row touched,
    no exception. Caller decides UX; Phase 3 may surface 404."""
    db = tmp_path / "users.db"
    users_db.init_db(db)
    assert users_db.update_password(db, "ghost", "$argon2id$hash") is False


def test_count_users(tmp_path):
    """Empty / one / two users — `count_users` returns the
    expected integer. Used by the Phase 2 env-seed bootstrap to
    decide whether to seed."""
    db = tmp_path / "users.db"
    users_db.init_db(db)
    assert users_db.count_users(db) == 0
    users_db.create_user(db, "alice", "$argon2id$h1")
    assert users_db.count_users(db) == 1
    users_db.create_user(db, "bob", "$argon2id$h2")
    assert users_db.count_users(db) == 2


def test_init_db_creates_file_with_0o600_even_under_loose_umask(tmp_path):
    """iter-183: pre-create with mode 0o600 BEFORE `sqlite3.connect`
    opens the file, so a loose umask can't briefly leave the file
    group/world-readable.

    Pre-fix path: sqlite3.connect creates with 0o666 (under umask=0),
    then init_db chmods to 0o600 — race window where any process can
    read. Post-fix: file is created mode 0o600 atomically via
    os.open BEFORE sqlite touches it.

    Mechanics: set umask to 0 so default file creation would yield
    0o666; assert init_db's file is still 0o600.
    """
    import os
    db = tmp_path / "users.db"
    old_umask = os.umask(0)
    try:
        users_db.init_db(db)
    finally:
        os.umask(old_umask)
    mode = db.stat().st_mode & 0o777
    assert mode == 0o600, (
        "init_db produced mode {:o}; expected 0o600 even under "
        "loose umask (iter-183 chmod-after-create race fix)".format(mode)
    )


# --- iter-196 (Feature #3 RBAC vocabulary expansion) ---


def test_role_vocab_contains_owner_family_viewer_admin():
    """Pin the canonical 4-role vocabulary. `admin` retained for
    backwards-compat with iter-178/179 seeded users."""
    assert set(users_db.ROLE_VOCAB) == {"owner", "family", "viewer", "admin"}


def test_create_user_rejects_unknown_role(tmp_path):
    db = tmp_path / "users.db"
    users_db.init_db(db)
    with pytest.raises(users_db.InvalidRole):
        users_db.create_user(db, "alice", "$argon2id$h", role="god")


def test_invalid_role_subclasses_value_error(tmp_path):
    """`InvalidRole` is a `ValueError` so existing
    `except ValueError` callers (e.g. argparse / scripts) still
    catch it."""
    db = tmp_path / "users.db"
    users_db.init_db(db)
    with pytest.raises(ValueError):
        users_db.create_user(db, "alice", "$argon2id$h", role="god")


def test_create_user_accepts_each_canonical_role(tmp_path):
    db = tmp_path / "users.db"
    users_db.init_db(db)
    for i, role in enumerate(users_db.ROLE_VOCAB):
        users_db.create_user(db, "u{}".format(i), "$argon2id$h", role=role)
    rows = [users_db.get_user(db, "u{}".format(i)) for i in range(len(users_db.ROLE_VOCAB))]
    assert [r["role"] for r in rows] == list(users_db.ROLE_VOCAB)


def test_update_role_round_trips(tmp_path):
    db = tmp_path / "users.db"
    users_db.init_db(db)
    users_db.create_user(db, "alice", "$argon2id$h", role="family")
    assert users_db.update_role(db, "alice", "owner") is True
    assert users_db.get_user(db, "alice")["role"] == "owner"


def test_update_role_returns_false_for_unknown_user(tmp_path):
    db = tmp_path / "users.db"
    users_db.init_db(db)
    assert users_db.update_role(db, "ghost", "viewer") is False


def test_update_role_rejects_unknown_role(tmp_path):
    db = tmp_path / "users.db"
    users_db.init_db(db)
    users_db.create_user(db, "alice", "$argon2id$h", role="owner")
    with pytest.raises(users_db.InvalidRole):
        users_db.update_role(db, "alice", "superuser")
    # Original role unchanged.
    assert users_db.get_user(db, "alice")["role"] == "owner"


def test_init_db_enables_wal(tmp_path):
    """WAL mode on so reads (every authenticated request hits
    `get_user`) don't block writes. PRAGMA journal_mode must
    return 'wal' (case-insensitive)."""
    db = tmp_path / "users.db"
    users_db.init_db(db)
    with sqlite3.connect(db) as conn:
        mode = conn.execute("PRAGMA journal_mode").fetchone()[0]
    assert mode.lower() == "wal"


# iter-267 (security-auditor D follow-up): atomic last-owner guard.
# BDD-lite: name encodes Given/When/Then; body is AAA-shaped.

def test_given_two_owners_when_atomic_delete_one_then_refused(tmp_path):
    # 2026-07-09 policy ("users shouldn't be able to delete admin"):
    # owner/admin accounts are protected even when OTHER owners exist —
    # not just the last one. Deleting either owner is refused.

    # arrange
    db = tmp_path / "users.db"
    users_db.init_db(db)
    users_db.create_user(db, "owner1", "$argon2id$h1", role="owner")
    users_db.create_user(db, "owner2", "$argon2id$h2", role="owner")

    # act + assert
    with pytest.raises(users_db.CannotDeletePrivilegedUser):
        users_db.delete_user_atomic(db, "owner2")
    # Both rows survive the refused delete.
    assert users_db.get_user(db, "owner2") is not None
    assert users_db.get_user(db, "owner1") is not None


def test_given_one_owner_when_atomic_delete_them_then_refused(tmp_path):
    # arrange
    db = tmp_path / "users.db"
    users_db.init_db(db)
    users_db.create_user(db, "soleowner", "$argon2id$h", role="owner")
    users_db.create_user(db, "kid", "$argon2id$h2", role="family")

    # act + assert — an owner is un-deletable via the API.
    with pytest.raises(users_db.CannotDeletePrivilegedUser):
        users_db.delete_user_atomic(db, "soleowner")
    # Row STILL exists post-rollback.
    assert users_db.get_user(db, "soleowner") is not None


def test_given_legacy_admin_when_atomic_delete_then_refused(tmp_path):
    # iter-197 transitional carve-out: a legacy `admin` account is
    # owner-tier, so the 2026-07-09 protect-privileged policy refuses to
    # delete it. Drop this test together with the carve-out.

    # arrange
    db = tmp_path / "users.db"
    users_db.init_db(db)
    users_db.create_user(db, "legacy", "$argon2id$h", role="admin")
    users_db.create_user(db, "kid", "$argon2id$h2", role="family")

    # act + assert
    with pytest.raises(users_db.CannotDeletePrivilegedUser):
        users_db.delete_user_atomic(db, "legacy")
    assert users_db.get_user(db, "legacy") is not None


def test_given_unknown_user_when_atomic_delete_then_returns_false(tmp_path):
    # arrange
    db = tmp_path / "users.db"
    users_db.init_db(db)
    users_db.create_user(db, "alice", "$argon2id$h", role="owner")

    # act
    result = users_db.delete_user_atomic(db, "ghost")

    # assert: returns False (no row), does NOT raise.
    assert result is False
    # Owner row untouched.
    assert users_db.get_user(db, "alice") is not None


def test_given_non_owner_user_when_atomic_delete_then_no_owner_check(tmp_path):
    # arrange: ONE owner + one family member. Deleting the family
    # member must NOT raise CannotDeleteLastOwner — the owner-count
    # check only fires when the TARGET is owner-tier.
    db = tmp_path / "users.db"
    users_db.init_db(db)
    users_db.create_user(db, "soleowner", "$argon2id$h", role="owner")
    users_db.create_user(db, "kid", "$argon2id$h2", role="family")

    # act
    result = users_db.delete_user_atomic(db, "kid")

    # assert
    assert result is True
    assert users_db.get_user(db, "kid") is None
    assert users_db.get_user(db, "soleowner") is not None


def test_given_concurrent_owner_deletes_when_both_run_then_both_refused(
    tmp_path,
):
    # 2026-07-09 policy: owner/admin accounts are un-deletable, so two
    # parallel owner-delete attempts BOTH fail — zero succeed, both rows
    # survive. (Under the old last-owner guard exactly one would have
    # succeeded; now neither can.)
    import threading

    db = tmp_path / "users.db"
    users_db.init_db(db)
    users_db.create_user(db, "owner1", "$argon2id$h1", role="owner")
    users_db.create_user(db, "owner2", "$argon2id$h2", role="owner")

    results: list[object] = []
    errors: list[Exception] = []

    def worker(target):
        try:
            results.append(users_db.delete_user_atomic(db, target))
        except users_db.CannotDeletePrivilegedUser as e:
            errors.append(e)

    t1 = threading.Thread(target=worker, args=("owner1",))
    t2 = threading.Thread(target=worker, args=("owner2",))
    t1.start()
    t2.start()
    t1.join()
    t2.join()

    # assert: neither delete succeeded; both were refused; both rows remain.
    succeeded = sum(1 for r in results if r is True)
    assert succeeded == 0, f"expected 0 successes, got {succeeded} ({results})"
    assert len(errors) == 2, f"expected 2 refusals, got {len(errors)}"
    rows = users_db.list_users(db)
    assert len([r for r in rows if r["role"] == "owner"]) == 2
