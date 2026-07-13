from __future__ import annotations

import json
import time
from pathlib import Path

import pytest


def _keypair(tmp_path: Path, stem: str = "recovery") -> tuple[Path, Path]:
    from app.services.backup_crypto import generate_recovery_keypair

    private_key = tmp_path / f"{stem}-private.pem"
    public_key = tmp_path / f"{stem}-public.pem"
    generate_recovery_keypair(
        private_key_path=private_key,
        public_key_path=public_key,
    )
    return private_key, public_key


def _draft(tmp_path: Path, payload: bytes = b"secret configuration"):
    from app.services.backup_archive import write_archive_to_temp
    from app.services.backup_manifest import (
        BackupInventoryEntry,
        build_manifest_from_inventory,
    )

    state_root = tmp_path / "state"
    state_root.mkdir(exist_ok=True)
    state_path = state_root / "operator-private-settings.json"
    state_path.write_bytes(payload)
    inventory = [
        BackupInventoryEntry(
            role="detection_config",
            path=state_path,
            allowed_root=state_root,
            required=True,
        )
    ]
    manifest = build_manifest_from_inventory(
        inventory,
        app_version="0.1.0",
        created_at="2026-07-13T12:00:00Z",
    )
    return write_archive_to_temp(
        target_dir=tmp_path / "backups",
        manifest=manifest,
        inventory=inventory,
        temp_stem="homecam-backup-20260713T120000Z",
    )


def _publish(tmp_path: Path, *, payload: bytes = b"secret configuration"):
    from app.services.backup_archive import publish_encrypted_backup_atomically

    private_key, public_key = _keypair(tmp_path)
    draft = _draft(tmp_path, payload)
    published = publish_encrypted_backup_atomically(
        draft=draft,
        target_dir=tmp_path / "backups",
        final_archive_name="homecam-backup-20260713T120000Z.hcbk",
        recipient_public_key_path=public_key,
    )
    return private_key, public_key, published


def test_recovery_private_key_is_private_and_recipient_identity_is_stable(tmp_path):
    from app.services.backup_crypto import recipient_fingerprint

    private_key, public_key = _keypair(tmp_path)

    assert private_key.stat().st_mode & 0o777 == 0o600
    assert public_key.stat().st_mode & 0o777 == 0o644
    fingerprint = recipient_fingerprint(public_key)
    assert len(fingerprint) == 64
    assert fingerprint == recipient_fingerprint(public_key)


def test_published_backup_is_ciphertext_only_and_plaintext_intermediates_are_removed(
    tmp_path,
):
    marker = b"operator@example.invalid private-camera-name api-key-material"
    private_key, public_key, published = _publish(tmp_path, payload=marker)

    ciphertext = published.archive_path.read_bytes()
    assert published.archive_path.stat().st_mode & 0o777 == 0o600
    assert marker not in ciphertext
    assert b"operator-private-settings.json" not in ciphertext
    assert b"detection_config" not in ciphertext
    assert private_key.read_bytes() not in ciphertext
    assert public_key.read_bytes() not in ciphertext
    assert not list((tmp_path / "backups").glob("*.tar.gz"))
    assert not list((tmp_path / "backups").glob("*.manifest.json"))
    assert not list((tmp_path / "backups").glob("*.tmp~"))


@pytest.mark.parametrize("offset", [0, 20, -1])
def test_tampered_ciphertext_fails_closed_without_decrypted_output(tmp_path, offset):
    from app.services.backup_archive import decrypt_encrypted_backup
    from app.services.backup_crypto import BackupCryptoError

    private_key, _public_key, published = _publish(tmp_path)
    damaged = bytearray(published.archive_path.read_bytes())
    damaged[offset] ^= 0x01
    published.archive_path.write_bytes(damaged)

    with pytest.raises((BackupCryptoError, ValueError)):
        decrypt_encrypted_backup(
            encrypted_path=published.archive_path,
            recovery_private_key_path=private_key,
            staging_parent=tmp_path / "restore",
        )

    assert not list((tmp_path / "restore").glob("*"))


def test_wrong_recovery_key_fails_closed(tmp_path):
    from app.services.backup_archive import decrypt_encrypted_backup
    from app.services.backup_crypto import BackupCryptoError

    _private_key, _public_key, published = _publish(tmp_path)
    wrong_private, _wrong_public = _keypair(tmp_path, "wrong")

    with pytest.raises(BackupCryptoError, match="authentication failed"):
        decrypt_encrypted_backup(
            encrypted_path=published.archive_path,
            recovery_private_key_path=wrong_private,
            staging_parent=tmp_path / "restore",
        )

    assert not list((tmp_path / "restore").glob("*"))


def test_overbroad_recovery_key_permissions_fail_closed(tmp_path):
    from app.services.backup_archive import decrypt_encrypted_backup
    from app.services.backup_crypto import BackupCryptoError

    private_key, _public_key, published = _publish(tmp_path)
    private_key.chmod(0o644)

    with pytest.raises(BackupCryptoError, match="permissions are too broad"):
        decrypt_encrypted_backup(
            encrypted_path=published.archive_path,
            recovery_private_key_path=private_key,
            staging_parent=tmp_path / "restore",
        )

    assert not list((tmp_path / "restore").glob("*"))


