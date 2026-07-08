import os


def _write_file(path, payload=b"x"):
    path.write_bytes(payload)
    return path


def test_given_retention_policy_when_applied_then_only_old_valid_backups_are_deleted(tmp_path):
    from app.services.backup_archive import apply_backup_retention

    target_dir = tmp_path / "backups"
    target_dir.mkdir()
    newest = _write_file(target_dir / "homecam-backup-20260708T120002Z.tar.gz")
    middle = _write_file(target_dir / "homecam-backup-20260708T120001Z.tar.gz")
    oldest = _write_file(target_dir / "homecam-backup-20260708T120000Z.tar.gz")
    oldest_manifest = _write_file(
        target_dir / "homecam-backup-20260708T120000Z.tar.gz.manifest.json"
    )
    invalid_name = _write_file(target_dir / "operator-notes.txt")
    partial = _write_file(target_dir / "homecam-backup-20260708T115959Z.tar.gz.tmp~")
    for index, path in enumerate([oldest, middle, newest]):
        os.utime(path, (100 + index, 100 + index))

    deleted = apply_backup_retention(
        target_dir=target_dir,
        keep_newest=2,
        protect=newest,
    )

    assert oldest in deleted
    assert oldest_manifest in deleted
    assert not oldest.exists()
    assert newest.exists()
    assert middle.exists()
    assert invalid_name.exists()
    assert partial.exists()


def test_given_just_created_backup_outside_keep_window_when_retention_runs_then_it_is_protected(tmp_path):
    from app.services.backup_archive import apply_backup_retention

    target_dir = tmp_path / "backups"
    target_dir.mkdir()
    just_created = _write_file(target_dir / "homecam-backup-20260708T120000Z.tar.gz")
    newer = _write_file(target_dir / "homecam-backup-20260708T120001Z.tar.gz")
    os.utime(just_created, (100, 100))
    os.utime(newer, (200, 200))

    deleted = apply_backup_retention(
        target_dir=target_dir,
        keep_newest=1,
        protect=just_created,
    )

    assert deleted == []
    assert just_created.exists()
    assert newer.exists()
