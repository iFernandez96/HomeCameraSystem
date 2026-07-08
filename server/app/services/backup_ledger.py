from __future__ import annotations

import json
import os
from collections.abc import Mapping
from datetime import UTC, datetime
from pathlib import Path
from typing import Any


def append_attempt(
    path: Path,
    *,
    attempt_id: str,
    operation: str,
    ok: bool,
    status: str,
    metadata: Mapping[str, Any],
    reason: str | None = None,
) -> dict[str, Any]:
    if not attempt_id:
        raise ValueError("attempt_id is required")
    if operation not in {"backup", "restore"}:
        raise ValueError("unsupported backup ledger operation")

    record: dict[str, Any] = {
        "attempt_id": attempt_id,
        "operation": operation,
        "ok": ok,
        "status": status,
        "created_at": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
        "metadata": dict(metadata),
    }
    if reason:
        record["reason"] = reason

    path.parent.mkdir(parents=True, exist_ok=True)
    encoded = json.dumps(record, sort_keys=True, separators=(",", ":")).encode(
        "utf-8"
    ) + b"\n"
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    try:
        written = os.write(fd, encoded)
        if written != len(encoded):
            raise OSError("short write while appending backup ledger")
        os.fsync(fd)
    finally:
        os.close(fd)
    return record


def read_attempts(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    rows: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as fh:
        for line in fh:
            stripped = line.strip()
            if stripped:
                rows.append(json.loads(stripped))
    return rows


def attempt_metadata(
    manifest: Mapping[str, Any] | None,
    *,
    archive_digest: str | None,
    inventory_count: int = 0,
    compatibility_decision: str,
    changed_files_count: int,
    restart_health_result: str,
    rollback_status: str,
) -> dict[str, Any]:
    files = manifest.get("files", []) if manifest else []
    included_paths = [
        str(item["path"])
        for item in files
        if isinstance(item, dict) and not item.get("absent", False)
    ]
    required_count = sum(
        1 for item in files if isinstance(item, dict) and item.get("required")
    )
    absent_optional_count = sum(
        1
        for item in files
        if isinstance(item, dict)
        and item.get("absent", False)
        and not item.get("required")
    )
    return {
        "source_file_manifest_summary": {
            "file_count": len(files),
            "included_count": len(included_paths),
            "required_count": required_count,
            "absent_optional_count": absent_optional_count,
            "inventory_count": inventory_count,
        },
        "archive_digest": archive_digest,
        "included_paths": included_paths,
        "compatibility_decision": compatibility_decision,
        "changed_files_count": changed_files_count,
        "restart_health_result": restart_health_result,
        "rollback_status": rollback_status,
    }
