from app.services.ota_preflight import preflight_staged_deploy


def _write_staged_bundle(staging_dir, *, include_detection=True):
    staging_dir.mkdir(parents=True)
    (staging_dir / "client" / "dist").mkdir(parents=True)
    (staging_dir / "client" / "dist" / "index.html").write_text("new\n", encoding="utf-8")
    if include_detection:
        (staging_dir / "detection").mkdir()
        (staging_dir / "detection" / "detect.py").write_text("print('detect')\n", encoding="utf-8")


def test_given_valid_staged_layout_when_preflight_runs_then_apply_allowed_without_pointer_change(
    tmp_path,
):
    active_pointer = tmp_path / "deploy" / "active-version"
    active_pointer.parent.mkdir()
    active_pointer.write_text("1.2.3\n", encoding="utf-8")
    client_dist_target = tmp_path / "client_dist"
    client_dist_target.mkdir()
    (client_dist_target / "index.html").write_text("old\n", encoding="utf-8")
    staging_dir = tmp_path / "staging" / "1.2.4"
    _write_staged_bundle(staging_dir)

    result = preflight_staged_deploy(
        staging_dir,
        client_dist_target=client_dist_target,
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
    client_dist_target = tmp_path / "client_dist"
    client_dist_target.mkdir()
    (client_dist_target / "index.html").write_text("old\n", encoding="utf-8")
    staging_dir = tmp_path / "staging" / "1.2.4"
    _write_staged_bundle(staging_dir, include_detection=False)

    result = preflight_staged_deploy(
        staging_dir,
        client_dist_target=client_dist_target,
        active_pointer=active_pointer,
    )

    assert result.status == "rejected"
    assert result.reason == "incomplete_layout"
    assert result.can_apply is False
    assert active_pointer.read_text(encoding="utf-8") == "1.2.3\n"
    inert = staging_dir / ".ota-inert.json"
    assert inert.is_file()
    assert "1.2.3" in inert.read_text(encoding="utf-8")
