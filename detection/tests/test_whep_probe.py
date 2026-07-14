import sys
import threading
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from metrics import Metrics  # noqa: E402
from whep_probe import H264_RTP_CAPS, ProbeResult, WhepProbeScheduler  # noqa: E402


class FakeRunner(object):
    def __init__(self, results):
        self.results = list(results)
        self.calls = []

    def run(self, rung, timeout_s):
        self.calls.append((rung, timeout_s))
        result = self.results.pop(0)
        result.rung = rung
        return result


def result(kind="success", reason="", recoverable=False, checked_at=100.0):
    return ProbeResult(
        "",
        kind,
        reason,
        checked_at,
        ttff_ms=123.4 if kind == "success" else 0.0,
        signaling_ok=kind in ("success", "no_media"),
        media_received=kind == "success",
        recoverable=recoverable,
    )


def test_offer_caps_pin_a_valid_dynamic_rtp_payload_type_for_gstreamer_114():
    assert "payload=96" in H264_RTP_CAPS


def test_every_rung_is_serialized_and_repeats_at_its_bounded_cadence():
    now = [0.0]
    runner = FakeRunner([result(), result(), result(), result()])
    scheduler = WhepProbeScheduler(
        runner,
        Metrics(),
        lambda _result: None,
        rungs=(("cam", 60.0), ("cam_lq", 300.0), ("cam_uq", 300.0)),
        now=lambda: now[0],
    )

    assert scheduler.run_due_once(now=0.0).rung == "cam"
    assert scheduler.run_due_once(now=9.9) is None
    assert scheduler.run_due_once(now=10.0).rung == "cam_lq"
    assert scheduler.run_due_once(now=20.0).rung == "cam_uq"
    assert scheduler.run_due_once(now=59.9) is None
    assert scheduler.run_due_once(now=60.0).rung == "cam"
    assert runner.calls == [
        ("cam", 8.0),
        ("cam_lq", 8.0),
        ("cam_uq", 8.0),
        ("cam", 8.0),
    ]


def test_signaling_success_without_rtp_is_a_typed_failure_metric():
    metrics = Metrics()
    runner = FakeRunner([result("no_media", "timeout_no_rtp", True)])
    scheduler = WhepProbeScheduler(
        runner, metrics, lambda _result: None, rungs=(("cam", 60.0),), now=lambda: 0.0
    )

    probe = scheduler.run_due_once(now=0.0)

    assert probe.signaling_ok is True
    assert probe.media_received is False
    assert metrics.whep_probe_result == "no_media"
    assert metrics.whep_probe_fail_reason == "timeout_no_rtp"
    assert metrics.whep_probe_consec_fails == 1
    assert metrics.whep_probe_ttff_ms == 0.0


def test_three_local_failures_debounce_to_exactly_one_recovery_request():
    requested = []
    failures = [result("no_media", "timeout_no_rtp", True) for _ in range(5)]
    runner = FakeRunner(failures)
    scheduler = WhepProbeScheduler(
        runner,
        Metrics(),
        requested.append,
        rungs=(("cam", 1.0),),
        failure_threshold=3,
        now=lambda: 0.0,
    )

    for now in range(5):
        scheduler.run_due_once(now=float(now))

    assert len(requested) == 1
    assert requested[0].reason == "timeout_no_rtp"
    assert scheduler.recovery_needed() is True


def test_success_rearms_one_recovery_for_a_later_distinct_outage():
    requested = []
    runner = FakeRunner(
        [
            result("no_media", "timeout_no_rtp", True),
            result("no_media", "timeout_no_rtp", True),
            result("no_media", "timeout_no_rtp", True),
            result("success"),
            result("signaling_failure", "whep_unreachable", True),
            result("signaling_failure", "whep_unreachable", True),
            result("signaling_failure", "whep_unreachable", True),
        ]
    )
    scheduler = WhepProbeScheduler(
        runner,
        Metrics(),
        requested.append,
        rungs=(("cam", 1.0),),
        failure_threshold=3,
        now=lambda: 0.0,
    )

    for now in range(7):
        scheduler.run_due_once(now=float(now))

    assert len(requested) == 2
    assert scheduler.recovery_needed() is True


def test_probe_backend_or_grant_unavailable_never_restarts_camera():
    requested = []
    runner = FakeRunner(
        [result("probe_unavailable", "backend_importerror", False) for _ in range(3)]
    )
    scheduler = WhepProbeScheduler(
        runner,
        Metrics(),
        requested.append,
        rungs=(("cam", 1.0),),
        failure_threshold=3,
        now=lambda: 0.0,
    )

    for now in range(3):
        scheduler.run_due_once(now=float(now))

    assert requested == []


def test_concurrent_scheduler_call_cannot_start_a_second_probe():
    entered = threading.Event()
    release = threading.Event()

    class BlockingRunner(object):
        def run(self, rung, timeout_s):
            entered.set()
            assert release.wait(2.0)
            return result()

    scheduler = WhepProbeScheduler(
        BlockingRunner(), Metrics(), lambda _result: None,
        rungs=(("cam", 60.0),), now=lambda: 0.0,
    )
    thread = threading.Thread(target=lambda: scheduler.run_due_once(now=0.0))
    thread.start()
    assert entered.wait(2.0)
    try:
        assert scheduler.run_due_once(now=0.0) is None
    finally:
        release.set()
        thread.join(2.0)
    assert not thread.is_alive()
