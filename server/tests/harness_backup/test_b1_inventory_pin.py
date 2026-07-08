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


async def test_given_backup_post_scaffold_when_called_then_note_means_no_archive_written(tmp_path, monkeypatch):
    from app.config import settings

    backup_root = tmp_path / "backups"
    backup_root.mkdir()
    monkeypatch.setattr(settings, "backup_target_dir", backup_root)
    endpoint = _post_endpoint_for("/api/system/backup")

    body = await endpoint()

    assert body["note"] is not None
    assert list(backup_root.iterdir()) == []


async def test_given_restore_post_scaffold_when_missing_archive_requested_then_note_means_no_archive_read(tmp_path, monkeypatch):
    from app.config import settings
    from app.routes.control import _RestoreBody

    backup_root = tmp_path / "backups"
    backup_root.mkdir()
    monkeypatch.setattr(settings, "backup_target_dir", backup_root)
    endpoint = _post_endpoint_for("/api/system/restore")

    body = await endpoint(
        _RestoreBody(backup_path="missing-homecam-backup.tar.gz")
    )

    assert body["note"] is not None
    assert body["backup_path"] == "missing-homecam-backup.tar.gz"
