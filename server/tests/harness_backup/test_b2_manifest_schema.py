def test_given_manifest_dict_when_validated_then_schema_is_accepted_without_touching_files(monkeypatch):
    from app.services.backup_manifest import make_manifest

    def fail_if_touched(*_args, **_kwargs):
        raise AssertionError("manifest validation must not touch live files")

    monkeypatch.setattr("pathlib.Path.exists", fail_if_touched)
    monkeypatch.setattr("pathlib.Path.read_bytes", fail_if_touched)
    monkeypatch.setattr("pathlib.Path.stat", fail_if_touched)

    manifest = make_manifest(
        created_at="2026-07-08T12:00:00Z",
        app_version="0.1.0",
        files=[
            {
                "path": "users_db/users.db",
                "role": "users_db",
                "size": 12,
                "sha256": "0" * 64,
                "mode": 0o600,
                "required": True,
            }
        ],
    )

    assert manifest["v"] == 1
    assert manifest["created_at"] == "2026-07-08T12:00:00Z"
    assert manifest["app_version"] == "0.1.0"
    assert manifest["files"][0]["role"] == "users_db"

