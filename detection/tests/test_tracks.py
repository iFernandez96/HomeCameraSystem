"""Unit tests for the iter-356.53 bbox-track sidecar writer.

Run from `detection/`:
    /tmp/homecam-venv/bin/python -m pytest tests/test_tracks.py -q

Pure-Python module — no jetson_inference / jetson_utils imports.
"""
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from tracks import build_payload, write_sidecar, SAMPLE_CAP


# --- build_payload ---


def test_given_samples_when_build_payload_then_offsets_relative_to_clip_start():
    # arrange — clip starts at event_ts (1000) - pre_roll_s (3) = 997.
    # Samples at absolute times 998, 1000, 1005 should map to offsets
    # 1.0, 3.0, 8.0.
    samples = [
        (998.0, [{"x": 0.1, "y": 0.1, "w": 0.2, "h": 0.2, "label": "person", "score": 0.9}]),
        (1000.0, [{"x": 0.2, "y": 0.1, "w": 0.2, "h": 0.2, "label": "person", "score": 0.91}]),
        (1005.0, [{"x": 0.3, "y": 0.1, "w": 0.2, "h": 0.2, "label": "person", "score": 0.88}]),
    ]

    # act
    payload = build_payload("evt-1", 1000.0, 3.0, 7.0, samples)

    # assert
    assert payload["v"] == 1
    assert payload["event_id"] == "evt-1"
    assert payload["pre_roll_s"] == 3.0
    assert payload["post_roll_s"] == 7.0
    offsets = [s["ts_offset_s"] for s in payload["samples"]]
    assert offsets == [1.0, 3.0, 8.0]


def test_given_samples_out_of_window_when_build_payload_then_dropped():
    # arrange — clip window is [997, 1010] (event 1000, pre 3, post 7,
    # +1s tolerance). Samples at 990 and 1020 should be dropped.
    samples = [
        (990.0, [{"x": 0, "y": 0, "w": 0.1, "h": 0.1, "label": "x", "score": 0.5}]),
        (998.0, [{"x": 0.1, "y": 0, "w": 0.1, "h": 0.1, "label": "x", "score": 0.5}]),
        (1020.0, [{"x": 0.2, "y": 0, "w": 0.1, "h": 0.1, "label": "x", "score": 0.5}]),
    ]

    # act
    payload = build_payload("evt", 1000.0, 3.0, 7.0, samples)

    # assert — only the in-window sample at 998 (offset 1.0) survives.
    offsets = [s["ts_offset_s"] for s in payload["samples"]]
    assert offsets == [1.0]


def test_given_unsorted_input_when_build_payload_then_samples_sorted_ascending():
    # arrange — samples in reverse chronological order.
    samples = [
        (1005.0, [{"x": 0, "y": 0, "w": 0.1, "h": 0.1, "label": "a", "score": 0.5}]),
        (999.0,  [{"x": 0, "y": 0, "w": 0.1, "h": 0.1, "label": "a", "score": 0.5}]),
        (1002.0, [{"x": 0, "y": 0, "w": 0.1, "h": 0.1, "label": "a", "score": 0.5}]),
    ]

    # act
    payload = build_payload("evt", 1000.0, 3.0, 7.0, samples)

    # assert
    offsets = [s["ts_offset_s"] for s in payload["samples"]]
    assert offsets == sorted(offsets)


def test_given_more_than_cap_samples_when_build_payload_then_subsampled_to_cap():
    # arrange — fabricate 6000 samples spanning a 30-min clip.
    # Cap is 5000; output should be exactly 5000 entries.
    pre_roll_s = 0.0
    post_roll_s = 1800.0
    event_ts = 1000.0
    samples = []
    for i in range(6000):
        t = event_ts + (i / 6000.0) * post_roll_s
        samples.append((t, [{"x": 0, "y": 0, "w": 0.1, "h": 0.1, "label": "p", "score": 0.5}]))

    # act
    payload = build_payload("evt", event_ts, pre_roll_s, post_roll_s, samples)

    # assert — cap is 5000 by SAMPLE_CAP constant.
    assert len(payload["samples"]) == SAMPLE_CAP


def test_given_empty_samples_when_build_payload_then_returns_empty_samples_array():
    # arrange — track recorded but every frame had zero detections.

    # act
    payload = build_payload("evt", 1000.0, 3.0, 7.0, [])

    # assert
    assert payload["samples"] == []
    assert payload["event_id"] == "evt"
    assert payload["v"] == 1


# --- write_sidecar ---


def test_given_valid_payload_when_write_sidecar_then_atomic_rename_to_final(tmp_path):
    # arrange
    payload = {"v": 1, "event_id": "evt-1", "pre_roll_s": 3.0, "post_roll_s": 7.0, "samples": []}

    # act
    ok = write_sidecar(str(tmp_path), "evt-1", payload)

    # assert
    assert ok is True
    final = tmp_path / "evt-1.tracks.json"
    assert final.exists()
    # No half-written tmp left behind.
    assert not (tmp_path / "evt-1.tracks.json.tmp").exists()
    # Round-trip JSON is intact.
    loaded = json.loads(final.read_text())
    assert loaded == payload


def test_given_invalid_event_id_when_write_sidecar_then_returns_false_no_file(tmp_path):
    # arrange — event_id with traversal characters must be rejected.
    payload = {"v": 1, "event_id": "../evil", "samples": []}

    # act
    ok = write_sidecar(str(tmp_path), "../evil", payload)

    # assert
    assert ok is False
    assert list(tmp_path.iterdir()) == []


def test_given_unwritable_dir_when_write_sidecar_then_returns_false(tmp_path, monkeypatch):
    # arrange — force os.makedirs to raise.
    def _boom(*args, **kwargs):
        raise OSError("disk full")

    monkeypatch.setattr("tracks.os.makedirs", _boom)

    # act
    ok = write_sidecar(str(tmp_path), "evt", {"v": 1, "samples": []})

    # assert
    assert ok is False
