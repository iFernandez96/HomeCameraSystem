def _manifest(**overrides):
    manifest = {
        "v": 1,
        "created_at": "2026-07-08T12:00:00Z",
        "app_version": "0.1.0",
        "schema_version": 3,
        "files": [
            {
                "path": "users_db/users.db",
                "role": "users_db",
                "size": 6,
                "sha256": "0" * 64,
                "mode": 0o600,
                "required": True,
            }
        ],
    }
    manifest.update(overrides)
    return manifest


def test_given_matching_versions_when_compatibility_checked_then_result_is_compatible():
    from app.services.backup_restore import check_restore_compatibility

    result = check_restore_compatibility(
        _manifest(),
        current_app_version="0.1.0",
        current_schema_version=3,
    )

    assert result.compatible is True
    assert result.reason is None


def test_given_mismatched_versions_when_compatibility_checked_then_typed_incompatible_results_returned():
    from app.services.backup_restore import check_restore_compatibility

    assert (
        check_restore_compatibility(
            _manifest(v=999),
            current_app_version="0.1.0",
            current_schema_version=3,
        ).reason
        == "manifest_version_mismatch"
    )
    assert (
        check_restore_compatibility(
            _manifest(app_version="9.9.9"),
            current_app_version="0.1.0",
            current_schema_version=3,
        ).reason
        == "app_version_mismatch"
    )
    assert (
        check_restore_compatibility(
            _manifest(schema_version=4),
            current_app_version="0.1.0",
            current_schema_version=3,
        ).reason
        == "schema_version_mismatch"
    )
