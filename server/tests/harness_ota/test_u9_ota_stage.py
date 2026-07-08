from datetime import UTC, datetime

from app.services.ota_stage import stage_artifact_to_versioned_dir


def fixed_clock():
    return datetime(2026, 7, 8, 13, 0, tzinfo=UTC)


def _tree_snapshot(path):
    return sorted(
        (child.relative_to(path).as_posix(), child.read_bytes())
        for child in path.rglob("*")
        if child.is_file()
    )


def test_given_directory_artifact_when_staged_then_versioned_staging_dir_is_created(
    tmp_path,
):
    artifact = tmp_path / "artifact"
    artifact.mkdir()
    (artifact / "compose.yaml").write_text("services: {}\n", encoding="utf-8")
    (artifact / ".env").write_text("HOMECAM_VERSION=1.2.4\n", encoding="utf-8")
    (artifact / "data").mkdir()
    (artifact / "data" / ".keep").write_text("keep\n", encoding="utf-8")
    staging_root = tmp_path / "staging"

    result = stage_artifact_to_versioned_dir(
        artifact,
        version="1.2.4",
        staging_root=staging_root,
        clock=fixed_clock,
    )

    assert result.status == "staged"
    assert result.can_apply is True
    assert result.staging_dir == staging_root / "1.2.4"
    assert (result.staging_dir / "compose.yaml").is_file()
    assert (result.staging_dir / ".ota-stage.json").is_file()
    assert not (staging_root / ".1.2.4.tmp").exists()


def test_given_live_and_persisted_data_dirs_when_artifact_staged_then_they_are_untouched(
    tmp_path,
):
    artifact = tmp_path / "artifact"
    artifact.mkdir()
    (artifact / "compose.yaml").write_text("services: {}\n", encoding="utf-8")
    (artifact / ".env").write_text("HOMECAM_VERSION=1.2.4\n", encoding="utf-8")
    (artifact / "data").mkdir()
    live = tmp_path / "live"
    data = tmp_path / "persisted-data"
    live.mkdir()
    data.mkdir()
    (live / "current.txt").write_text("1.2.3\n", encoding="utf-8")
    (data / "clip.bin").write_bytes(b"persisted")
    before_live = _tree_snapshot(live)
    before_data = _tree_snapshot(data)

    result = stage_artifact_to_versioned_dir(
        artifact,
        version="1.2.4",
        staging_root=tmp_path / "staging",
        clock=fixed_clock,
    )

    assert result.status == "staged"
    assert _tree_snapshot(live) == before_live
    assert _tree_snapshot(data) == before_data
