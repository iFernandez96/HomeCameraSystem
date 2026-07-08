from pathlib import Path

import pytest


def _inventory_entry(root: Path, name: str = "users.db", role: str = "users_db"):
    from app.services.backup_manifest import BackupInventoryEntry

    return BackupInventoryEntry(
        role=role,
        path=root / name,
        allowed_root=root,
        required=True,
    )


def _manifest(root: Path):
    from app.services.backup_manifest import build_manifest_from_inventory

    return build_manifest_from_inventory(
        [_inventory_entry(root)],
        app_version="0.1.0",
        created_at="2026-07-08T12:00:00Z",
    )


def test_given_inventory_when_archive_written_then_only_temp_archive_exists(tmp_path):
    from app.services.backup_archive import write_archive_to_temp

    state_root = tmp_path / "state"
    target_dir = tmp_path / "backups"
    state_root.mkdir()
    (state_root / "users.db").write_bytes(b"sqlite")

    draft = write_archive_to_temp(
        target_dir=target_dir,
        manifest=_manifest(state_root),
        inventory=[_inventory_entry(state_root)],
        temp_stem="homecam-backup-20260708T120000Z",
    )

    assert draft.archive_tmp_path.name == "homecam-backup-20260708T120000Z.tar.gz.tmp~"
    assert draft.archive_tmp_path.exists()
    assert not (target_dir / "homecam-backup-20260708T120000Z.tar.gz").exists()


def test_given_archive_write_failure_when_temp_created_then_no_final_archive_or_temp_remains(tmp_path):
    from app.services.backup_archive import write_archive_to_temp

    state_root = tmp_path / "state"
    target_dir = tmp_path / "backups"
    state_root.mkdir()
    (state_root / "users.db").write_bytes(b"sqlite")
    entry = _inventory_entry(state_root)
    manifest = _manifest(state_root)
    entry.path.unlink()

    with pytest.raises(FileNotFoundError):
        write_archive_to_temp(
            target_dir=target_dir,
            manifest=manifest,
            inventory=[entry],
            temp_stem="homecam-backup-20260708T120000Z",
        )

    assert list(target_dir.iterdir()) == []
