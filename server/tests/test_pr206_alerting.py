from __future__ import annotations

from pathlib import Path

import yaml


ROOT = Path(__file__).resolve().parents[2]


EXPECTED_OPERATIONAL_ALERTS = {
    "HomecamBackupStatusMissing",
    "HomecamBackupStale",
    "HomecamBackupFailed",
    "HomecamRecordingStorageUnavailable",
    "HomecamRootStorageProbeFailed",
    "HomecamRootDiskLow",
    "HomecamWhepProbeFailed",
    "HomecamWhepExternalCellularOnlyFailure",
    "HomecamUpdateFailed",
    "HomecamRestoreFailed",
    "HomecamServerUnavailable",
    "HomecamServerRecoveryLoop",
    "HomecamServerSupervisorStateInvalid",
    "HomecamServerRestarted",
}


def test_given_pr206_rules_when_loaded_then_every_required_condition_is_covered():
    config = yaml.safe_load(
        (ROOT / "deploy/prometheus/alerts.yml").read_text(encoding="utf-8")
    )
    rules = {
        rule["alert"]: rule
        for group in config["groups"]
        for rule in group["rules"]
    }
    assert EXPECTED_OPERATIONAL_ALERTS <= rules.keys()
    for name in EXPECTED_OPERATIONAL_ALERTS:
        rule = rules[name]
        assert rule["expr"]
        assert rule["labels"]["severity"] in {"critical", "warning"}
        annotations = rule["annotations"]
        assert set(annotations) == {"summary", "description"}
        text = " ".join(annotations.values()).lower()
        assert "{{" not in text and "$" not in text
        assert not any(secret in text for secret in ("password=", "token=", "cookie="))


def test_given_observability_stack_when_loaded_then_alert_delivery_is_independent():
    compose = yaml.safe_load(
        (ROOT / "deploy/docker-compose.grafana.yml").read_text(encoding="utf-8")
    )
    services = compose["services"]
    assert {"prometheus", "alertmanager", "alert-receiver"} <= services.keys()
    receiver = services["alert-receiver"]
    assert receiver["entrypoint"][:2] == ["uvicorn", "app.alert_receiver:app"]
    assert "ports" not in receiver
    assert "homecam-secrets:/app/secrets:ro" in receiver["volumes"]
    assert services["alertmanager"]["ports"] == ["127.0.0.1:9093:9093"]

    prometheus = yaml.safe_load(
        (ROOT / "deploy/prometheus/prometheus.yml").read_text(encoding="utf-8")
    )
    targets = prometheus["alerting"]["alertmanagers"][0]["static_configs"][0]["targets"]
    assert targets == ["alertmanager:9093"]

    manager = yaml.safe_load(
        (ROOT / "deploy/alertmanager/alertmanager.yml").read_text(encoding="utf-8")
    )
    assert manager["route"]["group_by"] == ["alertname", "drill"]
    webhook_config = manager["receivers"][0]["webhook_configs"][0]
    assert webhook_config == {
        "url": "http://alert-receiver:9095/alerts",
        "send_resolved": True,
        "max_alerts": 1,
        "timeout": "60s",
    }


def test_given_android_offline_monitor_when_reviewed_then_it_has_no_jetson_process_dependency():
    monitor = (ROOT / "android-wrapper/src/main/java/com/example/homecamerasystem/JetsonHealthMonitor.java").read_text(encoding="utf-8")
    manifest = (ROOT / "android-wrapper/src/main/AndroidManifest.xml").read_text(encoding="utf-8")
    assert "JobScheduler" in monitor
    assert ".setPersisted(true)" in monitor
    assert "FAILURES_BEFORE_OFFLINE" in (ROOT / "android-wrapper/src/main/java/com/example/homecamerasystem/JetsonHealthState.java").read_text(encoding="utf-8")
    assert 'android:name=".JetsonHealthJobService"' in manifest
    assert "alert-receiver" not in monitor


def test_alert_drill_includes_all_critical_rules_and_server_restart():
    script = (ROOT / "deploy/alert-drill.sh").read_text(encoding="utf-8")
    assert "severity: critical" in script
    assert "HomecamServerRestarted" in script
    assert "status=firing" in script
    assert "status=resolved" in script
    assert "wait_for_delivery firing" in script
    assert "wait_for_delivery resolved" in script
