"""Offline contract tests for resumable Jetson SSH deployment."""

from __future__ import annotations

import os
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "deploy" / "cross-deploy-server.sh"


def _fake_tools(tmp_path: Path, fail_count: int) -> tuple[Path, Path]:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    counter = tmp_path / "ssh-count"

    docker = bin_dir / "docker"
    docker.write_text(
        """#!/usr/bin/env python3
import os, sys
for arg in sys.argv:
    if arg.startswith("type=docker,dest="):
        target = arg.split("dest=", 1)[1]
        with open(target, "wb") as handle:
            handle.write(b"fake-arm64-image")
        break
""",
        encoding="utf-8",
    )
    docker.chmod(0o755)

    ssh = bin_dir / "ssh"
    ssh.write_text(
        """#!/usr/bin/env python3
import os, sys
counter = os.environ["FAKE_SSH_COUNTER"]
try:
    with open(counter, "r", encoding="utf-8") as handle:
        count = int(handle.read())
except (OSError, ValueError):
    count = 0
count += 1
with open(counter, "w", encoding="utf-8") as handle:
    handle.write(str(count))
if count <= int(os.environ.get("FAKE_SSH_FAILURES", "0")):
    raise SystemExit(255)
if "sudo docker load" in " ".join(sys.argv):
    sys.stdin.buffer.read()
print("fake ssh ok")
""",
        encoding="utf-8",
    )
    ssh.chmod(0o755)
    return bin_dir, counter


def _run(tmp_path: Path, fail_count: int, timeout_s: int) -> subprocess.CompletedProcess[str]:
    bin_dir, counter = _fake_tools(tmp_path, fail_count)
    env = os.environ.copy()
    env.update(
        {
            "PATH": "{}:{}".format(bin_dir, env["PATH"]),
            "FAKE_SSH_COUNTER": str(counter),
            "FAKE_SSH_FAILURES": str(fail_count),
            "HOMECAM_SERVER_TAR": str(tmp_path / "server.tar"),
            "HOMECAM_SSH_RETRY_S": "1",
            "HOMECAM_SSH_WAIT_TIMEOUT_S": str(timeout_s),
        }
    )
    return subprocess.run(
        ["bash", str(SCRIPT), "fake-jetson"],
        cwd=ROOT,
        env=env,
        text=True,
        capture_output=True,
        timeout=12,
    )


def test_given_temporary_ssh_loss_when_cross_deploy_runs_then_it_resumes(tmp_path: Path):
    result = _run(tmp_path, fail_count=2, timeout_s=8)

    assert result.returncode == 0, result.stdout + result.stderr
    assert "offline or unreachable; retrying SSH" in result.stderr
    assert "is reachable again; resuming deployment" in result.stdout
    assert "done — server is up" in result.stdout


def test_given_persistent_ssh_loss_when_timeout_is_bounded_then_it_fails_cleanly(
    tmp_path: Path,
):
    result = _run(tmp_path, fail_count=100, timeout_s=1)

    assert result.returncode != 0
    assert "TIMEOUT waiting" in result.stderr
