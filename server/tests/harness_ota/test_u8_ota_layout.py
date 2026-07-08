from app.services.ota_layout import detect_scratch_deploy_layout


def test_given_complete_temp_clone_layout_when_detected_then_required_paths_are_identified(
    tmp_path,
):
    root = tmp_path / "clone"
    root.mkdir()
    (root / "compose.yaml").write_text("services: {}\n", encoding="utf-8")
    (root / ".env").write_text("HOMECAM_VERSION=1.2.4\n", encoding="utf-8")
    (root / "data").mkdir()

    result = detect_scratch_deploy_layout(root)

    assert result.status == "detected"
    assert result.can_apply is True
    assert result.layout is not None
    assert result.layout.compose_path == root / "compose.yaml"
    assert result.layout.env_path == root / ".env"
    assert result.layout.data_path == root / "data"


def test_given_incomplete_layout_when_detected_then_rejected_without_writes(tmp_path):
    root = tmp_path / "clone"
    root.mkdir()
    (root / "docker-compose.yml").write_text("services: {}\n", encoding="utf-8")
    before = sorted(path.relative_to(root).as_posix() for path in root.rglob("*"))

    result = detect_scratch_deploy_layout(root)

    assert result.status == "rejected"
    assert result.reason == "incomplete_layout"
    assert result.missing == ("env", "data")
    assert result.can_apply is False
    assert sorted(path.relative_to(root).as_posix() for path in root.rglob("*")) == before