def test_encryption_failure_removes_plaintext_and_partial_ciphertext(
    tmp_path,
    monkeypatch,
):
    from app.services import backup_archive

    _private_key, public_key = _keypair(tmp_path)
    draft = _draft(tmp_path)

    def fail_after_partial(_chunks, *, recipient_public_key_path, output_path):
        del recipient_public_key_path
        output_path.write_bytes(b"partial")
        raise OSError("injected encryption failure")

    monkeypatch.setattr(backup_archive, "encrypt_chunks_to_file", fail_after_partial)
    with pytest.raises(OSError, match="injected encryption failure"):
        backup_archive.publish_encrypted_backup_atomically(
            draft=draft,
            target_dir=tmp_path / "backups",
            final_archive_name="homecam-backup-20260713T120000Z.hcbk",
            recipient_public_key_path=public_key,
        )

    assert not draft.archive_tmp_path.exists()
    assert list((tmp_path / "backups").iterdir()) == []


def test_name_collision_preserves_existing_ciphertext_and_removes_new_plaintext(
    tmp_path,
):
    from app.services.backup_archive import publish_encrypted_backup_atomically

    _private_key, public_key, published = _publish(tmp_path)
    existing = published.archive_path.read_bytes()
    second = _draft(tmp_path, b"different protected state")

    with pytest.raises(FileExistsError, match="already exists"):
        publish_encrypted_backup_atomically(
            draft=second,
            target_dir=tmp_path / "backups",
            final_archive_name=published.archive_path.name,
            recipient_public_key_path=public_key,
        )

    assert published.archive_path.read_bytes() == existing
    assert not second.archive_tmp_path.exists()
    assert not list((tmp_path / "backups").glob("*.tmp~"))


def test_backup_status_reports_age_and_explicit_off_device_deferral(tmp_path):
    from app.services.backup_status import read_backup_status, record_backup_success

    status_path = tmp_path / "backup-status.json"
    record_backup_success(
        status_path,
        filename="homecam-backup-20260713T120000Z.hcbk",
        archive_digest="a" * 64,
        recipient_fingerprint="b" * 64,
        now=100.0,
    )

    status = read_backup_status(status_path, now=125.5)
    assert status["backup_age_s"] == 25.5
    assert status["encrypted"] is True
    assert status["replication_status"] == "deferred_off_device"
    assert "deferred" in status["replication_detail"]
    assert status_path.stat().st_mode & 0o777 == 0o600


def test_encrypted_backup_restores_to_clean_scratch_under_rto(tmp_path):
    from app.services.backup_restore import (
        RestoreOrchestratorRequest,
        restore_api_response_from_orchestrator,
    )

    private_key, _public_key, published = _publish(
        tmp_path,
        payload=b'{"confidence_threshold":0.75}',
    )
    started = time.monotonic()
    response = restore_api_response_from_orchestrator(
        RestoreOrchestratorRequest(
            filename=published.archive_path.name,
            backup_target_dir=published.archive_path.parent,
            current_app_version="0.1.0",
            current_schema_version=None,
            restore_roots={
                "detection_config": tmp_path / "scratch" / "detection_config"
            },
            required_roles=[],
            staging_parent=tmp_path / "restore-staging",
            backup_parent=tmp_path / "pre-restore",
            ledger_id="pr202-rto",
            recovery_private_key_path=private_key,
        )
    )
    elapsed = time.monotonic() - started

    assert response["ok"] is True
    assert response["restored"] is True
    assert elapsed < 60.0
    restored = tmp_path / "scratch" / "detection_config" / "operator-private-settings.json"
    assert json.loads(restored.read_text(encoding="utf-8")) == {
        "confidence_threshold": 0.75
    }
    assert not list((tmp_path / "restore-staging").glob(".restore-*.tmp~"))


def test_plaintext_migration_replaces_archive_and_sidecar_with_ciphertext(
    tmp_path,
    monkeypatch,
):
    from app.config import settings
    from app.scripts import migrate_plaintext_backups
    from app.services.backup_archive import publish_backup_atomically

    _private_key, public_key = _keypair(tmp_path)
    draft = _draft(tmp_path)
    plaintext = publish_backup_atomically(
        draft=draft,
        target_dir=tmp_path / "backups",
        final_archive_name="homecam-backup-20260713T120000Z.tar.gz",
    )
    monkeypatch.setattr(settings, "backup_target_dir", tmp_path / "backups")
    monkeypatch.setattr(settings, "backup_recipient_public_key_path", public_key)

    assert migrate_plaintext_backups.main() == 0

    encrypted = tmp_path / "backups" / "homecam-backup-20260713T120000Z.hcbk"
    assert encrypted.is_file()
    assert not plaintext.archive_path.exists()
    assert not plaintext.manifest_path.exists()
    assert not list((tmp_path / "backups").glob("*.tmp~"))


def test_cross_process_maintenance_lock_rejects_a_second_operation(tmp_path):
    from app.services.backup_restore import (
        MaintenanceConflict,
        cross_process_maintenance_lease,
    )

    lock_path = tmp_path / "backups" / ".maintenance.lock"
    with cross_process_maintenance_lease(lock_path, "backup"):
        with pytest.raises(MaintenanceConflict) as exc_info:
            with cross_process_maintenance_lease(lock_path, "restore"):
                pass

    assert exc_info.value.active_operation == "cross_process_maintenance"
    assert exc_info.value.requested_operation == "restore"
    assert lock_path.stat().st_mode & 0o777 == 0o600
