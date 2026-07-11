import urllib.error

from signal_retry import SignalEmitter, SignalRetryQueue, build_signal_payload


def test_build_metadata_signal_is_strict_and_stable_when_ids_supplied():
    payload = build_signal_payload(
        "doorbell", "doorbell", "front_door", 123.0,
        event_id="stable_id", correlation_id="stable_correlation",
    )
    assert payload == {
        "id": "stable_id",
        "source": "doorbell",
        "label": "doorbell",
        "score": 1.0,
        "camera_id": "front_door",
        "observed_at": 123.0,
        "duration_s": 0.0,
        "correlation_id": "stable_correlation",
    }
    assert "boxes" not in payload


def test_retry_keeps_original_metadata_and_backoff():
    queue = SignalRetryQueue()
    payload = {"id": "stable", "correlation_id": "same"}
    queue.add(payload, 1.0)
    seen = []

    def fail(_url, outgoing):
        seen.append(dict(outgoing))
        raise OSError("down")

    assert queue.flush_one("http://localhost/signal", 1.0, fail) is False
    assert queue.flush_one("http://localhost/signal", 2.0, fail) is None
    assert queue.flush_one("http://localhost/signal", 3.0, fail) is False
    assert seen == [payload, payload]


def test_emitter_enqueues_tamper_without_visual_boxes():
    emitter = SignalEmitter("http://localhost/signal", "front_door")
    payload = emitter.emit(
        "tamper", "camera_covered", now=50.0, event_id="tamper1",
    )
    assert payload["source"] == "tamper"
    assert payload["label"] == "camera_covered"
    assert payload["observed_at"] == 50.0
    assert "boxes" not in payload


def test_backed_off_head_does_not_block_a_later_due_signal():
    queue = SignalRetryQueue()
    queue.add({"id": "first"}, 0.0)
    queue.add({"id": "second"}, 0.0)
    seen = []

    def sender(_url, payload):
        seen.append(payload["id"])
        if payload["id"] == "first":
            raise OSError("offline")

    assert queue.flush_one("http://localhost/signal", 0.0, sender) is False
    assert queue.flush_one("http://localhost/signal", 0.5, sender) is True
    assert seen == ["first", "second"]
    assert [item["payload"]["id"] for item in queue.pending] == ["first"]


def test_permanent_4xx_drops_but_retryable_status_is_retained():
    queue = SignalRetryQueue()
    queue.add({"id": "bad"}, 0.0)

    def permanent(_url, _payload):
        raise urllib.error.HTTPError("url", 422, "bad", {}, None)

    assert queue.flush_one("http://localhost/signal", 0.0, permanent) == "dropped"
    assert queue.pending == []

    queue.add({"id": "busy"}, 1.0)

    def retryable(_url, _payload):
        raise urllib.error.HTTPError("url", 429, "busy", {}, None)

    assert queue.flush_one("http://localhost/signal", 1.0, retryable) is False
    assert queue.pending[0]["payload"]["id"] == "busy"


def test_retry_queue_drops_by_attempt_and_age_bounds():
    by_attempt = SignalRetryQueue(max_attempts=2)
    by_attempt.add({"id": "attempts"}, 0.0)

    def fail(_url, _payload):
        raise OSError("down")

    assert by_attempt.flush_one("u", 0.0, fail) is False
    assert by_attempt.flush_one("u", 2.0, fail) == "dropped"
    assert by_attempt.pending == []

    by_age = SignalRetryQueue(max_age_s=5.0)
    by_age.add({"id": "old"}, 0.0)
    assert by_age.flush_one("u", 6.0, fail) is None
    assert by_age.pending == []
