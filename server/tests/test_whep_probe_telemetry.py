from __future__ import annotations


def _report(client, result: str, network_type: str = "cellular"):
    return client.post(
        "/api/telemetry/whep-probe",
        json={
            "v": 1,
            "rung": "cam",
            "result": result,
            "network_type": network_type,
            "ttff_ms": 1200.0 if result == "first_frame" else 0.0,
            "ts": 1714000000.0,
        },
    )


def test_cellular_failures_are_alert_state_only_and_success_resets(client, client_anon):
    from app.services import whep_probe_status
    from app.services.health import worker_health

    assert _report(client_anon, "no_media").status_code == 401
    for _ in range(3):
        assert _report(client, "no_media").status_code == 200
    state = whep_probe_status.snapshot()
    assert state["consecutive_failures"] == 3
    # External advisory reports cannot mutate worker recovery counters.
    assert worker_health.last_metrics is None

    assert _report(client, "first_frame").status_code == 200
    assert whep_probe_status.snapshot()["consecutive_failures"] == 0


def test_non_cellular_report_never_changes_external_alert_state(client):
    assert _report(client, "no_media", "wifi").status_code == 200
    from app.services import whep_probe_status

    assert whep_probe_status.snapshot()["result"] == "not_reported"


def test_unknown_rung_fails_closed(client):
    response = client.post(
        "/api/telemetry/whep-probe",
        json={
            "v": 1, "rung": "unknown", "result": "no_media",
            "network_type": "cellular", "ttff_ms": 0.0,
            "ts": 1714000000.0,
        },
    )
    assert response.status_code == 422
