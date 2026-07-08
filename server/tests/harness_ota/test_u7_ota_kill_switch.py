import json

from app.services import ota_kill_switch


def _write_manifest(path):
    path.write_text(
        json.dumps(
            {
                "version": "1.2.4",
                "artifact": {"name": "homecam.tar.gz", "sha256": "a" * 64},
            }
        ),
        encoding="utf-8",
    )


def test_given_kill_switch_disabled_when_gate_checked_then_manifest_read_happens_before_rejection(
    tmp_path, monkeypatch
):
    manifest_path = tmp_path / "manifest.json"
    _write_manifest(manifest_path)
    calls: list[str] = []
    real_reader = ota_kill_switch.read_local_manifest

    def tracking_reader(path):
        calls.append(f"read:{path.name}")
        return real_reader(path)

    monkeypatch.setattr(ota_kill_switch, "read_local_manifest", tracking_reader)

    result = ota_kill_switch.read_manifest_then_check_apply_gate(
        manifest_path, env={"HOMECAM_OTA_DISABLED": "true"}
    )

    assert calls == ["read:manifest.json"]
    assert result.status == "rejected"
    assert result.reason == "kill_switch_disabled"
    assert result.manifest_result.can_apply is True
    assert result.can_apply is False


def test_given_kill_switch_not_set_when_gate_checked_then_apply_allowed_after_manifest_read(
    tmp_path,
):
    manifest_path = tmp_path / "manifest.json"
    _write_manifest(manifest_path)

    result = ota_kill_switch.read_manifest_then_check_apply_gate(manifest_path, env={})

    assert result.status == "allowed"
    assert result.can_apply is True
