"""SQLite-backed logged-in session store.

The sessions table records opaque JWT ``jti`` identifiers, device labels, and
last-seen timestamps. It deliberately never stores JWT bytes. File creation and
WAL setup mirror ``auth.users_db`` because this database reveals who logged in
from where and should be protected with the same 0o600 mode.
"""
from __future__ import annotations

import os
import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator


REVOKED_GRACE_S = 24 * 60 * 60

_SCHEMA = """
CREATE TABLE IF NOT EXISTS sessions (
    jti           TEXT PRIMARY KEY,
    session_id    TEXT,
    refresh_jti   TEXT,
    username      TEXT NOT NULL,
    kind          TEXT NOT NULL DEFAULT 'session',
    device_ua_raw TEXT NOT NULL,
    device_label  TEXT NOT NULL,
    ip_class      TEXT NOT NULL,
    created_ts    REAL NOT NULL,
    last_seen_ts  REAL NOT NULL,
    revoked_ts    REAL
);
CREATE INDEX IF NOT EXISTS sessions_username ON sessions(username);
CREATE INDEX IF NOT EXISTS sessions_last_seen ON sessions(last_seen_ts DESC);
"""


def init_db(path: Path) -> None:
    """Create the sessions table if missing and enable WAL."""
    path.parent.mkdir(parents=True, exist_ok=True)
    if not path.exists():
        fd = os.open(path, os.O_CREAT | os.O_RDWR, 0o600)
        os.close(fd)
    with sqlite3.connect(path) as conn:
        conn.execute("PRAGMA journal_mode=WAL")
        conn.executescript(_SCHEMA)
        columns = {
            str(row[1]) for row in conn.execute("PRAGMA table_info(sessions)")
        }
        if "session_id" not in columns:
            conn.execute("ALTER TABLE sessions ADD COLUMN session_id TEXT")
        # Existing rows predate stable session ids. Their current access JTI
        # is the best durable seed; later token rotations leave this value
        # untouched, so one device session no longer fragments every refresh.
        conn.execute(
            "UPDATE sessions SET session_id = jti "
            "WHERE session_id IS NULL OR session_id = ''"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS sessions_stable_id ON sessions(session_id)"
        )
        conn.commit()
    try:
        path.chmod(0o600)
    except OSError:
        pass


@contextmanager
def _connect(path: Path) -> Iterator[sqlite3.Connection]:
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
    finally:
        conn.close()


def create_session(
    path: Path,
    *,
    jti: str,
    refresh_jti: str | None,
    username: str,
    device_ua_raw: str,
    device_label: str,
    ip_class: str,
    now: float,
) -> None:
    """Insert a session row idempotently on login or legacy refresh."""
    with _connect(path) as conn:
        conn.execute(
            """
            INSERT OR IGNORE INTO sessions (
                jti, session_id, refresh_jti, username, kind, device_ua_raw, device_label,
                ip_class, created_ts, last_seen_ts, revoked_ts
            )
            VALUES (?, ?, ?, ?, 'session', ?, ?, ?, ?, ?, NULL)
            """,
            (
                jti,
                jti,
                refresh_jti,
                username,
                (device_ua_raw or "")[:256],
                device_label,
                ip_class,
                now,
                now,
            ),
        )
        conn.commit()


def link_refresh(path: Path, access_jti: str, refresh_jti: str) -> bool:
    """Attach a refresh ``jti`` to an existing access-session row."""
    with _connect(path) as conn:
        cur = conn.execute(
            "UPDATE sessions SET refresh_jti = ? WHERE jti = ?",
            (refresh_jti, access_jti),
        )
        conn.commit()
        return cur.rowcount > 0


def rotate_session(
    path: Path,
    *,
    old_refresh_jti: str,
    new_access_jti: str,
    new_refresh_jti: str,
    now: float,
) -> bool:
    """Carry a session row forward when refresh token rotation succeeds."""
    with _connect(path) as conn:
        cur = conn.execute(
            """
            UPDATE sessions
            SET jti = ?, refresh_jti = ?, last_seen_ts = ?
            WHERE refresh_jti = ? AND revoked_ts IS NULL
            """,
            (new_access_jti, new_refresh_jti, now, old_refresh_jti),
        )
        conn.commit()
        return cur.rowcount > 0


def touch_last_seen(path: Path, jti: str, now: float) -> bool:
    with _connect(path) as conn:
        cur = conn.execute(
            """
            UPDATE sessions
            SET last_seen_ts = ?
            WHERE jti = ? AND revoked_ts IS NULL
            """,
            (now, jti),
        )
        conn.commit()
        return cur.rowcount > 0


def get_session(path: Path, jti: str) -> dict | None:
    with _connect(path) as conn:
        row = conn.execute(
            """
            SELECT jti, session_id, refresh_jti, username, kind, device_ua_raw,
                   device_label, ip_class, created_ts, last_seen_ts, revoked_ts
            FROM sessions
            WHERE jti = ?
            """,
            (jti,),
        ).fetchone()
    return dict(row) if row is not None else None


def get_session_by_refresh_jti(path: Path, refresh_jti: str) -> dict | None:
    with _connect(path) as conn:
        row = conn.execute(
            """
            SELECT jti, session_id, refresh_jti, username, kind, device_ua_raw,
                   device_label, ip_class, created_ts, last_seen_ts, revoked_ts
            FROM sessions
            WHERE refresh_jti = ?
            """,
            (refresh_jti,),
        ).fetchone()
    return dict(row) if row is not None else None


def revoke_by_jti(path: Path, jti: str, now: float) -> bool:
    with _connect(path) as conn:
        cur = conn.execute(
            """
            UPDATE sessions
            SET revoked_ts = ?
            WHERE (jti = ? OR refresh_jti = ?) AND revoked_ts IS NULL
            """,
            (now, jti, jti),
        )
        conn.commit()
        return cur.rowcount > 0


def list_sessions(
    path: Path,
    *,
    include_revoked: bool,
    now: float,
) -> list[dict]:
    del now
    where = "" if include_revoked else "WHERE revoked_ts IS NULL"
    with _connect(path) as conn:
        rows = conn.execute(
            """
            SELECT jti, session_id, refresh_jti, username, kind, device_ua_raw,
                   device_label, ip_class, created_ts, last_seen_ts, revoked_ts
            FROM sessions
            {where}
            ORDER BY last_seen_ts DESC
            """.format(where=where)
        ).fetchall()
    return [dict(row) for row in rows]


def prune(
    path: Path,
    *,
    now: float,
    access_ttl_s: int,
    refresh_ttl_s: int,
) -> int:
    """Delete rows that can no longer represent a live session."""
    del access_ttl_s
    with _connect(path) as conn:
        cur = conn.execute(
            """
            DELETE FROM sessions
            WHERE (revoked_ts IS NOT NULL AND revoked_ts < ?)
               OR last_seen_ts < ?
            """,
            (now - REVOKED_GRACE_S, now - refresh_ttl_s),
        )
        conn.commit()
        return cur.rowcount
