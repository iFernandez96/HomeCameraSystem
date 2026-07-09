"""SQLite-backed operator audit trail.

Separate from events.db because this records user/session behavior, not
camera detections. The file is pre-created 0o600 before sqlite opens it
and WAL is enabled, matching users.db/events.db privacy conventions.
"""
from __future__ import annotations

import logging
import os
import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator, Literal, TypedDict


log = logging.getLogger(__name__)

AuthAction = Literal["login_ok", "login_fail", "refresh", "logout"]
ViewKind = Literal["page", "event"]
HostAction = Literal["mediamtx", "nvargus", "reboot", "logs"]
HostActionPhase = Literal["requested", "result"]


class AuthEvent(TypedDict):
    ts: float
    username: str
    action: AuthAction
    ua: str


class ViewEvent(TypedDict):
    ts: float
    username: str
    kind: ViewKind
    name: str
    dwell_ms: int


class HostActionEvent(TypedDict):
    ts: float
    username: str
    action: HostAction
    request_id: str
    phase: HostActionPhase
    status: str | None
    detail: str | None


_SCHEMA = """
CREATE TABLE IF NOT EXISTS auth_events (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    ts        REAL NOT NULL,
    username  TEXT NOT NULL,
    action    TEXT NOT NULL CHECK(action IN ('login_ok','login_fail','refresh','logout')),
    ua        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS auth_events_ts ON auth_events(ts DESC);

CREATE TABLE IF NOT EXISTS view_events (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    ts        REAL NOT NULL,
    username  TEXT NOT NULL,
    kind      TEXT NOT NULL CHECK(kind IN ('page','event')),
    name      TEXT NOT NULL,
    dwell_ms  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS view_events_ts ON view_events(ts DESC);

CREATE TABLE IF NOT EXISTS host_action_events (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    ts        REAL NOT NULL,
    username  TEXT NOT NULL,
    action    TEXT NOT NULL CHECK(action IN ('mediamtx','nvargus','reboot','logs')),
    request_id TEXT NOT NULL,
    phase     TEXT NOT NULL CHECK(phase IN ('requested','result')),
    status    TEXT,
    detail    TEXT
);
CREATE INDEX IF NOT EXISTS host_action_events_ts ON host_action_events(ts DESC);
"""


def init_db(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if not path.exists():
        fd = os.open(path, os.O_CREAT | os.O_RDWR, 0o600)
        os.close(fd)
    with sqlite3.connect(path) as conn:
        conn.execute("PRAGMA journal_mode=WAL")
        conn.executescript(_SCHEMA)
        conn.commit()
    try:
        path.chmod(0o600)
    except OSError as exc:
        log.warning(
            "audit_db: could not chmod 0o600 on %s — DB may remain "
            "world-readable: %s",
            path,
            exc,
        )


@contextmanager
def _connect(path: Path) -> Iterator[sqlite3.Connection]:
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
    finally:
        conn.close()


def insert_auth_event(
    path: Path,
    *,
    ts: float,
    username: str,
    action: AuthAction,
    ua: str,
) -> None:
    with _connect(path) as conn:
        conn.execute(
            """
            INSERT OR IGNORE INTO auth_events (ts, username, action, ua)
            VALUES (?, ?, ?, ?)
            """,
            (ts, username, action, ua[:256]),
        )
        conn.commit()


def insert_view_event(
    path: Path,
    *,
    ts: float,
    username: str,
    kind: ViewKind,
    name: str,
    dwell_ms: int,
) -> None:
    with _connect(path) as conn:
        conn.execute(
            """
            INSERT OR IGNORE INTO view_events (ts, username, kind, name, dwell_ms)
            VALUES (?, ?, ?, ?, ?)
            """,
            (ts, username, kind, name, dwell_ms),
        )
        conn.commit()


def insert_host_action_event(
    path: Path,
    *,
    ts: float,
    username: str,
    action: HostAction,
    request_id: str,
    phase: HostActionPhase,
    status: str | None,
    detail: str | None,
) -> None:
    with _connect(path) as conn:
        conn.execute(
            """
            INSERT OR IGNORE INTO host_action_events
              (ts, username, action, request_id, phase, status, detail)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                ts,
                username,
                action,
                request_id,
                phase,
                status,
                detail[:512] if detail else None,
            ),
        )
        conn.commit()


def auth_events_between(
    path: Path,
    *,
    since: float,
    until: float,
    limit: int = 5000,
) -> list[AuthEvent]:
    with _connect(path) as conn:
        rows = conn.execute(
            """
            SELECT ts, username, action, ua
            FROM auth_events
            WHERE ts >= ? AND ts <= ?
            ORDER BY ts DESC
            LIMIT ?
            """,
            (since, until, limit),
        ).fetchall()
    return [
        {
            "ts": float(row["ts"]),
            "username": str(row["username"]),
            "action": row["action"],
            "ua": str(row["ua"]),
        }
        for row in rows
    ]


def view_events_between(
    path: Path,
    *,
    since: float,
    until: float,
    limit: int = 5000,
) -> list[ViewEvent]:
    with _connect(path) as conn:
        rows = conn.execute(
            """
            SELECT ts, username, kind, name, dwell_ms
            FROM view_events
            WHERE ts >= ? AND ts <= ?
            ORDER BY ts DESC
            LIMIT ?
            """,
            (since, until, limit),
        ).fetchall()
    return [
        {
            "ts": float(row["ts"]),
            "username": str(row["username"]),
            "kind": row["kind"],
            "name": str(row["name"]),
            "dwell_ms": int(row["dwell_ms"]),
        }
        for row in rows
    ]


def host_action_events_between(
    path: Path,
    *,
    since: float,
    until: float,
    limit: int = 5000,
) -> list[HostActionEvent]:
    with _connect(path) as conn:
        rows = conn.execute(
            """
            SELECT ts, username, action, request_id, phase, status, detail
            FROM host_action_events
            WHERE ts >= ? AND ts <= ?
            ORDER BY ts DESC
            LIMIT ?
            """,
            (since, until, limit),
        ).fetchall()
    return [
        {
            "ts": float(row["ts"]),
            "username": str(row["username"]),
            "action": row["action"],
            "request_id": str(row["request_id"]),
            "phase": row["phase"],
            "status": row["status"],
            "detail": row["detail"],
        }
        for row in rows
    ]


def reset(path: Path) -> None:
    init_db(path)
    with _connect(path) as conn:
        conn.execute("DELETE FROM auth_events")
        conn.execute("DELETE FROM view_events")
        conn.execute("DELETE FROM host_action_events")
        conn.commit()
