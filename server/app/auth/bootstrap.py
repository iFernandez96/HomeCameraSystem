"""First-boot admin-user seed (iter-179, Auth Plan Phase 2).

Wired into the FastAPI lifespan. On every server start:

1. Ensure the users.db schema exists (`init_db`).
2. If the users table is EMPTY AND both `HOMECAM_ADMIN_USER` and
   `HOMECAM_ADMIN_PASSWORD_HASH` env vars are set: insert one row
   with role='admin'.
3. If the users table is non-empty: no-op (operator-managed users
   take precedence).
4. If env vars are missing: no-op (server starts user-less; operator
   will run `gen_admin` later).

The seed is a one-shot — once a user exists, removing the env vars
or restarting won't change anything. To re-seed, the operator must
either delete the users.db file (`rm /app/secrets/users.db`) or
clear the table via sqlite shell.

The PASSWORD_HASH is argon2id-pre-hashed, NOT plaintext. Operator
generates it once via `gen_admin` (which can dump-only) or:

    python -c "from app.auth.passwords import hash_password; print(hash_password('your-password'))"

The plaintext never lands in env files / compose configs / journals.
This is an explicit anti-anti-recommendation: storing a hash in env is
fine because hashes are non-reversible; storing plaintext would be
the violation.
"""
from __future__ import annotations

import logging
from pathlib import Path

from . import users_db


log = logging.getLogger(__name__)


def seed_from_env_if_empty(
    db_path: Path,
    admin_user: str,
    admin_password_hash: str,
) -> bool:
    """Idempotent seed. Returns True iff a user was inserted.

    Caller (lifespan) supplies the env values explicitly so this
    function is testable without monkey-patching `os.environ`.
    """
    # Schema must exist before count_users can read.
    users_db.init_db(db_path)
    existing = users_db.count_users(db_path)
    if existing > 0:
        log.debug(
            "users.db already has %d user(s); skipping env-seed",
            existing,
        )
        return False
    if not admin_user or not admin_password_hash:
        log.info(
            "users.db is empty and HOMECAM_ADMIN_USER/_PASSWORD_HASH not set "
            "— skipping env-seed. Run `python -m app.scripts.gen_admin <user>` "
            "to create the first admin."
        )
        return False
    if not admin_password_hash.startswith("$argon2"):
        # Strong hint that plaintext was put in the env var. Refuse.
        # The hash is non-reversible; we don't validate it further
        # (a malformed argon2 string would simply fail on the first
        # login attempt).
        log.warning(
            "HOMECAM_ADMIN_PASSWORD_HASH does not look like an argon2 "
            "hash (no `$argon2` prefix). Refusing to seed — generate the "
            "hash via `python -m app.scripts.gen_admin --hash-only` or "
            "`hash_password()` instead of putting plaintext in env."
        )
        return False
    users_db.create_user(
        db_path,
        admin_user,
        admin_password_hash,
        role="admin",
    )
    log.info(
        "seeded admin user %r from HOMECAM_ADMIN_USER env (one-time, "
        "future restarts no-op)",
        admin_user,
    )
    return True
