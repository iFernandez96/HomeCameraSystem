"""Deployment contract for PR-102's shared worker credential."""
from __future__ import annotations

import os
from pathlib import Path

import yaml


ROOT = Path(__file__).resolve().parents[2]


def test_compose_mounts_exact_secret_read_only_without_implicit_creation():
    compose = yaml.safe_load((ROOT / "deploy/docker-compose.yml").read_text())
    server = compose["services"]["server"]
    mount = next(
        item
        for item in server["volumes"]
        if isinstance(item, dict)
        and item.get("target") == "/run/secrets/homecam-worker-auth"
    )
    assert mount == {
        "type": "bind",
        "source": "/etc/homecam/worker-auth.secret",
        "target": "/run/secrets/homecam-worker-auth",
        "read_only": True,
        "bind": {"create_host_path": False},
    }
    environment = "\n".join(server["environment"])
    assert "HOMECAM_WORKER_AUTH_FILE=/run/secrets/homecam-worker-auth" in environment
    assert "127.0.0.1,::1,172.30.0.1" in environment


def test_host_workers_receive_only_the_secret_path():
    for unit in (
        "homecam-detect.service",
        "homecam-audio-detect.service",
    ):
        text = (ROOT / "deploy/systemd" / unit).read_text()
        assert (
            "Environment=HOMECAM_WORKER_AUTH_FILE=/etc/homecam/worker-auth.secret"
            in text
        )
        assert "Bearer " not in text


def test_provisioner_is_executable_explicit_rotation_and_secret_safe():
    path = ROOT / "deploy/provision-worker-secret.sh"
    text = path.read_text()
    assert os.access(path, os.X_OK)
    assert "openssl rand -hex 32" in text
    assert "--rotate" in text
    assert "chmod 0640" in text
    assert "-m 0750" in text
    assert "root:${SECRET_GROUP}" in text
    assert "echo \"$" not in text
    assert "cat \"$SECRET_PATH\"" not in text


def test_installer_provisions_before_starting_server_or_worker():
    text = (ROOT / "deploy/install-jetson.sh").read_text()
    provision = text.index("deploy/provision-worker-secret.sh")
    server_start = text.index("enable --now homecam-server.service")
    worker_start = text.index("enable --now homecam-detect.service")
    assert provision < server_start
    assert provision < worker_start
