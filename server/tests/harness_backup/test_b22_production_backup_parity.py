import json
import re
import shutil
from pathlib import Path

import pytest


FIXTURE_DIR = Path(".jetson-snapshot/proof_fixtures/backup")
ARCHIVE_NAME = "homecam-backup-20260708T221004Z.tar.gz"
REQUIRED_ROLES = (
    "users_db",
    "jwt_secret",
    "vapid_private_key",
    "vapid_public_key",
)
SHA_LINE_RE = re.compile(r"^(?P<sha>[0-9a-f]{64})\s+(?P<name>[^\s]+)$")


pytestmark = pytest.mark.skipif(
    not FIXTURE_DIR.is_dir(),
    reason="B22 production backup fixture is not present",
)


def _copy_fixture_to_tmp(tmp_path: Path) -> Path:
    backup_dir = tmp_path / "backup-fixture"
    backup_dir.mkdir()
    for name in (
        ARCHIVE_NAME,
        f"{ARCHIVE_NAME}.manifest.json",
        "backup-ledger.jsonl",
        "source-hashes.txt",
    ):
        shutil.copy2(FIXTURE_DIR / name, backup_dir / name)
    return backup_dir


def _source_hashes(path: Path) -> dict[str, str]:
    hashes: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        match = SHA_LINE_RE.match(line.strip())
        if match is None:
            continue
        hashes[match.group("name")] = match.group("sha")
    return hashes


def _manifest_hashes_by_filename(manifest: dict[str, object]) -> dict[str, str]:
    files = manifest["files"]
    assert isinstance(files, list)
    hashes: dict[str, str] = {}
    for item in files:
        assert isinstance(item, dict)
        if item.get("absent", False):
            continue
        path = item["path"]
        sha256 = item["sha256"]
        assert isinstance(path, str)
        assert isinstance(sha256, str)
        hashes[Path(path).name] = sha256
    return hashes


def _restore_roots(tmp_path: Path, manifest: dict[str, object]) -> dict[str, Path]:
    files = manifest["files"]
    assert isinstance(files, list)
    return {
        str(item["role"]): tmp_path / "restored" / str(item["role"])
        for item in files
        if isinstance(item, dict) and not item.get("absent", False)
    }


def _restored_hashes_by_filename(
    restore_roots: dict[str, Path],
    manifest: dict[str, object],
) -> dict[str, str]:
    from app.services.backup_archive import sha256_file

    files = manifest["files"]
    assert isinstance(files, list)
    hashes: dict[str, str] = {}
    for item in files:
        assert isinstance(item, dict)
        if item.get("absent", False):
            continue
        manifest_path = str(item["path"])
        filename = Path(manifest_path).name
        relative_parts = Path(manifest_path).parts[1:]
        restored_path = restore_roots[str(item["role"])].joinpath(*relative_parts)
        hashes[filename] = sha256_file(restored_path)
    return hashes


def _ledger_archive_digest(path: Path) -> str:
    lines = [line for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
    assert len(lines) == 1
    line = json.loads(lines[0])
    metadata = line["metadata"]
    assert isinstance(metadata, dict)
    digest = metadata["archive_digest"]
    assert isinstance(digest, str)
    return digest


def test_given_real_jetson_backup_when_restored_to_scratch_then_hashes_match_production(
    tmp_path,
):
    from app.auth import users_db
    from app.services.backup_archive import sha256_file
    from app.services.backup_restore import (
        apply_staged_restore,
        check_restore_compatibility,
        dry_run_restore,
        open_restore_backup,
        stage_restore_archive,
        validate_restored_state,
    )

    backup_dir = _copy_fixture_to_tmp(tmp_path)
    archive_path = backup_dir / ARCHIVE_NAME
    manifest_path = backup_dir / f"{ARCHIVE_NAME}.manifest.json"
    ledger_path = backup_dir / "backup-ledger.jsonl"
    source_hash_path = backup_dir / "source-hashes.txt"

    archive_digest = sha256_file(archive_path)
    restore = open_restore_backup(backup_target_dir=backup_dir, filename=ARCHIVE_NAME)
    source_hashes = _source_hashes(source_hash_path)
    manifest_hashes = _manifest_hashes_by_filename(restore.manifest)

    assert archive_digest == _ledger_archive_digest(ledger_path)
    assert archive_digest == restore.manifest["archive_sha256"]
    assert sha256_file(manifest_path) == sha256_file(restore.manifest_path)
    assert manifest_hashes == source_hashes

    compatibility = check_restore_compatibility(
        restore.manifest,
        current_app_version=str(restore.manifest["app_version"]),
        current_schema_version=restore.manifest.get("schema_version"),
    )
    assert compatibility.compatible is True

    restore_roots = _restore_roots(tmp_path, restore.manifest)
    dry_run = dry_run_restore(
        restore,
        restore_roots=restore_roots,
        required_roles=REQUIRED_ROLES,
    )
    assert dry_run["ok"] is True
    assert len(dry_run["actions"]) == len(source_hashes)

    staging = stage_restore_archive(
        restore,
        restore_roots=restore_roots,
        required_roles=REQUIRED_ROLES,
        staging_parent=tmp_path / "staging",
    )
    apply_result = apply_staged_restore(
        staging,
        backup_parent=tmp_path / "pre-restore",
        validators=[validate_restored_state],
    )

    assert apply_result.changed_count == len(source_hashes)
    assert _restored_hashes_by_filename(restore_roots, restore.manifest) == source_hashes
    users_db_path = restore_roots["users_db"] / "users.db"
    users_db.init_db(users_db_path)
    assert users_db.count_users(users_db_path) > 0
