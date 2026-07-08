import hashlib
import json
import shlex
import shutil
from pathlib import Path

import pytest

from app.services.ota_ledger import read_events
from app.services.ota_orchestrator import OtaApplyRequest, orchestrate_ota_apply


REPO_ROOT = Path(__file__).resolve().parents[3]
PRODUCTION_LEDGER = REPO_ROOT / ".jetson-snapshot" / "proof_fixtures" / "ota" / "ota-ledger.jsonl"
REAL_MANIFEST = REPO_ROOT / "dist-ota" / "0.1.2" / "manifest.json"
REAL_ARTIFACT = REPO_ROOT / "dist-ota" / "0.1.2" / "homecam-ota-0.1.2.tar.gz"

pytestmark = pytest.mark.skipif(
    not (PRODUCTION_LEDGER.is_file() and REAL_MANIFEST.is_file() and REAL_ARTIFACT.is_file()),
    reason="U19 production OTA parity fixtures are not present",
)


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _load_manifest() -> dict[str, object]:
    return json.loads(REAL_MANIFEST.read_text(encoding="utf-8"))


def _terminal_rows(rows: list[dict[str, object]]) -> list[dict[str, object]]:
    return [row for row in rows if row.get("status") in {"applied", "rejected", "rolled_back"}]


def _final_success(rows: list[dict[str, object]]) -> dict[str, object]:
    successes = [row for row in rows if row.get("status") == "applied"]
    assert len(successes) == 1
    return successes[0]


def _stage_rejection(rows: list[dict[str, object]]) -> dict[str, object]:
    matches = [
        row
        for row in rows
        if row.get("status") == "rejected"
        and row.get("reason") == "staging_version_exists"
        and row.get("metadata", {}).get("target_version") == "0.1.2"
    ]
    assert matches
    return matches[-1]


def _request_from_production_row(
    tmp_path: Path, production_terminal: dict[str, object], *, attempt_id: str
) -> OtaApplyRequest:
    metadata = production_terminal["metadata"]
    assert isinstance(metadata, dict)
    manifest = _load_manifest()
    artifact = manifest["artifact"]
    assert isinstance(artifact, dict)

    tmp_path.mkdir(parents=True)
    artifacts_dir = tmp_path / "artifacts"
    artifacts_dir.mkdir()
    shutil.copy2(REAL_ARTIFACT, artifacts_dir / str(artifact["name"]))
    manifest_path = tmp_path / "manifest.json"
    shutil.copy2(REAL_MANIFEST, manifest_path)

    deploy = tmp_path / "scratch-deploy-clone"
    deploy.mkdir()
    active_pointer = deploy / "active-version"
    active_pointer.write_text(f"{metadata['current_version']}\n", encoding="utf-8")
    persisted = tmp_path / "scratch-persisted"
    persisted.mkdir()
    client_dist_target = tmp_path / "scratch-client-dist"
    client_dist_target.mkdir()
    (client_dist_target / "index.html").write_text("old client\n", encoding="utf-8")

    host_commands = metadata.get("host_commands") or []
    restart_command = (
        shlex.split(str(host_commands[-1]))
        if isinstance(host_commands, list) and host_commands
        else ["docker", "restart", "homecam-server"]
    )

    return OtaApplyRequest(
        attempt_id=attempt_id,
        manifest_path=manifest_path,
        artifacts_dir=artifacts_dir,
        staging_root=tmp_path / "staging",
        persisted_data_dir=persisted,
        client_dist_target=client_dist_target,
        active_pointer=active_pointer,
        ledger_path=tmp_path / "ota-ledger.jsonl",
        current_version=str(metadata["current_version"]),
        expected_artifact_size=(artifacts_dir / str(artifact["name"])).stat().st_size,
        restart_command=restart_command,
        env={},
    )


class RecordingRestartRunner:
    def __init__(self) -> None:
        self.commands: list[tuple[str, ...]] = []

    def __call__(self, argv: tuple[str, ...]) -> dict[str, object]:
        self.commands.append(argv)
        return {"recorded": True, "returncode": 0}


def _command_shape(command: str) -> tuple[str, ...]:
    parts = shlex.split(command)
    normalized = []
    for part in parts:
        if part.endswith("/detection/"):
            normalized.append("<staged-detection>/")
        else:
            normalized.append(part)
    return tuple(normalized)


def _command_shapes(commands: tuple[str, ...] | list[str]) -> tuple[tuple[str, ...], ...]:
    return tuple(_command_shape(command) for command in commands)


def test_u19_replays_real_production_ledger_success_and_stage_rejection(tmp_path):
    production_rows = read_events(PRODUCTION_LEDGER)
    assert len(production_rows) == 21
    assert len(_terminal_rows(production_rows)) == 7

    production_success = _final_success(production_rows)
    success_metadata = production_success["metadata"]
    assert isinstance(success_metadata, dict)
    manifest = _load_manifest()
    manifest_artifact = manifest["artifact"]
    assert isinstance(manifest_artifact, dict)

    assert manifest["version"] == success_metadata["target_version"] == "0.1.2"
    assert _sha256(REAL_MANIFEST) == success_metadata["manifest_id"]
    assert manifest_artifact["sha256"] == success_metadata["artifact_digest"]
    assert _sha256(REAL_ARTIFACT) == manifest_artifact["sha256"]

    success_request = _request_from_production_row(
        tmp_path / "success",
        production_success,
        attempt_id="u19-replay-success",
    )
    runner = RecordingRestartRunner()

    success_result = orchestrate_ota_apply(
        success_request,
        health_poller=lambda: {"ok": True, "status": "restart_deferred"},
        restart_runner=runner,
    )

    assert success_metadata["target_version"] == success_result.version
    assert production_success["status"] == success_result.status == "applied"
    assert success_result.applied is True
    assert list(success_result.applied_components) == success_metadata["applied_components"]
    assert _command_shapes(success_result.host_commands) == _command_shapes(
        success_metadata["host_commands"]
    )
    assert success_request.active_pointer.read_text(encoding="utf-8").strip() == success_metadata[
        "target_version"
    ]
    assert runner.commands == [success_result.host_commands]

    replay_rows = read_events(success_request.ledger_path)
    assert [row["status"] for row in replay_rows] == ["requested", "started", "applied"]
    assert replay_rows[-1]["metadata"]["version"] == success_metadata["version"]

    production_rejection = _stage_rejection(production_rows)
    rejection_metadata = production_rejection["metadata"]
    assert isinstance(rejection_metadata, dict)
    rejection_request = _request_from_production_row(
        tmp_path / "stage-rejection",
        production_rejection,
        attempt_id="u19-replay-stage-rejection",
    )
    rejection_request.staging_root.joinpath(str(rejection_metadata["target_version"])).mkdir(
        parents=True
    )

    rejection_result = orchestrate_ota_apply(
        rejection_request,
        health_poller=lambda: {"ok": True},
        restart_runner=RecordingRestartRunner(),
    )

    assert rejection_result.status == production_rejection["status"] == "rejected"
    assert rejection_result.reason == production_rejection["reason"] == "staging_version_exists"
    assert rejection_result.phase == rejection_metadata["phase"] == "stage"
    assert rejection_request.active_pointer.read_text(encoding="utf-8").strip() == rejection_metadata[
        "current_version"
    ]
