import math
import struct

import pytest

from audio_events import (
    AudioEventGate,
    classify_audio_features,
    classify_pcm16le,
    extract_audio_features,
    pcm16le_samples,
    sanitize_audio_labels,
)


def test_pcm_decoder_is_little_endian_bounded_and_normalized():
    raw = struct.pack("<hhhh", -32768, -16384, 0, 32767)
    assert pcm16le_samples(raw, max_samples=3) == [-1.0, -0.5, 0.0]
    assert pcm16le_samples(b"\x01") == []


def test_smoke_alarm_tone_is_detected_without_retaining_audio():
    pcm = b"".join(
        struct.pack("<h", int(5000 * math.sin(2 * math.pi * 3000 * i / 16000.0)))
        for i in range(16000)
    )
    assert classify_pcm16le(pcm) == {"audio_smoke_alarm": 1.0}


def test_classifier_branches_are_conservative_and_single_label():
    assert classify_audio_features({
        "rms": 0.08, "peak": 0.8, "crest": 10.0, "zcr": 0.2,
        "derivative_ratio": 2.0, "smoke_tone_ratio": 0.0,
    }) == {"audio_glass_break": 1.0}
    scream = classify_audio_features({
        "rms": 0.2, "peak": 0.5, "crest": 2.5, "zcr": 0.1,
        "derivative_ratio": 0.4, "smoke_tone_ratio": 0.0,
    })
    assert scream == {"audio_scream": pytest.approx(0.89)}
    bark = classify_audio_features({
        "rms": 0.1, "peak": 0.3, "crest": 3.0, "zcr": 0.08,
        "derivative_ratio": 0.8, "smoke_tone_ratio": 0.0,
    })
    assert bark == {"audio_dog_bark": pytest.approx(0.67)}
    assert classify_audio_features(extract_audio_features([0.0] * 100)) == {}


def test_label_sanitizer_rejects_unknowns_and_duplicates():
    assert sanitize_audio_labels([
        "audio_scream", "nope", "audio_scream", "audio_dog_bark",
    ]) == ["audio_scream", "audio_dog_bark"]
    assert sanitize_audio_labels("audio_scream") == []


def test_gate_requires_consecutive_hits_and_honors_refractory():
    gate = AudioEventGate(["audio_smoke_alarm"])
    assert gate.observe({"audio_smoke_alarm": 0.8}, 10.0) is None
    event = gate.observe({"audio_smoke_alarm": 0.9}, 11.0)
    assert event["label"] == "audio_smoke_alarm"
    assert event["score"] == 0.9
    assert event["duration_s"] == 2.0
    correlation_id = event["correlation_id"]
    assert correlation_id.startswith("audio_smoke_alarm_")
    assert gate.observe({"audio_smoke_alarm": 0.9}, 12.0) is None
    assert gate.observe({"audio_smoke_alarm": 0.9}, 13.0) is None
    assert gate.observe({"audio_smoke_alarm": 0.9}, 42.0) is None
    assert gate.observe({"audio_smoke_alarm": 0.9}, 43.0) is not None


def test_glass_break_is_one_shot_and_disabled_labels_never_emit():
    gate = AudioEventGate(["audio_glass_break"])
    assert gate.observe({"audio_glass_break": 0.8}, 1.0)["label"] == (
        "audio_glass_break"
    )
    gate.set_labels([])
    assert gate.observe({"audio_glass_break": 1.0}, 100.0) is None
    assert gate.observe({"audio_scream": 1.0}, 101.0) is None
