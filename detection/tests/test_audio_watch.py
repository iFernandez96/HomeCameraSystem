import io
import json

import pytest

from audio_watch import (
    AudioRuntimeConfig,
    SignalRetryQueue,
    _require_loopback,
    apply_audio_config,
    build_signal,
    should_reset_audio_state,
)


def test_config_requires_explicit_enable_labels_and_honors_privacy():
    runtime = AudioRuntimeConfig()
    assert not runtime.active()
    warnings = apply_audio_config(runtime, {
        "audio_event_enabled": True,
        "audio_event_labels": ["audio_scream", "not_supported"],
        "operating_mode": "away",
    })
    assert warnings == []
    assert runtime.labels == ["audio_scream"]
    assert runtime.active()
    apply_audio_config(runtime, {"operating_mode": "privacy"})
    assert not runtime.active()


def test_bad_config_types_do_not_turn_audio_on():
    runtime = AudioRuntimeConfig()
    warnings = apply_audio_config(runtime, {
        "audio_event_enabled": "true",
        "audio_event_labels": "audio_scream",
        "operating_mode": "vacation",
    })
    assert len(warnings) == 3
    assert runtime.enabled is False
    assert runtime.labels == []
    assert runtime.operating_mode == "home"


def test_disable_label_removal_and_privacy_reset_pending_state():
    runtime = AudioRuntimeConfig()
    apply_audio_config(runtime, {
        "audio_event_enabled": True,
        "audio_event_labels": ["audio_scream", "audio_glass_break"],
    })
    previous = (True, tuple(runtime.labels), "home")
    assert should_reset_audio_state(previous, runtime) is False

    apply_audio_config(runtime, {"audio_event_labels": ["audio_scream"]})
    assert should_reset_audio_state(previous, runtime) is True
    previous = (True, tuple(runtime.labels), "home")

    apply_audio_config(runtime, {"audio_event_enabled": False})
    assert should_reset_audio_state(previous, runtime) is True
    previous = (False, tuple(runtime.labels), "home")

    apply_audio_config(runtime, {"operating_mode": "privacy"})
    assert should_reset_audio_state(previous, runtime) is True


def test_signal_has_metadata_only_and_bounded_contract_fields(monkeypatch):
    monkeypatch.setattr("signal_retry.uuid.uuid4", lambda: type(
        "U", (), {"hex": "event123"}
    )())
    payload = build_signal({
        "label": "audio_glass_break",
        "score": 1.8,
        "duration_s": 90.0,
        "correlation_id": "audio_glass_break_1000",
    }, "front_door", 1.0)
    assert payload == {
        "id": "event123",
        "source": "audio",
        "label": "audio_glass_break",
        "score": 1.0,
        "camera_id": "front_door",
        "observed_at": 1.0,
        "duration_s": 60.0,
        "correlation_id": "audio_glass_break_1000",
    }
    serialized = json.dumps(payload)
    assert "pcm" not in serialized
    assert "audio_bytes" not in serialized


def test_retry_preserves_payload_id_and_correlation():
    queue = SignalRetryQueue()
    payload = {"id": "stable", "correlation_id": "also_stable"}
    queue.add(payload, 10.0)
    seen = []

    def fail(_url, outgoing):
        seen.append(dict(outgoing))
        raise IOError("offline")

    assert queue.flush_one("http://127.0.0.1/signal", 10.0, fail) is False
    assert queue.flush_one("http://127.0.0.1/signal", 11.0, fail) is None
    assert queue.flush_one("http://127.0.0.1/signal", 12.0, fail) is False
    assert seen == [payload, payload]

    def succeed(_url, outgoing):
        seen.append(dict(outgoing))

    assert queue.flush_one("http://127.0.0.1/signal", 16.0, succeed) is True
    assert seen[-1] == payload
    assert queue.pending == []


def test_retry_queue_is_bounded_and_can_be_cleared_for_privacy():
    queue = SignalRetryQueue(max_pending=2)
    queue.add({"id": "one"}, 0)
    queue.add({"id": "two"}, 0)
    queue.add({"id": "three"}, 0)
    assert [item["payload"]["id"] for item in queue.pending] == ["two", "three"]
    queue.clear()
    assert queue.pending == []


def test_server_destinations_must_stay_on_loopback():
    assert _require_loopback("http://127.0.0.1:8000/x", "URL")
    assert _require_loopback("http://[::1]:8000/x", "URL")
    with pytest.raises(ValueError):
        _require_loopback("https://example.com/x", "URL")
    with pytest.raises(ValueError):
        _require_loopback("file:///tmp/sock", "URL")
