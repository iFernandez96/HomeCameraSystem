"""sqlite-backed user store (iter-178, Auth Plan Phase 1).

Stdlib `sqlite3` only — no SQLAlchemy, no Alembic. The single-table
schema is small enough that hand-written DDL + migration-via-CREATE-IF-
NOT-EXISTS is the right shape; future schema changes can ADD columns
with `ALTER TABLE` and continue using `CREATE IF NOT EXISTS` for fresh
installs.

Connection-per-call rather than a pool: FastAPI's request lifetime is
short enough that spinning a new connection costs ~0.5 ms on the Nano
eMMC, which is dominated by the argon2 verify (~120 ms). The
connection-per-call model also avoids the GIL-style serialization that
would happen if every request waited on a shared cursor. WAL mode is
enabled so reads don't block writes.

Schema (one table, no FKs yet — roles will arrive at iter-211 per the
Per-User Roles feature plan):

    CREATE TABLE users (
        username      TEXT PRIMARY KEY,
        password_hash TEXT NOT NULL,
        role          TEXT NOT NULL DEFAULT 'admin',
        created_at    REAL NOT NULL
    )

`role` is reserved for the iter-211 Owner/Family/Viewer split; today
every seeded user is `admin` and the dependency layer treats that as
"can do everything." Phase 5 of auth (iter-183) gates routes on
authenticated-presence, not role — role checks come later.
"""
from __future__ import annotations

import os
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator


_SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    username      TEXT PRIMARY KEY,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL DEFAULT 'admin',
    created_at    REAL NOT NULL
);
"""

# iter-196 (Feature #3 RBAC vocabulary expansion). The four canonical
# roles, ordered most-privileged first:
#
# - ``owner``  — can do everything, including manage other users
#                and trigger destructive ops (`/api/system/reboot`).
# - ``family`` — can view feeds + manage their own push
#                subscriptions; can't change detection settings or
#                reboot.
# - ``viewer`` — read-only; sees feeds + events but no controls.
# - ``admin``  — kept for backwards compat with iter-178/179 seeded
#                users (and the iter-192 JWT-claim default fallback).
#                Treated semantically as ``owner`` until a future
#                iter migrates the seeded users to the new vocab
#                explicitly.
#
# The vocab is enforced at the wire (route's Pydantic schema) AND
# at the storage layer (`create_user` / `update_role` raise on
# unknown values). Two-tier defense — operator manually editing
# users.db with `sqlite3 users.db "UPDATE users SET role='god'"`
# would bypass the route check, but `update_role` from app code
# still refuses.
ROLE_VOCAB = ("owner", "family", "viewer", "admin")


class InvalidRole(ValueError):
    """Raised by `create_user` / `update_role` when a role isn't in
    `ROLE_VOCAB`. Subclasses ValueError so existing
    `except ValueError` callers still catch it."""


def init_db(path: Path) -> None:
    """Create the users table if missing. Idempotent — safe to call
    on every server boot. Enables WAL mode so reads (`get_user` from
    every authenticated request) don't block writes (`create_user`,
    `update_password`).

    Creates parent directories if needed (mirrors the iter-6 push-subs
    persistence pattern). Mode 0o600 on the file because it stores
    password hashes — even though argon2 hashes aren't reversible, the
    lower the attack surface the better.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    # iter-183: pre-create the file with mode 0o600 BEFORE
    # `sqlite3.connect` opens it, so a default umask of 0o022 (or
    # worse, 0) can't briefly leave the file group/world-readable.
    # Mirrors the iter-178 `jwt_secret._generate_and_write` pattern
    # (`os.open(..., O_CREAT, 0o600)`). Closes the iter-169 Security
    # S1 partial that survived the auth foundation as a Minor S1
    # carry-forward called out in iter-180/181/182 audit notes.
    if not path.exists():
        fd = os.open(path, os.O_CREAT | os.O_RDWR, 0o600)
        os.close(fd)
    with sqlite3.connect(path) as conn:
        conn.execute("PRAGMA journal_mode=WAL")
        conn.executescript(_SCHEMA)
        conn.commit()
    # Belt-and-braces chmod for legacy databases upgraded from a
    # pre-iter-183 install where the file already exists with looser
    # perms. The pre-create above handles fresh installs; this
    # handles in-place upgrades. No-op on read-only mounts.
    try:
        path.chmod(0o600)
    except OSError:
        pass


@contextmanager
def _connect(path: Path) -> Iterator[sqlite3.Connection]:
    """Context manager wrapping sqlite3.connect with row factory set
    so callers get dict-like rows. WAL mode is set in `init_db`; this
    helper assumes the file already exists.
    """
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
    finally:
        conn.close()


def get_user(path: Path, username: str) -> dict | None:
    """Return `{username, password_hash, role, created_at}` for the
    given username, or None if not found. Constant-time at the SQL
    layer (PRIMARY KEY lookup); the timing-oracle defense for
    user-not-found vs wrong-password lives in the route handler at
    Phase 3 (call `verify_password` against a dummy hash on miss).
    """
    with _connect(path) as conn:
        row = conn.execute(
            "SELECT username, password_hash, role, created_at "
            "FROM users WHERE username = ?",
            (username,),
        ).fetchone()
        if row is None:
            return None
        return dict(row)


