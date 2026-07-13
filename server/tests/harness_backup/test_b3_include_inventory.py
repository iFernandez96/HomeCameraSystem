from pathlib import Path
from types import SimpleNamespace

import pytest


def _settings(root: Path) -> SimpleNamespace:
    return SimpleNamespace(
        users_db_path=root / "users.db",
        events_db_path=root / "events.db",
        audit_db_path=root / "audit.db",
        vapid_private_key_path=root / "vapid_private.pem",
        vapid_public_key_path=root / "vapid_public.pem",
        push_subs_path=root / "push_subs.json",
        detection_config_path=root / "detection_config.json",
        clip_shares_path=root / "clip_shares.json",
        digest_state_path=root / "daily_digest_state.json",
        camera_exposure_path=root / "camera_exposure.json",
        security_state_path=root / "security-state.json",
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
        "events_db",
        "audit_db",
        "vapid_private_key",
        "vapid_public_key",
        "push_subs",
        "detection_config",
        "clip_shares",
        "digest_state",
        "camera_exposure",
        "camera_exposure_presets",
        "security_state",
    }
    assert all(
        entry.path.relative_to(entry.allowed_root) is not None
        for entry in inventory
    )


def test_given_path_outside_allowed_root_when_inventory_built_then_backup_is_blocked(tmp_path):
    from app.services.backup_manifest import BackupBlocked, build_persisted_state_inventory

    state_root = tmp_path / "state"
    settings_obj = _settings(state_root)
    settings_obj.users_db_path = tmp_path / "elsewhere" / "users.db"

    with pytest.raises(BackupBlocked):
        build_persisted_state_inventory(
            settings_obj=settings_obj,
            allowed_roots=[state_root],
        )
