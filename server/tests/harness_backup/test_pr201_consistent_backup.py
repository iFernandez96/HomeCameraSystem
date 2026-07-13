import sqlite3
import tarfile
import threading
import time
from pathlib import Path

import pytest


def _sqlite_inventory(path: Path, role: str = "users_db"):
    from app.services.backup_manifest import BackupInventoryEntry

    return BackupInventoryEntry(
        role=role,
        path=path,
        allowed_root=path.parent,
        required=True,
        kind="sqlite",
    )


def _integrity(path: Path) -> str:
    with sqlite3.connect(path) as conn:
        row = conn.execute("PRAGMA integrity_check").fetchone()
    assert row is not None
    return str(row[0])


def test_given_server_path_settings_when_policy_audited_then_every_path_is_classified():
    from app.config import Settings
    from app.services.backup_manifest import PERSISTENCE_POLICY

    path_settings = {
        name
        for name, annotation in Settings.__annotations__.items()
        if "Path" in str(annotation)
    }

    assert set(PERSISTENCE_POLICY) == path_settings
    assert all(
        disposition == "included"
        or disposition == "included_sqlite"
        or disposition.startswith("excluded_")
        for disposition in PERSISTENCE_POLICY.values()
    )
    assert PERSISTENCE_POLICY["jwt_secret_path"] == "excluded_rotate_on_restore"
    assert PERSISTENCE_POLICY["sessions_db_path"] == "excluded_clear_on_restore"


def test_given_committed_wal_and_concurrent_writes_when_snapshot_runs_then_online_copy_is_consistent(
    tmp_path,
):
    from app.services.backup_snapshot import materialize_consistent_inventory

    db_path = tmp_path / "state" / "users.db"
    db_path.parent.mkdir()
    with sqlite3.connect(db_path) as conn:
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("CREATE TABLE sample (id INTEGER PRIMARY KEY, value TEXT NOT NULL)")
        conn.execute("INSERT INTO sample(value) VALUES ('before-wal')")
        conn.commit()
        conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")

    writer_ready = threading.Event()
    stop_writer = threading.Event()

    def write_committed_rows() -> None:
        with sqlite3.connect(db_path, timeout=30.0) as writer:
            writer.execute("PRAGMA journal_mode=WAL")
            writer.execute("INSERT INTO sample(value) VALUES ('committed-in-wal')")
            writer.commit()
            writer_ready.set()
            counter = 0
            while not stop_writer.is_set():
                writer.execute(
                    "INSERT INTO sample(value) VALUES (?)",
                    ("concurrent-{}".format(counter),),
                )
                writer.commit()
                counter += 1
                time.sleep(0.001)

    writer_thread = threading.Thread(target=write_committed_rows)
    writer_thread.start()
    assert writer_ready.wait(timeout=5.0)
    try:
        with materialize_consistent_inventory(
            [_sqlite_inventory(db_path)],
            staging_parent=tmp_path / "backups",
        ) as stable:
            snapshot_path = stable[0].path
            assert _integrity(snapshot_path) == "ok"
            with sqlite3.connect(snapshot_path) as snapshot:
                values = {
                    str(row[0])
                    for row in snapshot.execute("SELECT value FROM sample")
                }
            assert "before-wal" in values
            assert "committed-in-wal" in values
            assert not Path(str(snapshot_path) + "-wal").exists()
            assert not Path(str(snapshot_path) + "-shm").exists()
    finally:
        stop_writer.set()
        writer_thread.join(timeout=5.0)
    assert not writer_thread.is_alive()


def test_given_live_sqlite_inventory_when_archive_written_then_only_snapshot_database_is_archived(
    tmp_path,
):
    from app.services.backup_archive import write_archive_to_temp
    from app.services.backup_manifest import build_manifest_from_inventory
    from app.services.backup_snapshot import materialize_consistent_inventory

    db_path = tmp_path / "state" / "events.db"
    db_path.parent.mkdir()
    live = sqlite3.connect(db_path)
    try:
        live.execute("PRAGMA journal_mode=WAL")
        live.execute("CREATE TABLE events (id INTEGER PRIMARY KEY, label TEXT)")
        live.commit()
        live.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        live.execute("INSERT INTO events(label) VALUES ('committed-wal-row')")
        live.commit()
        assert Path(str(db_path) + "-wal").exists()

        with materialize_consistent_inventory(
            [_sqlite_inventory(db_path, role="events_db")],
            staging_parent=tmp_path / "backups",
        ) as stable:
            manifest = build_manifest_from_inventory(stable, app_version="0.1.0")
            draft = write_archive_to_temp(
                target_dir=tmp_path / "backups",
                manifest=manifest,
                inventory=stable,
            )
        with tarfile.open(draft.archive_tmp_path, "r:gz") as archive:
            assert archive.getnames() == ["events_db/events.db"]
            archive.extract("events_db/events.db", path=tmp_path / "extract")
        restored = tmp_path / "extract" / "events_db" / "events.db"
        assert _integrity(restored) == "ok"
        with sqlite3.connect(restored) as conn:
            assert conn.execute("SELECT label FROM events").fetchone() == (
                "committed-wal-row",
            )
    finally:
        live.close()


def test_given_active_tokens_when_restore_policy_runs_then_all_sessions_require_login(
    tmp_path,
    monkeypatch,
):
    from app.auth import tokens
    from app.config import settings
    from app.services.backup_restore import force_reauthentication
    from app.sessions import sessions_db

    jwt_path = tmp_path / "jwt_secret.bin"
    sessions_path = tmp_path / "sessions.db"
    monkeypatch.setattr(settings, "jwt_secret_path", jwt_path)
    monkeypatch.setattr(settings, "sessions_db_path", sessions_path)
    sessions_db.init_db(sessions_path)
    token = tokens.issue("owner", "access", role="owner", now=time.time())
    claims = tokens.decode(token, kind="access")
    sessions_db.create_session(
        sessions_path,
        jti=str(claims["jti"]),
        refresh_jti="refresh-before-restore",
        username="owner",
        device_ua_raw="test",
        device_label="test",
        ip_class="loopback",
        now=time.time(),
    )
    previous_secret = jwt_path.read_bytes()

    force_reauthentication(
        jwt_secret_path=jwt_path,
        sessions_db_path=sessions_path,
    )

    assert jwt_path.read_bytes() != previous_secret
    with pytest.raises(tokens.InvalidToken):
        tokens.decode(token, kind="access")
    assert sessions_db.list_sessions(
        sessions_path,
        include_revoked=True,
        now=time.time(),
    ) == []
