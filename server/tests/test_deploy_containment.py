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
