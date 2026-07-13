from __future__ import annotations

import argparse
import json
import shutil
import time
from pathlib import Path

from app.services.backup_restore import (
    apply_staged_restore,
    check_restore_compatibility,
    force_reauthentication,
    open_restore_backup,
    stage_restore_archive,
    validate_restored_state,
)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Restore one encrypted HomeCam backup into a clean scratch root.",
    )
    parser.add_argument("--backup", required=True, type=Path)
    parser.add_argument("--private-key", required=True, type=Path)
    parser.add_argument("--scratch", required=True, type=Path)
    args = parser.parse_args()

    backup_path = args.backup.resolve()
    scratch = args.scratch.resolve()
    if scratch.exists() and any(scratch.iterdir()):
        raise RuntimeError("scratch root must not exist or must be empty")
    scratch.mkdir(parents=True, exist_ok=True)

    started = time.monotonic()
    staging_parent = scratch / ".staging"
    restore = None
    staging = None
    try:
        restore = open_restore_backup(
            backup_target_dir=backup_path.parent,
            filename=backup_path.name,
            recovery_private_key_path=args.private_key.resolve(),
            staging_parent=staging_parent,
        )
        compatibility = check_restore_compatibility(
            restore.manifest,
            current_app_version=str(restore.manifest["app_version"]),
            current_schema_version=restore.manifest.get("schema_version"),
        )
        if not compatibility.compatible:
            raise RuntimeError(
                "scratch restore compatibility check failed: {}".format(
                    compatibility.reason or "unknown"
                )
            )
        present = [
            item
            for item in restore.manifest["files"]
            if not item.get("absent", False)
        ]
        restore_roots = {
            str(item["role"]): scratch / "restored" / str(item["role"])
            for item in present
        }
        required_roles = [
            str(item["role"])
            for item in present
            if item.get("required") is True
        ]
        staging = stage_restore_archive(
            restore,
            restore_roots=restore_roots,
            required_roles=required_roles,
            staging_parent=staging_parent,
        )
        applied = apply_staged_restore(
            staging,
            backup_parent=scratch / ".pre-restore",
            validators=[validate_restored_state],
        )
        force_reauthentication(
            jwt_secret_path=scratch / "reauth" / "jwt.bin",
            sessions_db_path=scratch / "reauth" / "sessions.db",
        )
        elapsed = time.monotonic() - started
        if elapsed > 3600.0:
            raise RuntimeError("scratch restore exceeded the 60 minute RTO")
        print(json.dumps({
            "ok": True,
            "changed_file_count": applied.changed_count,
            "elapsed_seconds": round(elapsed, 3),
            "rto_seconds": 3600,
            "reauthentication_forced": True,
        }, sort_keys=True))
        return 0
    finally:
        if restore is not None:
            for path in restore.cleanup_paths:
                try:
                    path.unlink()
                except OSError:
                    pass
        if staging is not None:
            shutil.rmtree(staging.staging_root, ignore_errors=True)
        shutil.rmtree(staging_parent, ignore_errors=True)
        shutil.rmtree(scratch / ".pre-restore", ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
