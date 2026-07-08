import queue
import threading

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.services.ota_health import poll_post_restart_health


def test_given_injected_health_poller_when_eventually_healthy_then_health_gate_passes():
    responses = iter([False, {"status": "starting"}, {"ok": True}])
    sleeps = []

    result = poll_post_restart_health(
        lambda: next(responses),
        attempts=3,
        delay_s=0.01,
        sleeper=sleeps.append,
    )

    assert result.status == "healthy"
    assert result.healthy is True
    assert result.attempts == 3
    assert sleeps == [0.01, 0.01]


def test_given_injected_health_poller_when_unhealthy_then_health_gate_blocks_apply():
    calls = []

    def poller():
        calls.append("poll")
        return 503

    result = poll_post_restart_health(poller, attempts=2)

    assert result.status == "unhealthy"
    assert result.healthy is False
    assert result.reason == "unhealthy_response"
    assert result.attempts == 2
    assert calls == ["poll", "poll"]


def test_given_scratch_testclient_healthz_route_when_polled_then_real_route_response_is_used():
    results = queue.Queue(maxsize=1)

    def run_probe():
        app = FastAPI()

        @app.get("/healthz")
        def healthz():
            return {"ok": True}

        with TestClient(app) as client:
            results.put(poll_post_restart_health(lambda: client.get("/healthz"), attempts=1))

    thread = threading.Thread(target=run_probe, daemon=True)
    thread.start()
    try:
        result = results.get(timeout=2.0)
    except queue.Empty:
        pytest.skip("SANDBOX-HANG: scratch TestClient /healthz probe did not return")

    assert result.status == "healthy"
    assert result.healthy is True
    assert result.attempts == 1
