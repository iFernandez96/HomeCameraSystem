import hashlib
import json
import tarfile
from datetime import UTC, datetime

from app.services.ota_ledger import read_events
from app.services.ota_orchestrator import OtaApplyRequest, orchestrate_ota_apply
from app.services.ota_restart import RecordingCommandRunner


def fixed_clock():
    return datetime(2026, 7, 8, 14, 0, tzinfo=UTC)


def _write_artifact_tree(root, persisted_data_dir):
    root.mkdir()
    (root / "compose.yaml").write_text(
        "services:\n  homecam:\n    volumes:\n      - ${HOMECAM_DATA_DIR}:/data\n",
        encoding="utf-8",
    )
    (root / ".env").write_text(
        f"HOMECAM_DATA_DIR={persisted_data_dir}\n",
        encoding="utf-8",
    )
    (root / "data").mkdir()


def _write_manifest(path, artifact_name, artifact_path, version="1.2.4"):
    digest = hashlib.sha256(artifact_path.read_bytes()).hexdigest()
    path.write_text(
        json.dumps(
            {
                "version": version,
                "artifact": {"name": artifact_name, "sha256": digest},
            }
        ),
        encoding="utf-8",
    )
    return digest


def _request(tmp_path):
    deploy = tmp_path / "deploy"
    deploy.mkdir()
    active_pointer = deploy / "active-version"
    active_pointer.write_text("1.2.3\n", encoding="utf-8")
    persisted = tmp_path / "persisted"
    persisted.mkdir()
    artifacts = tmp_path / "artifacts"
    artifacts.mkdir()
    staging_source = tmp_path / "stage-source"
    _write_artifact_tree(staging_source, persisted)
    artifact = artifacts / "homecam-1.2.4.tar"
    with tarfile.open(artifact, "w") as archive:
        for child in sorted(staging_source.rglob("*")):
            archive.add(child, arcname=child.relative_to(staging_source))
    manifest = tmp_path / "manifest.json"
    _write_manifest(manifest, artifact.name, artifact)
    return OtaApplyRequest(
        attempt_id="attempt-u15",
        manifest_path=manifest,
        artifacts_dir=artifacts,
        staging_root=tmp_path / "staging",
        persisted_data_dir=persisted,
        active_pointer=active_pointer,
        ledger_path=tmp_path / "ota-ledger.jsonl",
        current_version="1.2.3",
        expected_artifact_size=artifact.stat().st_size,
        restart_command=["systemctl", "restart", "homecam.service"],
        env={},
    )


def test_given_stage_preflight_apply_and_health_pass_when_orchestrated_then_applied_response_is_honest(
    tmp_path,
):
    request = _request(tmp_path)
    runner = RecordingCommandRunner()

    result = orchestrate_ota_apply(
        request,
        health_poller=lambda: {"ok": True},
        restart_runner=runner,
        clock=fixed_clock,
    )

    assert result.status == "applied"
    assert result.applied is True
    assert result.version == "1.2.4"
    assert result.ledger_id == "attempt-u15"
    assert result.reason is None
    assert request.active_pointer.read_text(encoding="utf-8") == "1.2.4\n"
    assert runner.commands == [("systemctl", "restart", "homecam.service")]
    rows = read_events(request.ledger_path)
    assert [row["status"] for row in rows] == ["requested", "started", "applied"]
    assert rows[-1]["reason"] == "health_passed"


def test_given_apply_succeeds_but_health_is_stubbed_when_orchestrated_then_rolled_back_without_success_fields(
    tmp_path,
):
    request = _request(tmp_path)

    result = orchestrate_ota_apply(
        request,
        health_poller=None,
        restart_runner=RecordingCommandRunner(),
        clock=fixed_clock,
    )

    assert result.status == "rolled_back"
    assert result.applied is False
    assert result.version is None
    assert result.ledger_id is None
    assert result.reason == "health_poller_missing"
    assert result.phase == "health"
    assert request.active_pointer.read_text(encoding="utf-8") == "1.2.3\n"
    rows = read_events(request.ledger_path)
    assert [row["status"] for row in rows] == ["requested", "started", "rolled_back"]
    assert rows[-1]["reason"] == "health_poller_missing"


def test_given_manifest_unavailable_when_orchestrated_then_typed_non_applied_result_has_no_ok_lie(
    tmp_path,
):
    request = _request(tmp_path)
    missing_manifest = OtaApplyRequest(
        **{**request.__dict__, "attempt_id": "attempt-missing", "manifest_path": tmp_path / "missing.json"}
    )

    result = orchestrate_ota_apply(
        missing_manifest,
        health_poller=lambda: {"ok": True},
        restart_runner=RecordingCommandRunner(),
        clock=fixed_clock,
    )

    assert result.status == "rejected"
    assert result.applied is False
    assert result.version is None
    assert result.ledger_id is None
    assert result.reason == "missing"
    assert result.phase == "manifest_gate"
    assert request.active_pointer.read_text(encoding="utf-8") == "1.2.3\n"
