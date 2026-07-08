from app.services.ota_preflight import preflight_staged_deploy


def _write_staged_layout(staging_dir, persisted_data_dir, *, compose_uses_data=True):
    staging_dir.mkdir(parents=True)
    compose_volume = "${HOMECAM_DATA_DIR}:/data" if compose_uses_data else "./cache:/cache"
    (staging_dir / "compose.yaml").write_text(
        f"services:\n  homecam:\n    volumes:\n      - {compose_volume}\n",
        encoding="utf-8",
    )
    (staging_dir / ".env").write_text(
        f"HOMECAM_DATA_DIR={persisted_data_dir}\n",
        encoding="utf-8",
    )
    (staging_dir / "data").mkdir()


def test_given_valid_staged_layout_when_preflight_runs_then_apply_allowed_without_pointer_change(
    tmp_path,
):
    active_pointer = tmp_path / "deploy" / "active-version"
    active_pointer.parent.mkdir()
    active_pointer.write_text("1.2.3\n", encoding="utf-8")
    persisted_data = tmp_path / "data"
    persisted_data.mkdir()
    staging_dir = tmp_path / "staging" / "1.2.4"
    _write_staged_layout(staging_dir, persisted_data)

    result = preflight_staged_deploy(
        staging_dir,
        persisted_data_dir=persisted_data,
        active_pointer=active_pointer,
    )

    assert result.status == "passed"
    assert result.can_apply is True
    assert result.active_version == "1.2.3"
    assert active_pointer.read_text(encoding="utf-8") == "1.2.3\n"
    assert not (staging_dir / ".ota-inert.json").exists()


def test_given_failed_preflight_when_checked_then_staging_is_inert_and_current_stays_active(
    tmp_path,
):
    active_pointer = tmp_path / "deploy" / "active-version"
    active_pointer.parent.mkdir()
    active_pointer.write_text("1.2.3\n", encoding="utf-8")
    persisted_data = tmp_path / "data"
    persisted_data.mkdir()
    staging_dir = tmp_path / "staging" / "1.2.4"
    _write_staged_layout(staging_dir, persisted_data, compose_uses_data=False)

    result = preflight_staged_deploy(
        staging_dir,
        persisted_data_dir=persisted_data,
        active_pointer=active_pointer,
    )

    assert result.status == "rejected"
    assert result.reason == "compose_missing_persisted_data_reference"
    assert result.can_apply is False
    assert active_pointer.read_text(encoding="utf-8") == "1.2.3\n"
    inert = staging_dir / ".ota-inert.json"
    assert inert.is_file()
    assert "1.2.3" in inert.read_text(encoding="utf-8")