def create_user(
    path: Path,
    username: str,
    password_hash: str,
    role: str = "admin",
) -> None:
    """Insert a new user. Raises `sqlite3.IntegrityError` on
    duplicate username — caller decides whether to translate that
    into a 409 (HTTP layer) or a non-zero exit (gen_admin script).

    `password_hash` must already be argon2-hashed via
    `passwords.hash_password`. This module does NOT touch raw
    passwords — keeps the single-responsibility boundary clean and
    avoids a future caller accidentally storing plaintext.

    iter-196: `role` validated against `ROLE_VOCAB`. Raises
    `InvalidRole` (subclass of `ValueError`) on unknown role.
    """
    if role not in ROLE_VOCAB:
        raise InvalidRole(
            "role {!r} not in vocab {}".format(role, sorted(ROLE_VOCAB))
        )
    with _connect(path) as conn:
        conn.execute(
            "INSERT INTO users (username, password_hash, role, created_at) "
            "VALUES (?, ?, ?, ?)",
            (username, password_hash, role, time.time()),
        )
        conn.commit()


def update_role(path: Path, username: str, new_role: str) -> bool:
    """Change an existing user's role. Returns True if a row was
    updated, False if the username didn't exist (mirrors
    `update_password` semantics — caller can't tell apart "user
    missing" vs "no change needed" if they pre-check, so the
    return value carries the answer).

    Raises `InvalidRole` on unknown role. iter-196 (Feature #3
    vocabulary expansion).
    """
    if new_role not in ROLE_VOCAB:
        raise InvalidRole(
            "role {!r} not in vocab {}".format(new_role, sorted(ROLE_VOCAB))
        )
    with _connect(path) as conn:
        cur = conn.execute(
            "UPDATE users SET role = ? WHERE username = ?",
            (new_role, username),
        )
        conn.commit()
        return cur.rowcount > 0


def update_password(path: Path, username: str, new_password_hash: str) -> bool:
    """Update an existing user's password hash. Returns True if a row
    was updated, False if the username didn't exist. The caller
    should NOT pre-check existence — this is one round-trip; the
    return value carries the answer.
    """
    with _connect(path) as conn:
        cur = conn.execute(
            "UPDATE users SET password_hash = ? WHERE username = ?",
            (new_password_hash, username),
        )
        conn.commit()
        return cur.rowcount > 0


def count_users(path: Path) -> int:
    """How many users exist. Used by the env-var bootstrap (Phase 2)
    to decide whether to seed: only seed when zero users exist.
    """
    with _connect(path) as conn:
        row = conn.execute("SELECT COUNT(*) AS n FROM users").fetchone()
        return int(row["n"]) if row else 0


def list_users(path: Path) -> list[dict]:
    """iter-264: return every user as
    ``{username, role, created_at}`` — password hashes are NEVER
    included so the wire response (`/api/auth/admin/users`) is safe
    to stream to the owner's UI even over a future caching proxy.

    Stable order: alphabetical by username, so the UI list doesn't
    reshuffle between requests when a row is added.
    """
    with _connect(path) as conn:
        rows = conn.execute(
            "SELECT username, role, created_at "
            "FROM users ORDER BY username ASC"
        ).fetchall()
        return [dict(r) for r in rows]


def delete_user(path: Path, username: str) -> bool:
    """iter-264: delete a user row. Returns True if a row was
    removed, False otherwise. Caller is responsible for guarding
    against deleting the LAST owner / themselves — this is a thin
    SQL wrapper. Idempotent (delete-twice returns False the second
    time, not an error)."""
    with _connect(path) as conn:
        cur = conn.execute("DELETE FROM users WHERE username = ?", (username,))
        conn.commit()
        return cur.rowcount > 0


class CannotDeleteLastOwner(Exception):
    """Raised by `delete_user_atomic` when removing the target row
    would leave the deployment with zero owner-tier accounts. Carries
    the same UX intent as the iter-265 route-side check; lifting the
    check into the SQL transaction closes the iter-266 D race window
    where two owner deletes could each pass a separate check and both
    proceed."""


def delete_user_atomic(path: Path, username: str) -> bool:
    """iter-267 (security-auditor D follow-up): atomic last-owner
    guard. Wraps the COUNT(owners) → DELETE in a single
    ``BEGIN IMMEDIATE`` so two concurrent admin/delete_user POSTs
    can't BOTH read 2 owners, BOTH proceed, and leave 0 owners.

    Semantics:
    - Returns True on successful delete (target existed, last-owner
      check passed).
    - Returns False when the target row didn't exist.
    - Raises ``CannotDeleteLastOwner`` when the target IS an
      owner-tier account AND removing them would drop the
      owner-or-admin count to 0.

    The ``admin`` role is intentionally counted as owner-tier per
    the iter-197 transitional carve-out — a deployment whose ONLY
    owner-tier account is a legacy ``admin`` user must still be
    refused. Drop the carve-out together with `dependencies.require_role`'s
    legacy-admin handling when the eventual cleanup iter migrates
    seeded users.
    """
    with _connect(path) as conn:
        # BEGIN IMMEDIATE acquires the write lock NOW (instead of at
        # the first INSERT/UPDATE), so a parallel transaction blocks
        # at BEGIN rather than racing through the count-then-delete
        # window. SQLite serializes both transactions; the second
        # transaction observes the first transaction's DELETE before
        # running its own COUNT.
        conn.execute("BEGIN IMMEDIATE")
        try:
            row = conn.execute(
                "SELECT role FROM users WHERE username = ?",
                (username,),
            ).fetchone()
            if row is None:
                conn.execute("COMMIT")
                return False
            target_role = row["role"]
            if target_role in ("owner", "admin"):
                count_row = conn.execute(
                    "SELECT COUNT(*) AS n FROM users "
                    "WHERE role IN ('owner', 'admin')"
                ).fetchone()
                if int(count_row["n"]) <= 1:
                    conn.execute("ROLLBACK")
                    raise CannotDeleteLastOwner(
                        "cannot delete the last owner-tier user"
                    )
            conn.execute("DELETE FROM users WHERE username = ?", (username,))
            conn.execute("COMMIT")
            return True
        except CannotDeleteLastOwner:
            raise
        except Exception:
            conn.execute("ROLLBACK")
            raise
