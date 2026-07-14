from __future__ import annotations

import hashlib
import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

from app.config import settings as default_settings

log = logging.getLogger(__name__)

MANIFEST_VERSION = 1


class BackupBlocked(RuntimeError):
    """Typed block for backup preflight failures."""

    def __init__(self, reason: str, *, role: str | None = None, path: Path | None = None):
        super().__init__(reason)
        self.reason = reason
        self.role = role
        self.path = path


@dataclass(frozen=True)
class BackupInventoryEntry:
    role: str
    path: Path
    allowed_root: Path
    required: bool


_PERSISTED_FILE_SPECS: tuple[tuple[str, str, bool], ...] = (
    ("users_db_path", "users_db", True),
    ("jwt_secret_path", "jwt_secret", True),
    ("vapid_private_key_path", "vapid_private_key", True),
    ("vapid_public_key_path", "vapid_public_key", True),
    ("push_subs_path", "push_subs", False),
    ("detection_config_path", "detection_config", False),
    ("security_state_path", "security_state", False),
)


def utc_timestamp() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def validate_manifest(manifest: dict[str, Any]) -> dict[str, Any]:
    """Validate manifest shape without reading any source files."""
    if not isinstance(manifest, dict):
        raise ValueError("manifest must be an object")
    if manifest.get("v") != MANIFEST_VERSION:
        raise ValueError("unsupported manifest version")
    created_at = manifest.get("created_at")
    app_version = manifest.get("app_version")
    files = manifest.get("files")
    if not isinstance(created_at, str) or not created_at:
        raise ValueError("created_at must be a non-empty string")
    if not isinstance(app_version, str) or not app_version:
        raise ValueError("app_version must be a non-empty string")
    if not isinstance(files, list):
        raise ValueError("files must be a list")

    for index, item in enumerate(files):
        if not isinstance(item, dict):
            raise ValueError(f"files[{index}] must be an object")
        _validate_manifest_file(item, index)
    return manifest


def make_manifest(
    *,
    app_version: str,
    files: Iterable[dict[str, Any]],
    created_at: str | None = None,
) -> dict[str, Any]:
    manifest = {
        "v": MANIFEST_VERSION,
        "created_at": created_at or utc_timestamp(),
        "app_version": app_version,
        "files": list(files),
    }
    return validate_manifest(manifest)


def build_persisted_state_inventory(
    *,
    settings_obj: object = default_settings,
    allowed_roots: Iterable[Path] | None = None,
) -> list[BackupInventoryEntry]:
    roots = tuple(Path(root).resolve() for root in allowed_roots or ())
    entries: list[BackupInventoryEntry] = []
    for setting_name, role, required in _PERSISTED_FILE_SPECS:
        raw_value = getattr(settings_obj, setting_name, None)
        # Small test/fake Settings objects from older integrations may omit a
        # newly-added optional role. Real Settings always supplies it; skipping
        # only absent optional attributes keeps the inventory API additive.
        if raw_value is None and not required:
            continue
        raw_path = Path(raw_value)
        resolved_path = raw_path.resolve()
        allowed_root = _select_allowed_root(resolved_path, roots)
        entries.append(
            BackupInventoryEntry(
                role=role,
                path=resolved_path,
                allowed_root=allowed_root,
                required=required,
            )
        )
    return entries


def manifest_files_from_inventory(
    inventory: Iterable[BackupInventoryEntry],
) -> list[dict[str, Any]]:
    files: list[dict[str, Any]] = []
    for entry in inventory:
        files.append(_manifest_file_from_entry(entry))
    return files


def build_manifest_from_inventory(
    inventory: Iterable[BackupInventoryEntry],
    *,
    app_version: str,
    created_at: str | None = None,
) -> dict[str, Any]:
    return make_manifest(
        app_version=app_version,
        created_at=created_at,
        files=manifest_files_from_inventory(inventory),
    )


def _validate_manifest_file(item: dict[str, Any], index: int) -> None:
    required_fields = ("path", "role", "size", "sha256", "mode", "required")
    for field in required_fields:
        if field not in item:
            raise ValueError(f"files[{index}].{field} is required")
    if not isinstance(item["path"], str) or not item["path"]:
        raise ValueError(f"files[{index}].path must be a non-empty string")
    if Path(item["path"]).is_absolute() or ".." in Path(item["path"]).parts:
        raise ValueError(f"files[{index}].path must be a safe relative path")
    if not isinstance(item["role"], str) or not item["role"]:
        raise ValueError(f"files[{index}].role must be a non-empty string")
    if not isinstance(item["required"], bool):
        raise ValueError(f"files[{index}].required must be a bool")
    absent = item.get("absent", False)
    if not isinstance(absent, bool):
        raise ValueError(f"files[{index}].absent must be a bool")
    if absent:
        if item["size"] is not None or item["sha256"] is not None or item["mode"] is not None:
            raise ValueError(f"files[{index}] absent file metadata must be null")
        return
    if not isinstance(item["size"], int) or item["size"] < 0:
        raise ValueError(f"files[{index}].size must be a non-negative int")
    if not isinstance(item["sha256"], str) or len(item["sha256"]) != 64:
        raise ValueError(f"files[{index}].sha256 must be a hex digest")
    int(item["sha256"], 16)
    if not isinstance(item["mode"], int) or item["mode"] < 0:
        raise ValueError(f"files[{index}].mode must be a non-negative int")


def _select_allowed_root(path: Path, allowed_roots: tuple[Path, ...]) -> Path:
    if not allowed_roots:
        return path.parent.resolve()
    for root in allowed_roots:
        try:
            path.relative_to(root)
        except ValueError:
            continue
        return root
    log.warning("backup inventory rejected path outside allowed roots: %s", path)
    raise BackupBlocked(
        "persisted path is outside allowed backup roots",
        path=path,
    )


def _manifest_file_from_entry(entry: BackupInventoryEntry) -> dict[str, Any]:
    try:
        relative_path = entry.path.relative_to(entry.allowed_root).as_posix()
    except ValueError as exc:
        raise BackupBlocked(
            "persisted path is outside its allowed backup root",
            role=entry.role,
            path=entry.path,
        ) from exc
    manifest_path = f"{entry.role}/{relative_path}"
    if not entry.path.exists():
        if entry.required:
            log.warning(
                "backup blocked: required persisted file missing role=%s path=%s",
                entry.role,
                entry.path,
            )
            raise BackupBlocked(
                "required persisted file is missing",
                role=entry.role,
                path=entry.path,
            )
        return {
            "path": manifest_path,
            "role": entry.role,
            "size": None,
            "sha256": None,
            "mode": None,
            "required": entry.required,
            "absent": True,
        }
    if not entry.path.is_file():
        raise BackupBlocked(
            "persisted path is not a regular file",
            role=entry.role,
            path=entry.path,
        )
    data = entry.path.read_bytes()
    return {
        "path": manifest_path,
        "role": entry.role,
        "size": len(data),
        "sha256": hashlib.sha256(data).hexdigest(),
        "mode": entry.path.stat().st_mode & 0o777,
        "required": entry.required,
        "absent": False,
    }
