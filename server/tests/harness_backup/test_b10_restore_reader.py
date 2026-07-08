from pathlib import Path


def _inventory_entry(root: Path, name: str = "users.db", role: str = "users_db"):
    from app.services.backup_manifest import BackupInventoryEntry

    return BackupInventoryEntry(
        role=role,
        path=root / name,
        allowed_root=root,
        required=True,
    )


def _published_backup(tmp_path):
    from app.services.backup_archive import publish_backup_atomically, write_archive_to_temp
    from app.services.backup_manifest import build_manifest_from_inventory

    state_root = tmp_path / "state"
    target_dir = tmp_path / "backups"
    state_root.mkdir()
    (state_root / "users.db").write_bytes(b"sqlite")
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
    return publish_backup_atomically(
        draft=draft,
        target_dir=target_dir,
        final_archive_name="homecam-backup-20260708T120000Z.tar.gz",
    )


def test_given_safe_backup_filename_when_reader_opens_then_archive_and_manifest_are_loaded(tmp_path):
    from app.services.backup_restore import open_restore_backup

    published = _published_backup(tmp_path)

    restore = open_restore_backup(
        backup_target_dir=published.archive_path.parent,
        filename=published.archive_path.name,
    )

    assert restore.archive_path == published.archive_path
    assert restore.manifest_path == published.manifest_path
    assert restore.manifest["files"][0]["role"] == "users_db"


def test_given_unsafe_backup_filename_when_reader_called_then_rejected_before_open(tmp_path, monkeypatch):
    import pytest
    from app.services.backup_restore import RestoreBlocked, open_restore_backup

    def fail_if_opened(_self):
        raise AssertionError("unsafe restore name must be rejected before filesystem open")

    monkeypatch.setattr(Path, "is_file", fail_if_opened)

    for filename in ["../escape.tar.gz", "nested/backup.tar.gz", "backup with space.tar.gz"]:
        with pytest.raises(RestoreBlocked):
            open_restore_backup(backup_target_dir=tmp_path / "backups", filename=filename)
