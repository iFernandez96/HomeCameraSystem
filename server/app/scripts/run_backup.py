from __future__ import annotations

import json
from uuid import uuid4

from app.config import settings
from app.services.backup_orchestrator import (
    BackupOrchestratorRequest,
    orchestrate_backup,
)


def main() -> int:
    result = orchestrate_backup(
        BackupOrchestratorRequest(
            attempt_id="scheduled-{}".format(uuid4()),
            target_dir=settings.backup_target_dir,
            ledger_path=settings.backup_ledger_path,
            app_version=settings.version,
            settings_obj=settings,
        )
    )
    safe = {
        key: result[key]
        for key in (
            "ok",
            "status",
            "reason",
            "filename",
            "size",
            "manifest_id",
            "archive_digest",
            "encrypted",
            "backup_age_s",
            "replication_status",
            "ledger_id",
        )
        if key in result
    }
    print(json.dumps(safe, sort_keys=True))
    return 0 if result.get("ok") is True else 1


if __name__ == "__main__":
    raise SystemExit(main())
