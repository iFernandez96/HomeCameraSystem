import re
from pathlib import Path


def _inventory_entry(root: Path, name: str = "users.db", role: str = "users_db"):
    from app.services.backup_manifest import BackupInventoryEntry

    return BackupInventoryEntry(
        role=role,
        path=root / name,
        allowed_root=root,
        required=True,
    )


def _route_visible_names(target_dir: Path) -> list[str]:
    from app.routes.control import _BACKUP_FILENAME_PATTERN

    pattern = re.compile(_BACKUP_FILENAME_PATTERN)
    return sorted(
        child.name
        for child in target_dir.iterdir()
        if child.is_file() and pattern.match(child.name)
    )


def test_given_temp_archive_when_list_backups_filter_applied_then_partial_is_not_visible(tmp_path):
    from app.services.backup_archive import write_archive_to_temp
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

    assert draft.archive_tmp_path.exists()
    assert _route_visible_names(target_dir) == []


def test_given_temp_archive_when_published_then_final_archive_replaces_temp(tmp_path):
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

    published = publish_backup_atomically(
        draft=draft,
        target_dir=target_dir,
        final_archive_name="homecam-backup-20260708T120000Z.tar.gz",
    )

    assert published.archive_path.exists()
    assert published.manifest_path.exists()
    assert not draft.archive_tmp_path.exists()
    assert "homecam-backup-20260708T120000Z.tar.gz" in _route_visible_names(target_dir)
    assert all("tmp" not in name for name in _route_visible_names(target_dir))
