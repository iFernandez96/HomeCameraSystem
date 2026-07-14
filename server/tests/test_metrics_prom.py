"""Prometheus /metrics endpoint (iter-189, Feature #11).

The endpoint is mounted at the **app root** (/metrics, NOT
/api/metrics), so the iter-184 auth gate doesn't apply — Prometheus
scrapers don't speak browser cookies. We pin that the route is
anonymously accessible and that the exposition format conforms to
the Prometheus text-based spec.
"""
from __future__ import annotations

import time

from fastapi.testclient import TestClient


def test_metrics_endpoint_returns_200_anonymously(client_anon: TestClient):
    """No cookie required — root-level route, NOT gated."""
    r = client_anon.get("/metrics")
    assert r.status_code == 200


def test_metrics_endpoint_returns_text_plain(client_anon: TestClient):
    """Prometheus expects `text/plain; version=0.0.4` or similar.
    PlainTextResponse defaults to `text/plain; charset=utf-8`,
    which Prometheus parses fine — pin the prefix so a refactor
    swap to JSONResponse breaks loudly."""
    r = client_anon.get("/metrics")
    ctype = r.headers.get("content-type", "")
    assert ctype.startswith("text/plain"), (
        "expected text/plain; got {!r}".format(ctype)
    )


def test_metrics_endpoint_contains_liveness_gauges(client_anon: TestClient):
    """The two 0/1 liveness gauges (worker_alive + detection_active)
    are always present, even when the worker is dead — that's
    itself useful information for alerting."""
    r = client_anon.get("/metrics")
    body = r.text
    assert "homecam_worker_alive" in body
    assert "homecam_detection_active" in body
    # Each metric MUST have its HELP + TYPE banner per the
    # exposition spec.
    assert "# HELP homecam_worker_alive" in body
    assert "# TYPE homecam_worker_alive gauge" in body


def test_metrics_endpoint_skips_worker_block_when_dead(client_anon: TestClient):
    """No heartbeat → no worker_* metrics. Absent metrics are how
    Prometheus alerts notice "the worker died." If we emitted
    e.g. worker_fps=0 instead, the alert would never fire."""
    r = client_anon.get("/metrics")
    body = r.text
    # Liveness gauges should still be there — they're in the
    # always-on block.
    assert "homecam_worker_alive 0" in body
    # But worker-specific metrics MUST be absent when worker is
    # dead (no heartbeat).
    assert "homecam_worker_fps" not in body
    assert "homecam_worker_infer_ms_recent" not in body


def test_metrics_endpoint_includes_worker_block_after_heartbeat(
    client_anon: TestClient,
):
    """After the worker heartbeats, the worker_* block appears."""
    r = client_anon.post(
        "/api/_internal/heartbeat",
        json={"fps": 5.0, "infer_ms_recent": 42.5},
    )
    assert r.status_code == 200
    r = client_anon.get("/metrics")
    body = r.text
    assert "homecam_worker_alive 1" in body
    assert "homecam_worker_fps 5.0" in body
    assert "homecam_worker_infer_ms_recent 42.5" in body


def test_metrics_endpoint_uses_counter_type_for_cumulative_fields(
    client_anon: TestClient,
):
    """Worker `dropped` and `mediamtx_restarts` are monotonic
    counters, not gauges. Prometheus' rate() requires the TYPE
    declaration to differ from gauge."""
    client_anon.post(
        "/api/_internal/heartbeat",
        json={"dropped": 7, "mediamtx_restarts": 2},
    )
    r = client_anon.get("/metrics")
    body = r.text
    assert "# TYPE homecam_worker_dropped_total counter" in body
    assert "# TYPE homecam_worker_mediamtx_restarts_total counter" in body
    assert "homecam_worker_dropped_total 7" in body
    assert "homecam_worker_mediamtx_restarts_total 2" in body


def test_metrics_endpoint_includes_thumb_ms_when_set(client_anon: TestClient):
    """iter-187's `thumb_ms_recent` flows through to the Prometheus
    exposition — operator sees it in their dashboard alongside the
    inference latencies."""
    client_anon.post(
        "/api/_internal/heartbeat",
        json={"thumb_ms_recent": 78.9},
    )
    r = client_anon.get("/metrics")
    body = r.text
    assert "homecam_worker_thumb_ms_recent 78.9" in body


def test_metrics_endpoint_exposes_only_fresh_real_power_samples(client_anon: TestClient):
    """Power history is scrapeable, but a stale value must disappear rather
    than continuing to look like the Jetson's current draw."""
    now = time.time()
    client_anon.post(
        "/api/_internal/heartbeat",
        json={
            "power_sensor_status": 1,
            "power_watts": 6.287,
            "power_volts": 5.03,
            "power_amps": 1.25,
            "power_sample_ts": now,
            "power_read_failures": 0,
        },
    )
    body = client_anon.get("/metrics").text
    assert "homecam_input_power_watts 6.287" in body
    assert "homecam_input_voltage_volts 5.03" in body
    assert "homecam_input_current_amps 1.25" in body
    assert "# TYPE homecam_power_read_failures_total counter" in body

    client_anon.post(
        "/api/_internal/heartbeat",
        json={"power_sensor_status": 1, "power_sample_ts": now - 30.0},
    )
    stale_body = client_anon.get("/metrics").text
    assert "homecam_input_power_watts" not in stale_body


def test_metrics_endpoint_skips_none_probes_silently(client_anon: TestClient):
    """A None probe (e.g., /sys path missing in the test container)
    must NOT emit a `name None` line — Prometheus would treat that
    as a parse error. The renderer's `_line` skips on None."""
    r = client_anon.get("/metrics")
    body = r.text
    # Whatever probes ARE present must not have None values.
    for line in body.splitlines():
        if line.startswith("#"):
            continue
        if not line:
            continue
        # Each metric line is `name value`. Value must parse as
        # a number.
        parts = line.rsplit(" ", 1)
        assert len(parts) == 2, "malformed metric line: {!r}".format(line)
        value_str = parts[1]
        try:
            float(value_str)
        except ValueError:
            raise AssertionError(
                "metric value isn't numeric: {!r}".format(line)
            )
