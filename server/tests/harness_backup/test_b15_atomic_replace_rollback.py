import hashlib
import os
from pathlib import Path

import pytest


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _inventory_entry(root: Path, name: str, role: str):
    from app.services.backup_manifest import BackupInventoryEntry

    return BackupInventoryEntry(
        role=role,
        path=root / name,
        allowed_root=root,
        required=True,
    )


def _restore_backup(tmp_path):
    from app.services.backup_archive import publish_backup_atomically, write_archive_to_temp
    from app.services.backup_manifest import build_manifest_from_inventory
    from app.services.backup_restore import open_restore_backup

    state_root = tmp_path / "state"
    target_dir = tmp_path / "backups"
    state_root.mkdir()
    (state_root / "users.db").write_bytes(b"new-users")
    (state_root / "jwt_secret.bin").write_bytes(b"n" * 32)
    inventory = [
        _inventory_entry(state_root, "users.db", "users_db"),
        _inventory_entry(state_root, "jwt_secret.bin", "jwt_secret"),
    ]
    manifest = build_manifest_from_inventory(
        inventory,
        app_version="0.1.0",
        created_at="2026-07-08T12:00:00Z",
    )
    draft = write_archive_to_temp(
        target_dir=target_dir,
        manifest=manifest,
        inventory=inventory,
        temp_stem="homecam-backup-20260708T120000Z",
    )
    published = publish_backup_atomically(
        draft=draft,
        target_dir=target_dir,
        final_archive_name="homecam-backup-20260708T120000Z.tar.gz",
    )
    return open_restore_backup(
        backup_target_dir=target_dir,
        filename=published.archive_path.name,
    )


def test_given_second_replace_fails_when_apply_runs_then_pre_restore_bytes_are_restored(tmp_path):
    from app.services.backup_restore import apply_staged_restore, stage_restore_archive

    restore = _restore_backup(tmp_path)
    live_users = tmp_path / "live" / "users_db"
    live_secret = tmp_path / "live" / "jwt_secret"
    live_users.mkdir(parents=True)
    live_secret.mkdir(parents=True)
    users_file = live_users / "users.db"
    secret_file = live_secret / "jwt_secret.bin"
    users_file.write_bytes(b"old-users")
    secret_file.write_bytes(b"o" * 32)
    before = {users_file: _sha256(users_file), secret_file: _sha256(secret_file)}

    staging = stage_restore_archive(
        restore,
        restore_roots={"users_db": live_users, "jwt_secret": live_secret},
        required_roles=["users_db", "jwt_secret"],
        staging_parent=tmp_path / "staging",
    )
    calls = 0

    def fail_second_replace(src: str, dst: str) -> None:
        nonlocal calls
        calls += 1
        if calls == 2:
            raise OSError("simulated replace failure")
        os.replace(src, dst)

    with pytest.raises(OSError):
        apply_staged_restore(
            staging,
            backup_parent=tmp_path,
            replace=fail_second_replace,
        )

    assert _sha256(users_file) == before[users_file]
    assert _sha256(secret_file) == before[secret_file]
