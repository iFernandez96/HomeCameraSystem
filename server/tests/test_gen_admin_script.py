"""iter-179 / Auth Plan Phase 2: gen_admin script tests."""
from __future__ import annotations

import io

import pytest

from app.auth import users_db
from app.scripts import gen_admin


def _stub_prompt(values: list[str]):
    """Returns a `prompt(label) -> str` that pops sequentially
    through `values`. Mimics getpass without TTY interaction."""
    iterator = iter(values)

    def prompt(_label: str) -> str:
        return next(iterator)

    return prompt


def test_creates_user_in_db(tmp_path, monkeypatch):
    """Happy path: prompt twice with matching password, user lands
    in the DB with the least-privilege default role (security audit
    C1 flipped the omitted --role default from admin to viewer)."""
    db = tmp_path / "users.db"
    monkeypatch.setattr(
        gen_admin, "_read_password",
        lambda prompt=None: "hunter2",
    )
    code = gen_admin.main(["alice", "--db", str(db)])
    assert code == 0
    user = users_db.get_user(db, "alice")
    assert user is not None
    assert user["role"] == "viewer"
    assert user["password_hash"].startswith("$argon2id$")


def test_password_mismatch_returns_2(tmp_path, monkeypatch, capsys):
    """First prompt is 'pw1', confirm is 'pw2' — exit code 2,
    nothing in DB. Script exits before init_db, so the DB file
    is never created."""
    db = tmp_path / "users.db"
    monkeypatch.setattr(
        gen_admin.getpass, "getpass",
        _stub_prompt(["typed-it-once", "typed-it-different"]),
    )
    code = gen_admin.main(["alice", "--db", str(db)])
    assert code == 2
    # DB file never created — early-exit before init_db.
    assert not db.exists()
    err = capsys.readouterr().err
    assert "don't match" in err


def test_empty_password_returns_2(tmp_path, monkeypatch):
    """Empty password is rejected — exit code 2 (caller surfaces
    via stderr message). Script exits before init_db."""
    db = tmp_path / "users.db"
    monkeypatch.setattr(
        gen_admin.getpass, "getpass",
        _stub_prompt(["", ""]),
    )
    code = gen_admin.main(["alice", "--db", str(db)])
    assert code == 2
    assert not db.exists()


def test_duplicate_username_returns_1(tmp_path, monkeypatch, capsys):
    """User already exists → exit code 1, helpful stderr message."""
    db = tmp_path / "users.db"
    users_db.init_db(db)
    users_db.create_user(db, "alice", "$argon2id$existing")
    monkeypatch.setattr(
        gen_admin, "_read_password",
        lambda prompt=None: "hunter2",
    )
    code = gen_admin.main(["alice", "--db", str(db)])
    assert code == 1
    err = capsys.readouterr().err
    assert "already exists" in err


def test_hash_only_dumps_to_stdout_without_db(tmp_path, monkeypatch, capsys):
    """`--hash-only` skips the DB entirely, prints argon2 hash to
    stdout. Used to populate HOMECAM_ADMIN_PASSWORD_HASH for
    first-boot env seeding."""
    db = tmp_path / "users.db"
    monkeypatch.setattr(
        gen_admin, "_read_password",
        lambda prompt=None: "hunter2",
    )
    code = gen_admin.main(["--hash-only", "--db", str(db)])
    assert code == 0
    out = capsys.readouterr().out.strip()
    assert out.startswith("$argon2id$")
    # DB was never created — `--hash-only` is dump-only.
    assert not db.exists()


def test_username_required_unless_hash_only(tmp_path, capsys):
    """Without --hash-only, username is required. argparse exits 2."""
    db = tmp_path / "users.db"
    with pytest.raises(SystemExit) as exc:
        gen_admin.main(["--db", str(db)])
    # argparse uses exit code 2 for argument errors.
    assert exc.value.code == 2


def test_hash_only_does_not_require_username(tmp_path, monkeypatch):
    """`--hash-only` without a username is valid (operator just
    wants the hash for env-seeding)."""
    monkeypatch.setattr(
        gen_admin, "_read_password",
        lambda prompt=None: "hunter2",
    )
    code = gen_admin.main(["--hash-only"])
    assert code == 0


# --- iter-196 (Feature #3 vocab: --role flag) ---


def test_role_flag_creates_user_with_specified_role(tmp_path, monkeypatch):
    """`--role=owner` sets the row's role column to owner."""
    db = tmp_path / "users.db"
    monkeypatch.setattr(
        gen_admin, "_read_password",
        lambda prompt=None: "hunter2",
    )
    code = gen_admin.main(["alice", "--role", "owner", "--db", str(db)])
    assert code == 0
    user = users_db.get_user(db, "alice")
    assert user is not None
    assert user["role"] == "owner"


def test_role_flag_defaults_to_viewer_least_privilege(tmp_path, monkeypatch):
    """No `--role` arg → role defaults to viewer (security audit C1,
    commit 745be93). Pre-fix the omitted flag silently minted an
    admin-equivalent-of-owner account; the operator must now opt IN
    to elevated roles via --role=owner/family."""
    db = tmp_path / "users.db"
    monkeypatch.setattr(
        gen_admin, "_read_password",
        lambda prompt=None: "hunter2",
    )
    code = gen_admin.main(["alice", "--db", str(db)])
    assert code == 0
    assert users_db.get_user(db, "alice")["role"] == "viewer"


def test_role_flag_rejects_unknown_value_via_argparse(tmp_path):
    """argparse `choices=ROLE_VOCAB` rejects bogus roles before
    the script touches the DB. argparse exits 2 on choice error."""
    db = tmp_path / "users.db"
    with pytest.raises(SystemExit) as exc:
        gen_admin.main(["alice", "--role", "god", "--db", str(db)])
    assert exc.value.code == 2
    assert not db.exists()


def test_role_flag_accepts_each_canonical_role(tmp_path, monkeypatch):
    monkeypatch.setattr(
        gen_admin, "_read_password",
        lambda prompt=None: "hunter2",
    )
    for i, role in enumerate(users_db.ROLE_VOCAB):
        db = tmp_path / "users-{}.db".format(i)
        code = gen_admin.main(
            ["u{}".format(i), "--role", role, "--db", str(db)]
        )
        assert code == 0
        assert users_db.get_user(db, "u{}".format(i))["role"] == role
