import hashlib
import json
import sqlite3
from pathlib import Path

import pytest


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _inventory_entry(root: Path, name: str, role: str, required: bool = True):
    from app.services.backup_manifest import BackupInventoryEntry

    return BackupInventoryEntry(
        role=role,
        path=root / name,
        allowed_root=root,
        required=required,
    )


def _write_vapid_pair(private_path: Path, public_path: Path) -> None:
    from cryptography.hazmat.backends import default_backend
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import ec

    private_key = ec.generate_private_key(ec.SECP256R1(), default_backend())
    public_key = private_key.public_key()
    private_path.write_bytes(
        private_key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.PKCS8,
            encryption_algorithm=serialization.NoEncryption(),
        )
    )
    public_path.write_bytes(
        public_key.public_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PublicFormat.SubjectPublicKeyInfo,
        )
    )


def _make_users_db(path: Path) -> None:
    with sqlite3.connect(path) as conn:
        conn.execute(
            "CREATE TABLE users ("
            "username TEXT PRIMARY KEY, "
            "password_hash TEXT NOT NULL, "
            "role TEXT NOT NULL DEFAULT 'admin', "
            "created_at REAL NOT NULL)"
        )
        conn.execute(
            "INSERT INTO users (username, password_hash, role, created_at) "
            "VALUES ('owner', 'hash', 'owner', 1.0)"
        )
        conn.commit()


def _restore_backup(tmp_path, *, bad_detection_config: bool = False):
    from app.services.backup_archive import publish_backup_atomically, write_archive_to_temp
    from app.services.backup_manifest import build_manifest_from_inventory
    from app.services.backup_restore import open_restore_backup

    state_root = tmp_path / ("bad-state" if bad_detection_config else "state")
    target_dir = tmp_path / ("bad-backups" if bad_detection_config else "backups")
    state_root.mkdir()
    _make_users_db(state_root / "users.db")
    (state_root / "jwt_secret.bin").write_bytes(b"s" * 32)
    (state_root / "push_subs.json").write_text("[]", encoding="utf-8")
    (state_root / "detection_config.json").write_text(
        "[]" if bad_detection_config else json.dumps({"enabled": True}),
        encoding="utf-8",
    )
    _write_vapid_pair(
        state_root / "vapid_private.pem",
        state_root / "vapid_public.pem",
    )
    inventory = [
        _inventory_entry(state_root, "users.db", "users_db"),
        _inventory_entry(state_root, "jwt_secret.bin", "jwt_secret"),
        _inventory_entry(state_root, "push_subs.json", "push_subs", required=False),
        _inventory_entry(
            state_root,
            "detection_config.json",
            "detection_config",
            required=False,
        ),
        _inventory_entry(state_root, "vapid_private.pem", "vapid_private_key"),
        _inventory_entry(state_root, "vapid_public.pem", "vapid_public_key"),
    ]
    manifest = build_manifest_from_inventory(
        inventory,
        app_version="0.1.0",
        created_at="2026-07-08T12:00:00Z",
    )
    draft = write_archive_to_temp(
        target_dir=target_dir,
        manifest=manifest,
        inventory=inventory,
        temp_stem="homecam-backup-20260708T120000Z",
    )
    published = publish_backup_atomically(
        draft=draft,
        target_dir=target_dir,
        final_archive_name="homecam-backup-20260708T120000Z.tar.gz",
    )
    return open_restore_backup(
        backup_target_dir=target_dir,
        filename=published.archive_path.name,
    )


def _restore_roots(tmp_path):
    roles = (
        "users_db",
        "jwt_secret",
        "push_subs",
        "detection_config",
        "vapid_private_key",
        "vapid_public_key",
    )
    roots = {role: tmp_path / "live" / role for role in roles}
    for root in roots.values():
        root.mkdir(parents=True, exist_ok=True)
    return roots


def test_given_valid_restored_state_when_apply_validates_then_real_offline_loaders_accept_it(tmp_path):
    from app.services.backup_restore import (
        apply_staged_restore,
        stage_restore_archive,
        validate_restored_state,
    )

    restore = _restore_backup(tmp_path)
    roots = _restore_roots(tmp_path)
    staging = stage_restore_archive(
        restore,
        restore_roots=roots,
        required_roles=["users_db", "jwt_secret", "vapid_private_key", "vapid_public_key"],
        staging_parent=tmp_path / "staging",
    )

    result = apply_staged_restore(
        staging,
        backup_parent=tmp_path,
        validators=[validate_restored_state],
    )

    assert result.changed_count == 6
    assert (roots["users_db"] / "users.db").exists()


def test_given_invalid_restored_state_when_validation_fails_then_live_bytes_roll_back(tmp_path):
    from app.services.backup_restore import (
        RestoreBlocked,
        apply_staged_restore,
        stage_restore_archive,
        validate_restored_state,
    )

    restore = _restore_backup(tmp_path, bad_detection_config=True)
    roots = _restore_roots(tmp_path)
    live_config = roots["detection_config"] / "detection_config.json"
    live_config.write_text(json.dumps({"enabled": False}), encoding="utf-8")
    before = _sha256(live_config)
    staging = stage_restore_archive(
        restore,
        restore_roots=roots,
        required_roles=["users_db", "jwt_secret", "vapid_private_key", "vapid_public_key"],
        staging_parent=tmp_path / "staging",
    )

    with pytest.raises(RestoreBlocked):
        apply_staged_restore(
            staging,
            backup_parent=tmp_path,
            validators=[validate_restored_state],
        )

    assert _sha256(live_config) == before
