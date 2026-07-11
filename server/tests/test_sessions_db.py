from __future__ import annotations

import os

from app.sessions import sessions_db


def test_given_missing_db_when_init_then_creates_private_sqlite_file(tmp_path):
    # arrange
    path = tmp_path / "sessions.db"

    # act
    sessions_db.init_db(path)

    # assert
    assert path.exists()
    assert oct(os.stat(path).st_mode & 0o777) == "0o600"


def test_given_session_when_created_then_it_can_be_listed_and_read(tmp_path):
    # arrange
    path = tmp_path / "sessions.db"
    sessions_db.init_db(path)

    # act
    sessions_db.create_session(
        path,
        jti="access1",
        refresh_jti="refresh1",
        username="alice",
        device_ua_raw="UA",
        device_label="Chrome on Pixel 7",
        ip_class="tailscale",
        now=100.0,
    )

    # assert
    row = sessions_db.get_session(path, "access1")
    assert row is not None
    assert row["username"] == "alice"
    assert row["session_id"] == "access1"
    assert row["refresh_jti"] == "refresh1"
    assert sessions_db.list_sessions(path, include_revoked=True, now=101.0)[0][
        "device_label"
    ] == "Chrome on Pixel 7"


def test_given_duplicate_jti_when_create_session_then_insert_is_idempotent(tmp_path):
    # arrange
    path = tmp_path / "sessions.db"
    sessions_db.init_db(path)

    # act
    for username in ("alice", "bob"):
        sessions_db.create_session(
            path,
            jti="access1",
            refresh_jti="refresh1",
            username=username,
            device_ua_raw="UA",
            device_label="Chrome on Android",
            ip_class="lan",
            now=100.0,
        )

    # assert
    rows = sessions_db.list_sessions(path, include_revoked=True, now=100.0)
    assert len(rows) == 1
    assert rows[0]["username"] == "alice"


def test_given_session_when_rotated_then_same_row_gets_new_jtis(tmp_path):
    # arrange
    path = tmp_path / "sessions.db"
    sessions_db.init_db(path)
    sessions_db.create_session(
        path,
        jti="old_access",
        refresh_jti="old_refresh",
        username="alice",
        device_ua_raw="UA",
        device_label="Firefox on Windows",
        ip_class="cellular",
        now=100.0,
    )

    # act
    ok = sessions_db.rotate_session(
        path,
        old_refresh_jti="old_refresh",
        new_access_jti="new_access",
        new_refresh_jti="new_refresh",
        now=160.0,
    )

    # assert
    assert ok is True
    assert sessions_db.get_session(path, "old_access") is None
    row = sessions_db.get_session(path, "new_access")
    assert row is not None
    assert row["refresh_jti"] == "new_refresh"
    assert row["session_id"] == "old_access"
    assert row["created_ts"] == 100.0
    assert row["last_seen_ts"] == 160.0


def test_given_legacy_database_when_initialized_then_stable_session_ids_are_backfilled(tmp_path):
    import sqlite3

    path = tmp_path / "sessions.db"
    with sqlite3.connect(path) as conn:
        conn.execute(
            """
            CREATE TABLE sessions (
                jti TEXT PRIMARY KEY, refresh_jti TEXT, username TEXT NOT NULL,
                kind TEXT NOT NULL DEFAULT 'session', device_ua_raw TEXT NOT NULL,
                device_label TEXT NOT NULL, ip_class TEXT NOT NULL,
                created_ts REAL NOT NULL, last_seen_ts REAL NOT NULL,
                revoked_ts REAL
            )
            """
        )
        conn.execute(
            "INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            ("legacy_access", "legacy_refresh", "alice", "session", "UA",
             "Android", "lan", 100.0, 101.0, None),
        )

    sessions_db.init_db(path)

    assert sessions_db.get_session(path, "legacy_access")["session_id"] == "legacy_access"


def test_given_session_when_revoked_by_refresh_jti_then_access_row_is_revoked(tmp_path):
    # arrange
    path = tmp_path / "sessions.db"
    sessions_db.init_db(path)
    sessions_db.create_session(
        path,
        jti="access1",
        refresh_jti="refresh1",
        username="alice",
        device_ua_raw="UA",
        device_label="Safari on iPhone",
        ip_class="lan",
        now=100.0,
    )

    # act
    ok = sessions_db.revoke_by_jti(path, "refresh1", 120.0)

    # assert
    assert ok is True
    assert sessions_db.get_session(path, "access1")["revoked_ts"] == 120.0


def test_given_old_rows_when_pruned_then_expired_and_old_revoked_are_deleted(tmp_path):
    # arrange
    path = tmp_path / "sessions.db"
    sessions_db.init_db(path)
    sessions_db.create_session(
        path,
        jti="expired",
        refresh_jti="expired_r",
        username="alice",
        device_ua_raw="UA",
        device_label="Unknown device",
        ip_class="other",
        now=10.0,
    )
    sessions_db.create_session(
        path,
        jti="active",
        refresh_jti="active_r",
        username="alice",
        device_ua_raw="UA",
        device_label="Unknown device",
        ip_class="other",
        now=990.0,
    )
    sessions_db.revoke_by_jti(path, "active", 995.0)

    # act
    deleted = sessions_db.prune(
        path,
        now=1000.0,
        access_ttl_s=60,
        refresh_ttl_s=100,
    )

    # assert
    assert deleted == 1
    assert sessions_db.get_session(path, "expired") is None
    assert sessions_db.get_session(path, "active") is not None
