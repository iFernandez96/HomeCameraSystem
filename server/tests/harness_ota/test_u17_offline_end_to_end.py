import hashlib
import json
import tarfile
from datetime import UTC, datetime
from pathlib import Path

from app.services.ota_ledger import read_events
from app.services.ota_orchestrator import OtaApplyRequest, orchestrate_ota_apply


TARGET_VERSION = "1.2.4"
CURRENT_VERSION = "1.2.3"


def fixed_clock():
    return datetime(2026, 7, 8, 15, 0, tzinfo=UTC)


def _assert_inside(root: Path, *paths: Path) -> None:
    resolved_root = root.resolve()
    for path in paths:
        resolved = path.resolve()
        assert resolved == resolved_root or resolved_root in resolved.parents


def _tree_sha256(root: Path) -> str:
    digest = hashlib.sha256()
    for child in sorted(root.rglob("*")):
        relative = child.relative_to(root).as_posix().encode("utf-8")
        if child.is_dir():
            digest.update(b"dir\0" + relative + b"\0")
            continue
        digest.update(b"file\0" + relative + b"\0")
        digest.update(hashlib.sha256(child.read_bytes()).digest())
    return digest.hexdigest()


def _write_deploy_state(root: Path) -> Path:
    root.mkdir(parents=True)
    active_pointer = root / "active-version"
    active_pointer.write_text(f"{CURRENT_VERSION}\n", encoding="utf-8")
    return active_pointer


def _write_artifact_source(root: Path) -> None:
    root.mkdir(parents=True)
    (root / "client" / "dist").mkdir(parents=True)
    (root / "client" / "dist" / "index.html").write_text("new client\n", encoding="utf-8")
    (root / "client" / "dist" / "asset.txt").write_text("asset bytes\n", encoding="utf-8")
    (root / "detection").mkdir()
    (root / "detection" / "detect.py").write_text("print('detect')\n", encoding="utf-8")


def _make_artifact(artifacts_dir: Path, source: Path) -> Path:
    artifacts_dir.mkdir()
    artifact = artifacts_dir / f"homecam-{TARGET_VERSION}.tar"
    with tarfile.open(artifact, "w") as archive:
        for child in sorted(source.rglob("*")):
            archive.add(child, arcname=child.relative_to(source))
    return artifact


def _write_manifest(manifest_path: Path, artifact: Path, *, sha256: str | None = None) -> str:
    digest = hashlib.sha256(artifact.read_bytes()).hexdigest()
    manifest_path.write_text(
        json.dumps(
            {
                "version": TARGET_VERSION,
                "artifact": {
                    "name": artifact.name,
                    "sha256": sha256 or digest,
                },
            },
            sort_keys=True,
        ),
        encoding="utf-8",
    )
    return digest


def _offline_request(tmp_path: Path, *, manifest_sha256: str | None = None) -> OtaApplyRequest:
    persisted = tmp_path / "scratch-persisted"
    persisted.mkdir()
    (persisted / "clip.bin").write_bytes(b"persisted camera bytes")
    deploy = tmp_path / "scratch-deploy-clone"
    active_pointer = _write_deploy_state(deploy)
    client_dist_target = tmp_path / "client_dist"
    client_dist_target.mkdir()
    (client_dist_target / "index.html").write_text("old client\n", encoding="utf-8")
    (client_dist_target / "old.txt").write_text("old asset\n", encoding="utf-8")
    artifacts = tmp_path / "artifacts"
    source = tmp_path / "artifact-source"
    _write_artifact_source(source)
    artifact = _make_artifact(artifacts, source)
    manifest = tmp_path / "manifest.json"
    _write_manifest(manifest, artifact, sha256=manifest_sha256)

    request = OtaApplyRequest(
        attempt_id="attempt-u17",
        manifest_path=manifest,
        artifacts_dir=artifacts,
        staging_root=tmp_path / "staging",
        persisted_data_dir=persisted,
        client_dist_target=client_dist_target,
        active_pointer=active_pointer,
        ledger_path=tmp_path / "ota-ledger.jsonl",
        current_version=CURRENT_VERSION,
        expected_artifact_size=artifact.stat().st_size,
        restart_command=["docker", "restart", "homecam-server"],
        env={},
    )
    _assert_inside(
        tmp_path,
        deploy,
        persisted,
        artifacts,
        source,
        artifact,
        manifest,
        request.staging_root,
        request.ledger_path,
        request.active_pointer,
        request.client_dist_target,
    )
    return request


