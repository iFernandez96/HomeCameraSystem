from app.services.ota_apply import switch_active_version_pointer


def test_given_staged_version_when_apply_transaction_runs_then_active_pointer_switches_atomically(
    tmp_path,
):
    active_pointer = tmp_path / "deploy" / "active-version"
    active_pointer.parent.mkdir()
    active_pointer.write_text("1.2.3\n", encoding="utf-8")
    staged = tmp_path / "staging" / "1.2.4"
    staged.mkdir(parents=True)

    result = switch_active_version_pointer(
        active_pointer=active_pointer,
        version="1.2.4",
        staged_version_dir=staged,
    )

    assert result.status == "applied"
    assert result.can_restart is True
    assert result.previous_version == "1.2.3"
    assert result.active_version == "1.2.4"
    assert active_pointer.read_text(encoding="utf-8") == "1.2.4\n"
    assert not active_pointer.with_name("active-version.tmp").exists()


def test_given_missing_staged_version_when_apply_transaction_runs_then_current_pointer_remains(
    tmp_path,
):
    active_pointer = tmp_path / "deploy" / "active-version"
    active_pointer.parent.mkdir()
    active_pointer.write_text("1.2.3\n", encoding="utf-8")

    result = switch_active_version_pointer(
        active_pointer=active_pointer,
        version="1.2.4",
        staged_version_dir=tmp_path / "staging" / "1.2.4",
    )

    assert result.status == "rejected"
    assert result.reason == "missing_staged_version_dir"
    assert result.can_restart is False
    assert active_pointer.read_text(encoding="utf-8") == "1.2.3\n"
    assert len(list(active_pointer.parent.glob("active-version*"))) == 1
