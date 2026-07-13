"""PR-001 deployment-boundary regression checks."""
from pathlib import Path

import yaml


ROOT = Path(__file__).resolve().parents[2]


def _compose(path: str):
    return yaml.safe_load((ROOT / path).read_text(encoding="utf-8"))


def _environment(service):
    values = service.get("environment", [])
    assert isinstance(values, list)
    return set(values)


def test_server_is_loopback_only_and_ota_is_unconditionally_disabled():
    server = _compose("deploy/docker-compose.yml")["services"]["server"]
    assert server["ports"] == ["127.0.0.1:8000:8000"]

    environment = _environment(server)
    assert "HOMECAM_OTA_DISABLED=1" in environment
    assert not any(
        value.startswith("HOMECAM_OTA_DISABLED=${") for value in environment
    )


def test_mediamtx_control_planes_are_loopback_but_ice_media_remains_reachable():
    config = _compose("deploy/mediamtx.yml")
    assert config["rtspAddress"] == "127.0.0.1:8554"
    assert config["rtspTransports"] == ["tcp"]
    assert config["webrtcAddress"] == "127.0.0.1:8889"
    assert config["webrtcLocalTCPAddress"] == ":8189"
    assert config["webrtcLocalUDPAddress"] == ":8189"


def test_observability_has_no_anonymous_or_direct_remote_listener():
    services = _compose("deploy/docker-compose.grafana.yml")["services"]
    prometheus = services["prometheus"]
    grafana = services["grafana"]

    assert "ports" not in prometheus
    assert prometheus["expose"] == ["9090"]
    assert grafana["ports"] == ["127.0.0.1:3000:3000"]

    environment = _environment(grafana)
    assert "GF_AUTH_ANONYMOUS_ENABLED=false" in environment
    assert "GF_USERS_ALLOW_SIGN_UP=false" in environment


def test_prometheus_scrapes_server_only_over_the_internal_compose_network():
    prometheus = _compose("deploy/prometheus/prometheus.yml")
    jobs = prometheus["scrape_configs"]
    homecam = next(job for job in jobs if job["job_name"] == "homecam")
    targets = homecam["static_configs"][0]["targets"]

    assert homecam["metrics_path"] == "/metrics"
    assert targets == ["server:8000"]
    assert all("127.0.0.1" not in target for target in targets)

    network = _compose("deploy/docker-compose.yml")["networks"]["default"]
    assert network["name"] == "homecam-net"
    assert network["ipam"]["config"] == [
        {"subnet": "172.30.0.0/24", "gateway": "172.30.0.1"}
    ]


def test_backup_container_gets_only_the_read_only_recipient_public_key():
    server = _compose("deploy/docker-compose.yml")["services"]["server"]
    backup_key_mount = next(
        volume
        for volume in server["volumes"]
        if isinstance(volume, dict)
        and volume.get("target") == "/run/secrets/homecam-backup-recipient.pem"
    )
    assert backup_key_mount == {
        "type": "bind",
        "source": "/etc/homecam/backup-recipient.pem",
        "target": "/run/secrets/homecam-backup-recipient.pem",
        "read_only": True,
        "bind": {"create_host_path": False},
    }
    environment = _environment(server)
    assert (
        "BACKUP_RECIPIENT_PUBLIC_KEY_PATH="
        "/run/secrets/homecam-backup-recipient.pem"
    ) in environment
    assert "BACKUP_STATUS_PATH=/app/secrets/backup-status.json" in environment
    assert "BACKUP_RETENTION_COUNT=${BACKUP_RETENTION_COUNT:-14}" in environment
    assert not any("RECOVERY_PRIVATE" in value for value in environment)


def test_local_encrypted_backup_timer_is_daily_and_persistent():
    timer = (ROOT / "deploy/systemd/homecam-backup.timer").read_text(
        encoding="utf-8"
    )
    service = (ROOT / "deploy/systemd/homecam-backup.service").read_text(
        encoding="utf-8"
    )

    assert "OnCalendar=*-*-* 03:15:00" in timer
    assert "Persistent=true" in timer
    assert "RandomizedDelaySec=30m" in timer
    assert "python -m app.scripts.run_backup" in (
        ROOT / "deploy/run-encrypted-backup.sh"
    ).read_text(encoding="utf-8")
    assert "ExecStart=/bin/sh " in service
    assert "replic" not in service.lower()
