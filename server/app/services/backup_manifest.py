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
    kind: str = "file"


_PERSISTED_FILE_SPECS: tuple[tuple[str, str, bool, str], ...] = (
    ("users_db_path", "users_db", True, "sqlite"),
    ("events_db_path", "events_db", True, "sqlite"),
    ("audit_db_path", "audit_db", True, "sqlite"),
    ("vapid_private_key_path", "vapid_private_key", True, "file"),
    ("vapid_public_key_path", "vapid_public_key", True, "file"),
    ("push_subs_path", "push_subs", False, "file"),
    ("detection_config_path", "detection_config", False, "file"),
    ("clip_shares_path", "clip_shares", False, "file"),
    ("digest_state_path", "digest_state", False, "file"),
    ("camera_exposure_path", "camera_exposure", False, "file"),
    ("security_state_path", "security_state", False, "file"),
)

# PR-201 recovery inventory. Every path-valued Settings field is classified so
# a new durable location cannot be silently mistaken for protected backup data.
# The detailed rationale and operator consequences live in
# docs/decisions/pr-201-recovery-inventory.md.
PERSISTENCE_POLICY: dict[str, str] = {
    "vapid_private_key_path": "included",
    "vapid_public_key_path": "included",
    "client_dist": "excluded_release_artifact",
    "snapshots_dir": "excluded_media",
    "recordings_dir": "excluded_media",
    "continuous_recordings_dir": "excluded_media",
    "face_captures_dir": "excluded_media",
    "person_captures_dir": "excluded_media",
    "push_subs_path": "included",
    "detection_config_path": "included",
    "users_db_path": "included_sqlite",
    "jwt_secret_path": "excluded_rotate_on_restore",
    "backup_target_dir": "excluded_backup_output",
    "backup_ledger_path": "excluded_current_evidence",
    "timelapses_dir": "excluded_media",
    "events_db_path": "included_sqlite",
    "clip_shares_path": "included",
    "digest_state_path": "included",
    "audit_db_path": "included_sqlite",
    "sessions_db_path": "excluded_clear_on_restore",
    "host_action_state_path": "excluded_inflight_state",
    "camera_exposure_path": "included",
    "security_state_path": "included",
    "security_exports_dir": "excluded_ephemeral",
    "worker_auth_secret_path": "excluded_host_provisioned_secret",
    "deterrence_driver_path": "excluded_host_provisioned_adapter",
    "ota_root": "excluded_deferred_ota_state",
    "ota_manifest_path": "excluded_deferred_ota_state",
    "ota_artifacts_dir": "excluded_deferred_ota_state",
    "ota_staging_root": "excluded_deferred_ota_state",
    "ota_active_pointer": "excluded_deferred_ota_state",
    "ota_ledger_path": "excluded_deferred_ota_state",
    "ota_client_dist_target": "excluded_release_artifact",
}


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
    for setting_name, role, required, kind in _PERSISTED_FILE_SPECS:
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
                kind=kind,
            )
        )
    exposure_path = getattr(settings_obj, "camera_exposure_path", None)
    if exposure_path is not None:
        presets_path = Path(exposure_path).with_name(
            Path(exposure_path).stem + "_presets.json"
        ).resolve()
        entries.append(
            BackupInventoryEntry(
                role="camera_exposure_presets",
                path=presets_path,
                allowed_root=_select_allowed_root(presets_path, roots),
                required=False,
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
    kind = item.get("kind", "file")
    if kind not in {"file", "sqlite"}:
        raise ValueError(f"files[{index}].kind is unsupported")
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
            "kind": entry.kind,
        }
    if not entry.path.is_file():
        raise BackupBlocked(
            "persisted path is not a regular file",
            role=entry.role,
            path=entry.path,
        )
    return {
        "path": manifest_path,
        "role": entry.role,
        "size": entry.path.stat().st_size,
        "sha256": _sha256_file(entry.path),
        "mode": entry.path.stat().st_mode & 0o777,
        "required": entry.required,
        "absent": False,
        "kind": entry.kind,
    }


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()
