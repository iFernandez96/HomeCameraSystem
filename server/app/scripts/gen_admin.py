"""Interactive admin-user creation script (iter-179, Auth Plan Phase 2).

Mirrors the `gen_vapid` script in style. Two modes:

1. **Default (interactive)**: prompts for a password twice via
   `getpass`, hashes via argon2, inserts into the users.db at
   `settings.users_db_path`. Used by operators on the Jetson host:

       ssh jetson 'cd /home/israel/HomeCameraSystem/server &&
           docker compose -f ../deploy/docker-compose.yml exec server \\
           python -m app.scripts.gen_admin <username>'

   Or directly inside the container.

2. **`--hash-only`** (non-interactive): prompts for a password but
   prints the resulting hash to stdout WITHOUT touching the DB. Used
   to populate the `HOMECAM_ADMIN_PASSWORD_HASH` env var for the
   first-boot bootstrap (Phase 2's `seed_from_env_if_empty`).

Exit codes:
    0  — user created (or hash dumped)
    1  — duplicate username
    2  — password mismatch (typed differently in the two prompts)
    3  — empty username or password

The script is module-runnable: `python -m app.scripts.gen_admin <user>`.
"""
from __future__ import annotations

import argparse
import getpass
import sqlite3
import sys
from pathlib import Path
from typing import Callable

from ..auth import passwords, users_db
from ..config import settings


def _read_password(prompt: Callable[[str], str] | None = None) -> str | None:
    """Prompt twice, confirm match. Returns the password on success,
    None on mismatch / empty (caller exits with code 2).

    The `prompt` arg defaults to `None` and is looked up against
    `getpass.getpass` at call time — NOT bound at function-def time
    via a default-arg reference. That way `monkeypatch.setattr(
    gen_admin.getpass, "getpass", ...)` in tests actually affects
    behaviour. The default-arg-binds-at-def quirk is a recurring
    test footgun in Python.
    """
    if prompt is None:
        prompt = getpass.getpass
    pw1 = prompt("Password: ")
    if not pw1:
        print("[gen_admin] empty password — aborting", file=sys.stderr)
        return None
    pw2 = prompt("Confirm:  ")
    if pw1 != pw2:
        print("[gen_admin] passwords don't match — aborting", file=sys.stderr)
        return None
    return pw1


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="gen_admin",
        description="Create or rehash an admin user for HomeCameraSystem.",
    )
    parser.add_argument(
        "username",
        nargs="?",
        help="Username to create. Required unless --hash-only.",
    )
    parser.add_argument(
        "--hash-only",
        action="store_true",
        help=(
            "Don't touch the database. Print the argon2id hash to "
            "stdout — populate HOMECAM_ADMIN_PASSWORD_HASH with it "
            "for first-boot env-var seeding."
        ),
    )
    parser.add_argument(
        "--db",
        type=Path,
        default=None,
        help=(
            "Override the users.db path (default: settings.users_db_path "
            "/ USERS_DB_PATH env). Useful for tests."
        ),
    )
    # iter-196 (Feature #3 vocab): pick a role at create time. Default
    # `admin` keeps backwards compat with iter-178/179 seeded users —
    # which the iter-192 JWT decoder treats semantically as `owner`.
    # First-time household setup should use `--role=owner` explicitly;
    # secondary accounts go via `--role=family|viewer`.
    parser.add_argument(
        "--role",
        choices=users_db.ROLE_VOCAB,
        default="admin",
        help=(
            "Role for the created user. owner/family/viewer per "
            "Feature #3 RBAC; admin retained for legacy compat."
        ),
    )
    args = parser.parse_args(argv)

    if not args.hash_only and not args.username:
        parser.error("username is required unless --hash-only")
        return 3  # unreachable; argparse exits 2

    pw = _read_password()
    if pw is None:
        # Distinguish empty (exit 3) vs mismatch (exit 2) by checking
        # what _read_password printed. Simpler: re-prompt model
        # would change. Here we just exit 2 either way; the operator
        # sees the stderr message which clarifies.
        return 2

    hashed = passwords.hash_password(pw)

    if args.hash_only:
        # Print hash to stdout. Operator pipes into env var.
        print(hashed)
        return 0

    db_path = args.db if args.db is not None else settings.users_db_path
    users_db.init_db(db_path)
    try:
        users_db.create_user(db_path, args.username, hashed, role=args.role)
    except sqlite3.IntegrityError:
        print(
            "[gen_admin] user {!r} already exists. To reset their "
            "password, use `python -m app.scripts.gen_admin "
            "{} --reset` (TODO: not implemented yet — for now, "
            "delete the row via sqlite shell first)".format(
                args.username, args.username
            ),
            file=sys.stderr,
        )
        return 1
    print(
        "[gen_admin] created admin user {!r} in {}".format(
            args.username, db_path
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
