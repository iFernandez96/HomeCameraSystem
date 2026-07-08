import json
import sqlite3
from pathlib import Path


def _inventory_entry(root: Path, name: str, role: str, required: bool = True):
    from app.services.backup_manifest import BackupInventoryEntry

    return BackupInventoryEntry(
        role=role,
        path=root / name,
        allowed_root=root,
        required=required,
    )


def _checkpoint_and_remove_sqlite_sidecars(db_path: Path) -> None:
    with sqlite3.connect(db_path) as conn:
        conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    for suffix in ("-wal", "-shm"):
        try:
            Path(f"{db_path}{suffix}").unlink()
        except FileNotFoundError:
            pass


def _users_rows(db_path: Path) -> list[tuple[object, ...]]:
    with sqlite3.connect(db_path) as conn:
        return conn.execute(
            "SELECT username, password_hash, role, created_at "
            "FROM users ORDER BY username"
        ).fetchall()


def _write_scratch_vapid_pair(monkeypatch, private_path: Path, public_path: Path) -> None:
    from app.config import settings
    from app.scripts import gen_vapid

    monkeypatch.setattr(settings, "vapid_private_key_path", private_path)
    monkeypatch.setattr(settings, "vapid_public_key_path", public_path)
    gen_vapid.main()


def _build_real_scratch_state(tmp_path, monkeypatch) -> tuple[Path, dict[str, Path]]:
    from app.auth import jwt_secret, users_db
    from app.services.detection_config import DetectionConfigStore

    root = tmp_path / "source-state"
    root.mkdir()
    paths = {
        "users_db": root / "users.db",
        "jwt_secret": root / "jwt_secret.bin",
        "push_subs": root / "push_subs.json",
        "detection_config": root / "detection_config.json",
        "vapid_private_key": root / "vapid_private.pem",
        "vapid_public_key": root / "vapid_public.pem",
    }

    users_db.init_db(paths["users_db"])
    users_db.create_user(paths["users_db"], "owner", "$argon2id$owner", role="owner")
    users_db.create_user(paths["users_db"], "viewer", "$argon2id$viewer", role="viewer")
    _checkpoint_and_remove_sqlite_sidecars(paths["users_db"])

    DetectionConfigStore(path=paths["detection_config"]).update(
        enabled=False,
        threshold=0.72,
        zones=[[[0.1, 0.1], [0.9, 0.1], [0.5, 0.8]]],
        classes=["person", "car"],
        camera_label="Porch",
        face_capture_enabled=False,
    )
    paths["push_subs"].write_text(
        json.dumps(
            [
                {
                    "endpoint": "https://push.example/sub/a",
                    "keys": {"p256dh": "p256dh", "auth": "auth"},
                }
            ],
            sort_keys=True,
            separators=(",", ":"),
        ),
        encoding="utf-8",
    )
    _write_scratch_vapid_pair(
        monkeypatch,
        paths["vapid_private_key"],
        paths["vapid_public_key"],
    )
    jwt_secret.load_or_generate(paths["jwt_secret"])
    return root, paths


def _copy_source_to_live(source_paths: dict[str, Path], tmp_path: Path) -> dict[str, Path]:
    live_root = tmp_path / "live-state"
    role_paths: dict[str, Path] = {}
    for role, source_path in source_paths.items():
        role_root = live_root / role
        role_root.mkdir(parents=True, exist_ok=True)
        live_path = role_root / source_path.name
        live_path.write_bytes(source_path.read_bytes())
        role_paths[role] = live_path
    return role_paths


def _mutate_live_state(live_paths: dict[str, Path]) -> None:
    from app.auth import users_db
    from app.services.detection_config import DetectionConfigStore

    users_db.create_user(live_paths["users_db"], "mutated", "$argon2id$mutated", role="family")
    _checkpoint_and_remove_sqlite_sidecars(live_paths["users_db"])
    DetectionConfigStore(path=live_paths["detection_config"]).update(
        enabled=True,
        threshold=0.2,
        zones=[],
        classes=["dog"],
        camera_label="Mutated",
        face_capture_enabled=True,
    )
    live_paths["push_subs"].write_text("[]", encoding="utf-8")
    live_paths["jwt_secret"].write_bytes(b"m" * 32)
    live_paths["vapid_private_key"].write_text("mutated-private", encoding="utf-8")
    live_paths["vapid_public_key"].write_text("mutated-public", encoding="utf-8")


def test_given_real_backup_chain_when_scratch_state_restores_then_bytes_and_rows_match_source(
    tmp_path,
    monkeypatch,
):
    from app.services.backup_archive import publish_backup_atomically, write_archive_to_temp
    from app.services.backup_manifest import build_manifest_from_inventory
    from app.services.backup_restore import (
        RestoreOrchestratorRequest,
        restore_api_response_from_orchestrator,
    )

    source_root, source_paths = _build_real_scratch_state(tmp_path, monkeypatch)
    source_bytes = {role: path.read_bytes() for role, path in source_paths.items()}
    source_rows = _users_rows(source_paths["users_db"])
    live_paths = _copy_source_to_live(source_paths, tmp_path)
    inventory = [
        _inventory_entry(source_root, "users.db", "users_db"),
        _inventory_entry(source_root, "jwt_secret.bin", "jwt_secret"),
        _inventory_entry(source_root, "push_subs.json", "push_subs", required=False),
        _inventory_entry(
            source_root,
            "detection_config.json",
            "detection_config",
            required=False,
        ),
        _inventory_entry(source_root, "vapid_private.pem", "vapid_private_key"),
        _inventory_entry(source_root, "vapid_public.pem", "vapid_public_key"),
    ]
    manifest = build_manifest_from_inventory(
        inventory,
        app_version="0.1.0",
        created_at="2026-07-08T12:00:00Z",
    )
    backup_dir = tmp_path / "backups"
    draft = write_archive_to_temp(
        target_dir=backup_dir,
        manifest=manifest,
        inventory=inventory,
        temp_stem="homecam-backup-20260708T120000Z",
    )
    published = publish_backup_atomically(
        draft=draft,
        target_dir=backup_dir,
        final_archive_name="homecam-backup-20260708T120000Z.tar.gz",
    )

    _mutate_live_state(live_paths)
    body = restore_api_response_from_orchestrator(
        RestoreOrchestratorRequest(
            filename=published.archive_path.name,
            backup_target_dir=backup_dir,
            current_app_version="0.1.0",
            current_schema_version=None,
            restore_roots={role: path.parent for role, path in live_paths.items()},
            required_roles=[
                "users_db",
                "jwt_secret",
                "vapid_private_key",
                "vapid_public_key",
            ],
            staging_parent=tmp_path / "staging",
            backup_parent=tmp_path / "pre-restore",
            ledger_id="round-trip-restore",
        )
    )

    assert body["ok"] is True
    assert body["restored"] is True
    assert body["changed_file_count"] == 6
    for role, expected in source_bytes.items():
        assert live_paths[role].read_bytes() == expected
    assert _users_rows(live_paths["users_db"]) == source_rows
