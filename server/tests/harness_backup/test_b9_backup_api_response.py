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


def test_given_published_archive_when_response_built_then_shape_contains_ledger_fields(tmp_path):
    from app.services.backup_archive import backup_api_response_from_published

    published = _published_backup(tmp_path)

    body = backup_api_response_from_published(published)

    assert body == {
        "ok": True,
        "filename": "homecam-backup-20260708T120000Z.tar.gz",
        "size": published.archive_path.stat().st_size,
        "manifest_id": body["manifest_id"],
        "archive_digest": published.archive_sha256,
        "ledger_id": published.archive_sha256,
    }
    assert len(body["manifest_id"]) == 64


def test_given_missing_final_archive_when_response_built_then_success_is_blocked(tmp_path):
    import pytest
    from app.services.backup_archive import backup_api_response_from_published

    published = _published_backup(tmp_path)
    published.archive_path.unlink()

    with pytest.raises(FileNotFoundError):
        backup_api_response_from_published(published)
