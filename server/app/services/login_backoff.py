"""Persistent, endpoint-scoped login backoff.

The state lives in ``audit.db`` because it is authentication-operational state,
not camera/event data.  Callers supply the canonical client address from the
ASGI scope; this module never reads forwarding headers.  Uvicorn is responsible
for accepting those headers only from the explicitly trusted proxy hops.
"""
from __future__ import annotations

import math
import sqlite3
import unicodedata
from ipaddress import IPv6Address, ip_address
from pathlib import Path


LOGIN_ENDPOINT = "POST /api/auth/login"
FAILURES_BEFORE_BACKOFF = 3
BASE_BACKOFF_S = 1
MAX_BACKOFF_S = 60
RESET_AFTER_S = 15 * 60
MAX_BUCKETS = 4096
_CLOCK_ROLLBACK_TOLERANCE_S = 5


_SCHEMA = """
CREATE TABLE IF NOT EXISTS login_backoff (
    endpoint      TEXT NOT NULL,
    account_key   TEXT NOT NULL,
    source_addr   TEXT NOT NULL,
    failures      INTEGER NOT NULL CHECK(failures >= 1),
    blocked_until REAL NOT NULL,
    updated_at    REAL NOT NULL,
    PRIMARY KEY (endpoint, account_key, source_addr)
);
CREATE INDEX IF NOT EXISTS login_backoff_updated_at
    ON login_backoff(updated_at);
"""


def init_schema(conn: sqlite3.Connection) -> None:
    """Apply the idempotent PR-104 schema migration to an open audit DB."""
    conn.executescript(_SCHEMA)


def normalize_account(username: str) -> str:
    """Return the stable bucket key without changing authentication lookup.

    Authentication remains an exact lookup in ``users.db``.  NFKC + strip +
    casefold prevents visually/case-equivalent probes from creating independent
    throttle buckets.  Product usernames must therefore be unique under this
    normalization; existing account lookup behavior is intentionally unchanged.
    """
    normalized = unicodedata.normalize("NFKC", username).strip().casefold()
    return normalized or "<empty>"


def canonical_source_address(value: str | None) -> str:
    """Canonicalize the already-trusted ASGI peer address.

    IPv4-mapped IPv6 is collapsed to IPv4 so the same device cannot obtain two
    buckets by changing textual address form.  Missing/non-IP peers share the
    fail-safe ``unknown`` bucket; raw forwarding headers are never consulted.
    """
    try:
        address = ip_address(value or "")
    except ValueError:
        return "unknown"
    if isinstance(address, IPv6Address) and address.ipv4_mapped is not None:
        return str(address.ipv4_mapped)
    return address.compressed


def backoff_seconds(failures: int) -> int:
    """Pure bounded progression: attempts 3+ wait 1, 2, 4 ... 60 seconds."""
    if failures < FAILURES_BEFORE_BACKOFF:
        return 0
    exponent = failures - FAILURES_BEFORE_BACKOFF
    if exponent >= 6:
        return MAX_BACKOFF_S
    return min(MAX_BACKOFF_S, BASE_BACKOFF_S * (2 ** exponent))


def _connect(path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(path, timeout=5.0)
    conn.row_factory = sqlite3.Row
    return conn


def retry_after(
    path: Path,
    *,
    endpoint: str,
    account_key: str,
    source_addr: str,
    now: float,
) -> int:
    """Return a bounded whole-second Retry-After value, or zero when allowed."""
    with _connect(path) as conn:
        row = conn.execute(
            """
            SELECT blocked_until, updated_at
            FROM login_backoff
            WHERE endpoint = ? AND account_key = ? AND source_addr = ?
            """,
            (endpoint, account_key, source_addr),
        ).fetchone()
        if row is None:
            return 0
        updated_at = float(row["updated_at"])
        if (
            now - updated_at >= RESET_AFTER_S
            or now < updated_at - _CLOCK_ROLLBACK_TOLERANCE_S
        ):
            conn.execute(
                """
                DELETE FROM login_backoff
                WHERE endpoint = ? AND account_key = ? AND source_addr = ?
                """,
                (endpoint, account_key, source_addr),
            )
            conn.commit()
            return 0
        remaining = float(row["blocked_until"]) - now
        if remaining <= 0:
            return 0
        return min(MAX_BACKOFF_S, max(1, int(math.ceil(remaining))))


def record_failure(
    path: Path,
    *,
    endpoint: str,
    account_key: str,
    source_addr: str,
    now: float,
) -> int:
    """Atomically increment one bucket and return its new Retry-After value."""
    with _connect(path) as conn:
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute(
            """
            SELECT failures, updated_at
            FROM login_backoff
            WHERE endpoint = ? AND account_key = ? AND source_addr = ?
            """,
            (endpoint, account_key, source_addr),
        ).fetchone()
        previous = 0
        if row is not None:
            updated_at = float(row["updated_at"])
            if (
                now - updated_at < RESET_AFTER_S
                and now >= updated_at - _CLOCK_ROLLBACK_TOLERANCE_S
            ):
                previous = int(row["failures"])
        failures = previous + 1
        delay = backoff_seconds(failures)
        conn.execute(
            """
            INSERT INTO login_backoff
              (endpoint, account_key, source_addr, failures, blocked_until, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(endpoint, account_key, source_addr) DO UPDATE SET
              failures = excluded.failures,
              blocked_until = excluded.blocked_until,
              updated_at = excluded.updated_at
            """,
            (endpoint, account_key, source_addr, failures, now + delay, now),
        )
        conn.execute(
            "DELETE FROM login_backoff WHERE updated_at < ?",
            (now - RESET_AFTER_S,),
        )
        conn.execute(
            """
            DELETE FROM login_backoff
            WHERE rowid IN (
                SELECT rowid FROM login_backoff
                ORDER BY updated_at DESC, rowid DESC
                LIMIT -1 OFFSET ?
            )
            """,
            (MAX_BUCKETS,),
        )
        conn.commit()
        return delay


def clear(
    path: Path,
    *,
    endpoint: str,
    account_key: str,
    source_addr: str,
) -> None:
    """Clear exactly one successful endpoint/account/source bucket."""
    with _connect(path) as conn:
        conn.execute(
            """
            DELETE FROM login_backoff
            WHERE endpoint = ? AND account_key = ? AND source_addr = ?
            """,
            (endpoint, account_key, source_addr),
        )
        conn.commit()


def reset(path: Path) -> None:
    """Test helper: remove all backoff buckets without touching audit events."""
    with _connect(path) as conn:
        conn.execute("DELETE FROM login_backoff")
        conn.commit()


def bucket_count(path: Path) -> int:
    """Return the current row count for bounded-storage verification."""
    with _connect(path) as conn:
        row = conn.execute("SELECT COUNT(*) AS n FROM login_backoff").fetchone()
        return int(row["n"]) if row is not None else 0
