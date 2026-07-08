from pathlib import Path
from types import SimpleNamespace

import pytest


def _settings(root: Path) -> SimpleNamespace:
    return SimpleNamespace(
        users_db_path=root / "users.db",
        jwt_secret_path=root / "jwt_secret.bin",
        vapid_private_key_path=root / "vapid_private.pem",
        vapid_public_key_path=root / "vapid_public.pem",
        push_subs_path=root / "push_subs.json",
        detection_config_path=root / "detection_config.json",
    )


def _write_required_files(root: Path) -> None:
    (root / "users.db").write_bytes(b"sqlite")
    (root / "jwt_secret.bin").write_bytes(b"secret")
    (root / "vapid_private.pem").write_bytes(b"private")
    (root / "vapid_public.pem").write_bytes(b"public")


def test_given_missing_required_file_when_manifest_built_then_backup_is_blocked(tmp_path):
    from app.services.backup_manifest import (
        BackupBlocked,
        build_manifest_from_inventory,
        build_persisted_state_inventory,
    )

    state_root = tmp_path / "state"
    state_root.mkdir()
    _write_required_files(state_root)
    (state_root / "users.db").unlink()
    inventory = build_persisted_state_inventory(
        settings_obj=_settings(state_root),
        allowed_roots=[state_root],
    )

    with pytest.raises(BackupBlocked) as exc_info:
        build_manifest_from_inventory(
            inventory,
            app_version="0.1.0",
            created_at="2026-07-08T12:00:00Z",
        )

    assert exc_info.value.role == "users_db"


def test_given_missing_optional_file_when_manifest_built_then_absence_is_recorded(tmp_path):
    from app.services.backup_manifest import (
        build_manifest_from_inventory,
        build_persisted_state_inventory,
    )

    state_root = tmp_path / "state"
    state_root.mkdir()
    _write_required_files(state_root)
    inventory = build_persisted_state_inventory(
        settings_obj=_settings(state_root),
        allowed_roots=[state_root],
    )

    manifest = build_manifest_from_inventory(
        inventory,
        app_version="0.1.0",
        created_at="2026-07-08T12:00:00Z",
    )

    files_by_role = {item["role"]: item for item in manifest["files"]}
    assert files_by_role["push_subs"]["absent"] is True
    assert files_by_role["push_subs"]["required"] is False
    assert files_by_role["detection_config"]["absent"] is True
    assert files_by_role["detection_config"]["sha256"] is None
