from app.services.ota_apply import apply_staged_client_dist


def test_given_staged_client_dist_when_apply_transaction_runs_then_client_bytes_are_swapped(
    tmp_path,
):
    active_pointer = tmp_path / "deploy" / "active-version"
    active_pointer.parent.mkdir()
    active_pointer.write_text("1.2.3\n", encoding="utf-8")
    staged = tmp_path / "staging" / "1.2.4"
    (staged / "client" / "dist").mkdir(parents=True)
    (staged / "client" / "dist" / "index.html").write_text("new client\n", encoding="utf-8")
    (staged / "detection").mkdir()
    (staged / "detection" / "detect.py").write_text("print('detect')\n", encoding="utf-8")
    target = tmp_path / "client_dist"
    target.mkdir()
    (target / "index.html").write_text("old client\n", encoding="utf-8")

    result = apply_staged_client_dist(
        active_pointer=active_pointer,
        version="1.2.4",
        staged_version_dir=staged,
        client_dist_target=target,
        restart_command=("docker", "restart", "homecam-server"),
    )

    assert result.status == "applied"
    assert result.can_restart is True
    assert result.previous_version == "1.2.3"
    assert result.active_version == "1.2.4"
    assert result.applied_components == ("client",)
    assert result.host_commands == (
        f"rsync -a --delete {(staged / 'detection').as_posix()}/ ./detection/",
        "docker restart homecam-server",
    )
    assert active_pointer.read_text(encoding="utf-8") == "1.2.4\n"
    assert (target / "index.html").read_text(encoding="utf-8") == "new client\n"
    assert (staged / ".ota-client-dist-backup" / "index.html").read_text(
        encoding="utf-8"
    ) == "old client\n"
    assert not active_pointer.with_name("active-version.tmp").exists()


def test_given_missing_staged_version_when_apply_transaction_runs_then_current_pointer_remains(
    tmp_path,
):
    active_pointer = tmp_path / "deploy" / "active-version"
    active_pointer.parent.mkdir()
    active_pointer.write_text("1.2.3\n", encoding="utf-8")

    target = tmp_path / "client_dist"
    target.mkdir()
    (target / "index.html").write_text("old client\n", encoding="utf-8")

    result = apply_staged_client_dist(
        active_pointer=active_pointer,
        version="1.2.4",
        staged_version_dir=tmp_path / "staging" / "1.2.4",
        client_dist_target=target,
        restart_command=("docker", "restart", "homecam-server"),
    )

    assert result.status == "rejected"
    assert result.reason == "missing_staged_client_dist"
    assert result.can_restart is False
    assert active_pointer.read_text(encoding="utf-8") == "1.2.3\n"
    assert (target / "index.html").read_text(encoding="utf-8") == "old client\n"
    assert len(list(active_pointer.parent.glob("active-version*"))) == 1
