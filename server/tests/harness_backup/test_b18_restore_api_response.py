import json
import sqlite3
from pathlib import Path


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


def _published_backup(tmp_path):
    from app.services.backup_archive import publish_backup_atomically, write_archive_to_temp
    from app.services.backup_manifest import build_manifest_from_inventory

    state_root = tmp_path / "source"
    backup_dir = tmp_path / "backups"
    state_root.mkdir()
    _make_users_db(state_root / "users.db")
    (state_root / "jwt_secret.bin").write_bytes(b"s" * 32)
    (state_root / "push_subs.json").write_text("[]", encoding="utf-8")
    (state_root / "detection_config.json").write_text(
        json.dumps({"enabled": True}),
        encoding="utf-8",
    )
    _write_vapid_pair(state_root / "vapid_private.pem", state_root / "vapid_public.pem")
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
        target_dir=backup_dir,
        manifest=manifest,
        inventory=inventory,
        temp_stem="homecam-backup-20260708T120000Z",
    )
    return publish_backup_atomically(
        draft=draft,
        target_dir=backup_dir,
        final_archive_name="homecam-backup-20260708T120000Z.tar.gz",
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


def test_given_all_restore_steps_pass_when_response_built_then_success_fields_are_honest(tmp_path):
    from app.services.backup_restore import (
        RestoreOrchestratorRequest,
        restore_api_response_from_orchestrator,
    )

    published = _published_backup(tmp_path)
    restarts: list[list[str]] = []
    request = RestoreOrchestratorRequest(
        filename=published.archive_path.name,
        backup_target_dir=published.archive_path.parent,
        current_app_version="0.1.0",
        current_schema_version=None,
        restore_roots=_restore_roots(tmp_path),
        required_roles=["users_db", "jwt_secret", "vapid_private_key", "vapid_public_key"],
        staging_parent=tmp_path / "staging",
        backup_parent=tmp_path / "pre-restore",
        ledger_id="restore-attempt-1",
        restart_command=["systemctl", "restart", "homecam-server"],
    )

    body = restore_api_response_from_orchestrator(
        request,
        restart_runner=lambda argv: restarts.append(argv),
    )

    assert body["ok"] is True
    assert body["restored"] is True
    assert body["filename"] == published.archive_path.name
    assert body["manifest_id"]
    assert body["changed_file_count"] == 6
    assert body["restart_required"] is True
    assert body["restart_applied"] is True
    assert body["ledger_id"] == "restore-attempt-1"
    assert restarts == [["systemctl", "restart", "homecam-server"]]


def test_given_compatibility_fails_when_response_built_then_not_restored_is_typed(tmp_path):
    from app.services.backup_restore import (
        RestoreOrchestratorRequest,
        restore_api_response_from_orchestrator,
    )

    published = _published_backup(tmp_path)
    request = RestoreOrchestratorRequest(
        filename=published.archive_path.name,
        backup_target_dir=published.archive_path.parent,
        current_app_version="different-version",
        current_schema_version=None,
        restore_roots=_restore_roots(tmp_path),
        required_roles=["users_db", "jwt_secret", "vapid_private_key", "vapid_public_key"],
        staging_parent=tmp_path / "staging",
        backup_parent=tmp_path / "pre-restore",
        ledger_id="restore-attempt-2",
    )

    body = restore_api_response_from_orchestrator(request)

    assert body == {
        "ok": False,
        "restored": False,
        "status": "not_restored",
        "reason": "app_version_mismatch",
        "phase": "compatibility",
    }
