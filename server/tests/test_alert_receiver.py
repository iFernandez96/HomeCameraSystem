from __future__ import annotations

import logging

from fastapi.testclient import TestClient

from app import alert_receiver


def webhook(status: str = "firing", **alert_changes):
    alert = {
        "status": status,
        "labels": {"alertname": "HomecamBackupStale", "severity": "critical"},
        "annotations": {
            "summary": "Encrypted backup is stale",
            "description": "The latest encrypted backup is too old.",
        },
        "startsAt": "2026-07-13T00:00:00Z",
        "endsAt": "2026-07-13T01:00:00Z",
        "generatorURL": "http://prometheus/graph",
        "fingerprint": "abc123",
    }
    alert.update(alert_changes)
    return {
        "version": "4",
        "groupKey": "{}:{alertname=\"HomecamBackupStale\"}",
        "truncatedAlerts": 0,
        "status": status,
        "receiver": "homecam-web-push",
        "groupLabels": {"alertname": "HomecamBackupStale"},
        "commonLabels": {"alertname": "HomecamBackupStale", "severity": "critical"},
        "commonAnnotations": alert["annotations"],
        "externalURL": "http://alertmanager:9093",
        "notification_reason": "firing" if status == "firing" else "resolved",
        "alerts": [alert],
    }


class _Sender:
    sent = 1
    payloads = []

    def __init__(self, *, persist_path):
        self.persist_path = persist_path

    def load_keys(self):
        return None

    async def send_all_readonly(self, payload):
        self.payloads.append(payload)
        return self.sent


def test_given_firing_alert_when_receiver_delivers_then_push_is_critical(monkeypatch):
    # arrange
    _Sender.sent = 1
    _Sender.payloads = []
    monkeypatch.setattr(alert_receiver, "PushService", _Sender)

    # act
    response = TestClient(alert_receiver.app).post("/alerts", json=webhook())

    # assert
    assert response.status_code == 200
    assert response.json() == {"ok": True, "sent": 1, "status": "firing"}
    assert _Sender.payloads == [{
        "title": "HomeCam alert: Encrypted backup is stale",
        "body": "The latest encrypted backup is too old.",
        "tag": "homecam-system-homecambackupstale",
        "url": "/settings",
        "importance": "critical",
        "require_interaction": True,
        "silent": False,
    }]


def test_given_resolved_alert_when_receiver_delivers_then_recovery_is_not_silent(
    monkeypatch,
):
    _Sender.sent = 1
    _Sender.payloads = []
    monkeypatch.setattr(alert_receiver, "PushService", _Sender)
    response = TestClient(alert_receiver.app).post(
        "/alerts",
        json=webhook("resolved"),
    )
    assert response.status_code == 200
    payload = _Sender.payloads[0]
    assert payload["title"].startswith("HomeCam recovered:")
    assert payload["importance"] == "normal"
    assert payload["require_interaction"] is False
    assert payload["silent"] is False


def test_given_no_offbox_delivery_when_receiver_runs_then_alertmanager_is_retried(
    monkeypatch,
):
    _Sender.sent = 0
    _Sender.payloads = []
    monkeypatch.setattr(alert_receiver, "PushService", _Sender)
    response = TestClient(alert_receiver.app).post("/alerts", json=webhook())
    assert response.status_code == 503
    assert response.json() == {"detail": "no off-box delivery"}


def test_given_oversized_or_unknown_payload_when_received_then_it_fails_closed(
    monkeypatch,
):
    monkeypatch.setattr(alert_receiver, "PushService", _Sender)
    client = TestClient(alert_receiver.app)
    unknown = webhook()
    unknown["unexpected"] = "field"
    assert client.post("/alerts", json=unknown).status_code == 422
    assert client.post("/alerts", content=b"x" * 65537).status_code == 413


def test_alert_receiver_health_discloses_no_operational_state():
    response = TestClient(alert_receiver.app).get("/healthz")
    assert response.status_code == 200
    assert response.json() == {"ok": True}


def test_drill_receipt_logs_only_a_strict_safe_identifier(monkeypatch, caplog):
    _Sender.sent = 1
    _Sender.payloads = []
    monkeypatch.setattr(alert_receiver, "PushService", _Sender)
    payload = webhook()
    payload["alerts"][0]["labels"]["drill"] = "pr206-1784000000"
    with caplog.at_level(logging.INFO, logger="uvicorn.error"):
        TestClient(alert_receiver.app).post("/alerts", json=payload)
    assert "drill=pr206-1784000000" in caplog.text

    caplog.clear()
    payload["alerts"][0]["labels"]["drill"] = "unsafe\nvalue"
    with caplog.at_level(logging.INFO, logger="uvicorn.error"):
        TestClient(alert_receiver.app).post("/alerts", json=payload)
    assert "drill=none" in caplog.text
    assert "unsafe" not in caplog.text