class GuardedRecordingRunner:
    def __init__(self) -> None:
        self.commands: list[tuple[str, ...]] = []

    def __call__(self, argv: tuple[str, ...]) -> dict[str, object]:
        assert "sudo" not in argv
        self.commands.append(argv)
        return {"recorded": True, "returncode": 0}


def test_given_local_manifest_and_artifact_when_full_offline_orchestrator_runs_then_applied_result_is_honest(
    tmp_path,
):
    request = _offline_request(tmp_path)
    runner = GuardedRecordingRunner()
    health_polls = []

    def health_poller():
        health_polls.append("poll")
        return {"ok": True, "version": TARGET_VERSION}

    result = orchestrate_ota_apply(
        request,
        health_poller=health_poller,
        restart_runner=runner,
        clock=fixed_clock,
    )

    assert result.status == "applied"
    assert result.applied is True
    assert result.version == TARGET_VERSION
    assert result.ledger_id == "attempt-u17"
    assert result.reason is None
    assert result.phase is None
    assert result.applied_components == ("client",)
    assert result.host_commands[-1] == "docker restart homecam-server"
    assert request.active_pointer.read_text(encoding="utf-8") == f"{TARGET_VERSION}\n"
    assert request.client_dist_target.joinpath("index.html").read_text(
        encoding="utf-8"
    ) == "new client\n"
    assert not request.client_dist_target.joinpath("old.txt").exists()
    assert runner.commands == [result.host_commands]
    assert health_polls == ["poll"]

    staged = request.staging_root / TARGET_VERSION
    assert (staged / "client" / "dist" / "index.html").is_file()
    assert (staged / "detection" / "detect.py").is_file()
    assert (staged / ".ota-stage.json").is_file()

    rows = read_events(request.ledger_path)
    assert [row["status"] for row in rows] == ["requested", "started", "applied"]
    assert rows[0]["metadata"] == {"current_version": CURRENT_VERSION}
    assert rows[1]["metadata"] == {"version": TARGET_VERSION}
    assert rows[2]["reason"] == "health_passed"
    assert rows[2]["metadata"] == {
        "version": TARGET_VERSION,
        "applied_components": ["client"],
        "host_commands": list(result.host_commands),
        "ownership_restored": True,
    }


def test_given_bad_manifest_checksum_when_full_offline_orchestrator_runs_then_non_applied_and_scratch_roots_match(
    tmp_path,
):
    request = _offline_request(tmp_path, manifest_sha256="0" * 64)
    deploy_root = request.active_pointer.parent
    persisted_root = request.persisted_data_dir
    client_dist_before = _tree_sha256(request.client_dist_target)
    before_deploy = _tree_sha256(deploy_root)
    before_persisted = _tree_sha256(persisted_root)
    runner = GuardedRecordingRunner()

    result = orchestrate_ota_apply(
        request,
        health_poller=lambda: {"ok": True},
        restart_runner=runner,
        clock=fixed_clock,
    )

    assert result.status == "rejected"
    assert result.applied is False
    assert result.version is None
    assert result.ledger_id is None
    assert result.reason == "sha256_mismatch"
    assert result.phase == "artifact_integrity"
    assert request.active_pointer.read_text(encoding="utf-8") == f"{CURRENT_VERSION}\n"
    assert runner.commands == []
    assert not request.staging_root.exists()
    assert _tree_sha256(deploy_root) == before_deploy
    assert _tree_sha256(persisted_root) == before_persisted
    assert _tree_sha256(request.client_dist_target) == client_dist_before

    rows = read_events(request.ledger_path)
    assert [row["status"] for row in rows] == ["requested", "rejected"]
    assert rows[-1]["reason"] == "sha256_mismatch"
    assert rows[-1]["metadata"] == {
        "phase": "artifact_integrity",
        "version": TARGET_VERSION,
    }
