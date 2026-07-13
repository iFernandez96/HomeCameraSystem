def _post_endpoint_for(path: str):
    from app.main import app
    from app.routes import control

    for route in app.routes:
        if getattr(route, "original_router", None) is not control.router:
            continue
        prefix = route.include_context.prefix
        for child_route in route.original_router.routes:
            child_path = f"{prefix}{child_route.path}"
            if child_path == path and "POST" in child_route.methods:
                return child_route.endpoint
    raise AssertionError(f"POST route not mounted: {path}")


async def test_given_backup_post_without_required_files_when_called_then_no_success_is_claimed(tmp_path, monkeypatch):
    from app.config import settings
    from app.services.backup_crypto import generate_recovery_keypair
    from app.services.backup_ledger import read_attempts

    backup_root = tmp_path / "backups"
    backup_root.mkdir()
    monkeypatch.setattr(settings, "backup_target_dir", backup_root)
    monkeypatch.setattr(settings, "backup_ledger_path", tmp_path / "backup-ledger.jsonl")
    private_key = tmp_path / "recovery-private.pem"
    public_key = tmp_path / "recipient-public.pem"
    generate_recovery_keypair(
        private_key_path=private_key,
        public_key_path=public_key,
    )
    monkeypatch.setattr(settings, "backup_recipient_public_key_path", public_key)
    monkeypatch.setattr(settings, "backup_status_path", tmp_path / "backup-status.json")
    endpoint = _post_endpoint_for("/api/system/backup")

    body = await endpoint()

    assert body["ok"] is False
    assert body["status"] == "not_backed_up"
    assert body["reason"] == "required persisted file is missing"
    assert "note" not in body
    assert [path.name for path in backup_root.iterdir()] == [".maintenance.lock"]
    rows = read_attempts(settings.backup_ledger_path)
    assert len(rows) == 1
    assert rows[0]["operation"] == "backup"
    assert rows[0]["ok"] is False


async def test_given_restore_post_when_missing_archive_requested_then_no_success_is_claimed(tmp_path, monkeypatch):
    from app.config import settings
    from app.routes.control import _RestoreBody
    from app.services.backup_ledger import read_attempts

    backup_root = tmp_path / "backups"
    backup_root.mkdir()
    monkeypatch.setattr(settings, "backup_target_dir", backup_root)
    monkeypatch.setattr(settings, "backup_ledger_path", tmp_path / "backup-ledger.jsonl")
    endpoint = _post_endpoint_for("/api/system/restore")

    body = await endpoint(
        _RestoreBody(backup_path="missing-homecam-backup.tar.gz")
    )

    assert body["ok"] is False
    assert body["restored"] is False
    assert body["reason"] == "backup archive not found"
    assert "note" not in body
    rows = read_attempts(settings.backup_ledger_path)
    assert len(rows) == 1
    assert rows[0]["operation"] == "restore"
    assert rows[0]["ok"] is False
