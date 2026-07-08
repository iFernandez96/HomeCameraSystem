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


def test_given_app_settings_when_inventory_built_then_persisted_paths_stay_under_allowed_root(tmp_path):
    from app.services.backup_manifest import build_persisted_state_inventory

    state_root = tmp_path / "state"
    settings_obj = _settings(state_root)

    inventory = build_persisted_state_inventory(
        settings_obj=settings_obj,
        allowed_roots=[state_root],
    )

    assert {entry.role for entry in inventory} == {
        "users_db",
        "jwt_secret",
        "vapid_private_key",
        "vapid_public_key",
        "push_subs",
        "detection_config",
    }
    assert all(
        entry.path.relative_to(entry.allowed_root) is not None
        for entry in inventory
    )


def test_given_path_outside_allowed_root_when_inventory_built_then_backup_is_blocked(tmp_path):
    from app.services.backup_manifest import BackupBlocked, build_persisted_state_inventory

    state_root = tmp_path / "state"
    settings_obj = _settings(state_root)
    settings_obj.jwt_secret_path = tmp_path / "elsewhere" / "jwt_secret.bin"

    with pytest.raises(BackupBlocked):
        build_persisted_state_inventory(
            settings_obj=settings_obj,
            allowed_roots=[state_root],
        )

