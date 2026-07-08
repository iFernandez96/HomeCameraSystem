from pathlib import Path


def _inventory_entry(root: Path, name: str = "users.db", role: str = "users_db"):
    from app.services.backup_manifest import BackupInventoryEntry

    return BackupInventoryEntry(
        role=role,
        path=root / name,
        allowed_root=root,
        required=True,
    )


def _restore_backup(tmp_path, payload=b"restored"):
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


def test_given_restore_archive_when_staged_then_live_files_are_untouched_until_replace(tmp_path):
    from app.services.backup_restore import stage_restore_archive

    restore = _restore_backup(tmp_path, payload=b"restored")
    live_root = tmp_path / "live" / "users_db"
    live_root.mkdir(parents=True)
    live_file = live_root / "users.db"
    live_file.write_bytes(b"live-before")

    staging = stage_restore_archive(
        restore,
        restore_roots={"users_db": live_root},
        required_roles=["users_db"],
        staging_parent=tmp_path / "staging",
    )

    staged_file = Path(str(staging.actions[0]["staged_path"]))
    assert staged_file.read_bytes() == b"restored"
    assert live_file.read_bytes() == b"live-before"
    assert staged_file.is_relative_to(staging.staging_root)
