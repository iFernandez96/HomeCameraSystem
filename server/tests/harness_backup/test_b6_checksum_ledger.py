import hashlib
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


def test_given_archive_written_when_checksums_read_then_manifest_matches_archive_bytes(tmp_path):
    from app.services.backup_archive import sha256_file, write_archive_to_temp
    from app.services.backup_manifest import build_manifest_from_inventory

    state_root = tmp_path / "state"
    state_root.mkdir()
    payload = b"sqlite backup bytes"
    (state_root / "users.db").write_bytes(payload)
    inventory = [_inventory_entry(state_root)]

    manifest = build_manifest_from_inventory(
        inventory,
        app_version="0.1.0",
        created_at="2026-07-08T12:00:00Z",
    )
    draft = write_archive_to_temp(
        target_dir=tmp_path / "backups",
        manifest=manifest,
        inventory=inventory,
        temp_stem="homecam-backup-20260708T120000Z",
    )

    file_item = draft.manifest["files"][0]
    assert file_item["sha256"] == hashlib.sha256(payload).hexdigest()
    assert draft.manifest["archive_sha256"] == sha256_file(draft.archive_tmp_path)

    with tarfile.open(draft.archive_tmp_path, "r:gz") as archive:
        extracted = archive.extractfile(file_item["path"])
        assert extracted is not None
        assert hashlib.sha256(extracted.read()).hexdigest() == file_item["sha256"]
