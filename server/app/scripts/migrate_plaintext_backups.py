from __future__ import annotations

import json
from pathlib import Path

from app.config import settings
from app.services.backup_archive import (
    BackupArchiveDraft,
    publish_encrypted_backup_atomically,
    remove_plaintext_backup_intermediates,
    sha256_file,
)
from app.services.backup_manifest import validate_manifest
from app.services.backup_restore import cross_process_maintenance_lease


def main() -> int:
    target = settings.backup_target_dir
    with cross_process_maintenance_lease(
        target / ".maintenance.lock",
        "backup_migration",
    ):
        return _migrate(target)


def _migrate(target: Path) -> int:
    migrated = 0
    for archive_path in sorted(target.glob("homecam-backup-*.tar.gz")):
        manifest_path = archive_path.with_name(archive_path.name + ".manifest.json")
        if not manifest_path.is_file():
            raise RuntimeError("plaintext backup manifest is missing")
        manifest = validate_manifest(
            json.loads(manifest_path.read_text(encoding="utf-8"))
        )
        if manifest.get("archive_sha256") != sha256_file(archive_path):
            raise RuntimeError("plaintext backup checksum mismatch")
        final_name = archive_path.name.removesuffix(".tar.gz") + ".hcbk"
        final_path = target / final_name
        if final_path.exists():
            raise FileExistsError("encrypted migration target already exists")
        publish_encrypted_backup_atomically(
            draft=BackupArchiveDraft(
                archive_tmp_path=archive_path,
                manifest=manifest,
            ),
            target_dir=target,
            final_archive_name=final_name,
            recipient_public_key_path=settings.backup_recipient_public_key_path,
        )
        manifest_path.unlink()
        migrated += 1

    # These exact suffixes are owned, unpublished crash intermediates. They are
    # regenerable and may contain plaintext, so never retain them after cutover.
    removed_temps = len(remove_plaintext_backup_intermediates(target))
    removed_orphan_manifests = 0
    for manifest_path in target.glob("homecam-backup-*.tar.gz.manifest.json"):
        archive_path = manifest_path.with_name(
            manifest_path.name.removesuffix(".manifest.json")
        )
        if not archive_path.exists():
            manifest_path.unlink()
            removed_orphan_manifests += 1
    print(
        "migrated={} plaintext_temps_removed={} orphan_manifests_removed={}".format(
            migrated,
            removed_temps,
            removed_orphan_manifests,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
