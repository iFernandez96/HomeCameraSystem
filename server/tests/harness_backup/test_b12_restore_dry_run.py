import tarfile
from pathlib import Path


def _inventory_entry(root: Path, name: str = "users.db", role: str = "users_db"):
    from app.services.backup_manifest import BackupInventoryEntry

    return BackupInventoryEntry(
        role=role,
        path=root / name,
        allowed_root=root,
        required=True,
    )


def _restore_backup(tmp_path, payload=b"sqlite"):
    from app.services.backup_archive import publish_backup_atomically, write_archive_to_temp
    from app.services.backup_manifest import build_manifest_from_inventory
    from app.services.backup_restore import open_restore_backup

    state_root = tmp_path / "state"
    target_dir = tmp_path / "backups"
    state_root.mkdir()
    (state_root / "users.db").write_bytes(payload)
    inventory = [_inventory_entry(state_root)]
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


def test_given_valid_backup_when_dry_run_runs_then_action_plan_is_report_only(tmp_path):
    from app.services.backup_restore import dry_run_restore

    restore = _restore_backup(tmp_path, payload=b"sqlite")
    target_root = tmp_path / "restore" / "users_db"

    plan = dry_run_restore(
        restore,
        restore_roots={"users_db": target_root},
        required_roles=["users_db"],
    )

    assert plan["ok"] is True
    assert plan["dry_run"] is True
    assert plan["actions"] == [
        {
            "role": "users_db",
            "source": "users_db/users.db",
            "target_path": str(target_root / "users.db"),
            "size": 6,
            "sha256": restore.manifest["files"][0]["sha256"],
            "mode": restore.manifest["files"][0]["mode"],
            "action": "write",
        }
    ]
    assert not (target_root / "users.db").exists()


def test_given_corrupt_archive_member_when_dry_run_runs_then_checksum_blocks_restore(tmp_path):
    import pytest
    from app.services.backup_restore import RestoreBlocked, dry_run_restore

    restore = _restore_backup(tmp_path, payload=b"sqlite")
    source = tmp_path / "corrupt-source"
    source.write_bytes(b"changed")
    with tarfile.open(restore.archive_path, "w:gz") as archive:
        archive.add(source, arcname="users_db/users.db", recursive=False)

    with pytest.raises(RestoreBlocked):
        dry_run_restore(
            restore,
            restore_roots={"users_db": tmp_path / "restore" / "users_db"},
            required_roles=["users_db"],
        )


def test_given_required_role_missing_when_dry_run_runs_then_restore_is_blocked(tmp_path):
    import pytest
    from app.services.backup_restore import RestoreBlocked, dry_run_restore

    restore = _restore_backup(tmp_path, payload=b"sqlite")

    with pytest.raises(RestoreBlocked):
        dry_run_restore(
            restore,
            restore_roots={"users_db": tmp_path / "restore" / "users_db"},
            required_roles=["users_db", "jwt_secret"],
        )
