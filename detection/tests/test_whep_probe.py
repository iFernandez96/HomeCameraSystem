import sys
import threading
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from metrics import Metrics  # noqa: E402
from whep_probe import (  # noqa: E402
    H264_RTP_CAPS,
    ProbeResult,
    WhepProbeScheduler,
    _ice_candidates_by_mline,
    _sdp_shape,
    _with_gathered_candidates,
)


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
    assert "packetization-mode=(string)1" in H264_RTP_CAPS
    assert "profile-level-id=(string)42e01f" in H264_RTP_CAPS


def test_sdp_shape_keeps_negotiation_evidence_without_ips_or_credentials():
    raw = "\r\n".join((
        "m=video 9 UDP/TLS/RTP/SAVPF 96",
        "a=recvonly",
        "a=ice-ufrag:secret",
        "a=ice-pwd:more-secret",
        "a=candidate:1 1 UDP 1 192.0.2.4 12345 typ host",
    ))
    shape = _sdp_shape(raw)
    assert shape == {
        "media": [{"kind": "video", "port": "9", "payloads": ["96"]}],
        "directions": ["recvonly"],
        "codecs": [],
        "candidate_count": 1,
        "candidate_kinds": [
            {"transport": "udp", "family": "ipv4", "type": "host"},
        ],
        "mids": [],
        "groups": [],
        "ice_credentials": 2,
        "fingerprints": 0,
        "rtcp_mux": False,
    }
    assert "192.0.2.4" not in str(shape)
    assert "secret" not in str(shape)


def test_gstreamer_114_candidates_are_added_to_non_trickle_offer_once():
    offer = "\r\n".join((
        "v=0",
        "m=video 9 UDP/TLS/RTP/SAVPF 96",
        "a=recvonly",
        "a=mid:video0",
        "",
    ))
    candidate = "candidate:1 1 UDP 1 192.0.2.4 12345 typ host"

    complete = _with_gathered_candidates(offer, (candidate, candidate))

    assert complete.count("a=" + candidate) == 1
    assert complete.count("a=end-of-candidates") == 1
    assert complete.count("a=group:BUNDLE video0") == 1
    assert complete.endswith("\r\n")
    assert _sdp_shape(complete)["candidate_count"] == 1


def test_candidate_assembly_preserves_offer_when_no_candidate_is_available():
    offer = "v=0\nm=video 9 UDP/TLS/RTP/SAVPF 96\na=recvonly\n"

    assert _with_gathered_candidates(offer, ()) == offer


def test_remote_candidates_are_extracted_with_their_media_index():
    answer = "\r\n".join((
        "m=audio 9 UDP/TLS/RTP/SAVPF 111",
        "a=candidate:audio-private-value",
        "m=video 9 UDP/TLS/RTP/SAVPF 96",
        "a=candidate:video-private-value",
    ))

    assert _ice_candidates_by_mline(answer) == [
        (0, "candidate:audio-private-value"),
        (1, "candidate:video-private-value"),
    ]


def test_every_rung_is_serialized_and_repeats_at_its_bounded_cadence():
    now = [0.0]
    runner = FakeRunner([result(), result(), result(), result(), result()])
    scheduler = WhepProbeScheduler(
        runner,
        Metrics(),
        lambda _result: None,
        rungs=(("cam", 60.0), ("cam_lq", 300.0), ("cam_uq", 300.0)),
        now=lambda: now[0],
    )

    assert scheduler.run_due_once(now=0.0).rung == "cam"
    assert scheduler.run_due_once(now=59.9) is None
    assert scheduler.run_due_once(now=60.0).rung == "cam"
    assert scheduler.run_due_once(now=74.9) is None
    assert scheduler.run_due_once(now=75.0).rung == "cam_lq"
    assert scheduler.run_due_once(now=119.9) is None
    assert scheduler.run_due_once(now=120.0).rung == "cam"
    assert scheduler.run_due_once(now=149.9) is None
    assert scheduler.run_due_once(now=150.0).rung == "cam_uq"
    assert runner.calls == [
        ("cam", 8.0),
        ("cam", 8.0),
        ("cam_lq", 8.0),
        ("cam", 8.0),
        ("cam_uq", 8.0),
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
