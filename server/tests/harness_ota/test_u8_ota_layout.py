from app.services.ota_layout import detect_scratch_deploy_layout


def test_given_complete_staged_bundle_when_detected_then_required_paths_are_identified(
    tmp_path,
):
    root = tmp_path / "bundle"
    (root / "client" / "dist").mkdir(parents=True)
    (root / "client" / "dist" / "index.html").write_text("new client\n", encoding="utf-8")
    (root / "detection").mkdir()
    (root / "detection" / "detect.py").write_text("print('detect')\n", encoding="utf-8")
    target = tmp_path / "client_dist"
    target.mkdir()

    result = detect_scratch_deploy_layout(root, client_dist_target=target)

    assert result.status == "detected"
    assert result.can_apply is True
    assert result.layout is not None
    assert result.layout.staged_client_dist == root / "client" / "dist"
    assert result.layout.staged_detection_entry == root / "detection" / "detect.py"
    assert result.layout.client_dist_target == target


def test_given_incomplete_layout_when_detected_then_rejected_without_writes(tmp_path):
    root = tmp_path / "bundle"
    (root / "client" / "dist").mkdir(parents=True)
    target = tmp_path / "client_dist"
    target.mkdir()
    before = sorted(path.relative_to(root).as_posix() for path in root.rglob("*"))

    result = detect_scratch_deploy_layout(root, client_dist_target=target)

    assert result.status == "rejected"
    assert result.reason == "incomplete_layout"
    assert result.missing == ("client/dist/index.html", "detection/detect.py")
    assert result.can_apply is False
    assert sorted(path.relative_to(root).as_posix() for path in root.rglob("*")) == before
