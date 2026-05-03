"""Unit tests for box_norm.normalize_box.

The helper exists to close iter-95's follow-up: clamp pixel coords
*before* division so `x + w <= 1` exactly, without relying on the
server-side validator's epsilon.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest  # noqa: E402

from box_norm import normalize_box  # noqa: E402


def test_standard_box_normalizes_correctly():
    b = normalize_box(192, 144, 384, 432, 1280, 720, "person", 0.91)
    assert b["x"] == pytest.approx(0.15)
    assert b["y"] == pytest.approx(0.20)
    assert b["w"] == pytest.approx(0.15)
    assert b["h"] == pytest.approx(0.40)
    assert b["label"] == "person"
    assert b["score"] == 0.91


def test_right_at_frame_edge_sums_to_exactly_one():
    """A bbox at the exact right edge: x+w must equal 1.0 — no
    sub-pixel drift, no epsilon needed at the validator."""
    b = normalize_box(960, 0, 1280, 720, 1280, 720, "person", 0.5)
    assert b["x"] + b["w"] == 1.0
    assert b["y"] + b["h"] == 1.0


def test_right_overflow_is_clamped_and_sums_to_one():
    """If jetson-inference returns Right slightly past frame width
    (sub-pixel network output at the edge), the helper clamps in
    pixel space — x+w stays exactly 1.0."""
    b = normalize_box(960, 0, 1280.5, 720.5, 1280, 720, "person", 0.5)
    assert b["x"] + b["w"] == 1.0
    assert b["y"] + b["h"] == 1.0


def test_left_negative_is_clamped_to_zero():
    b = normalize_box(-5, -3, 100, 50, 1280, 720, "person", 0.5)
    assert b["x"] == 0.0
    assert b["y"] == 0.0
    assert b["w"] == pytest.approx(100 / 1280)
    assert b["h"] == pytest.approx(50 / 720)


def test_right_less_than_left_collapses_to_zero_width():
    """Defensive: if the network ever produces Right < Left after
    clamping (shouldn't happen, but degenerate boxes shouldn't blow
    up the worker), w collapses to 0 rather than going negative."""
    b = normalize_box(500, 100, 100, 200, 1280, 720, "person", 0.5)
    assert b["w"] == 0.0
    assert b["x"] + b["w"] <= 1.0


def test_full_frame_box():
    b = normalize_box(0, 0, 1280, 720, 1280, 720, "person", 0.99)
    assert b["x"] == 0.0
    assert b["y"] == 0.0
    assert b["w"] == 1.0
    assert b["h"] == 1.0


def test_zero_frame_dim_raises():
    with pytest.raises(ValueError):
        normalize_box(0, 0, 100, 100, 0, 720, "p", 0.5)
    with pytest.raises(ValueError):
        normalize_box(0, 0, 100, 100, 1280, 0, "p", 0.5)


def test_negative_frame_dim_raises():
    with pytest.raises(ValueError):
        normalize_box(0, 0, 100, 100, -1280, 720, "p", 0.5)


def test_score_coerced_to_float():
    """jetson-inference's d.Confidence is sometimes a numpy float —
    the dict value should always be a Python float so json.dumps
    in detect.py never sees a numpy scalar."""
    b = normalize_box(0, 0, 100, 100, 1280, 720, "person", 0.5)
    assert isinstance(b["score"], float)


def test_sum_invariant_under_random_overflow():
    """Sweep typical jetson-inference outputs around the frame
    edges — x+w and y+h must always be <= 1.0 exactly, no epsilon."""
    cases = [
        (1279.99, 1279.99 + 0.5, 0, 0),     # tiny right overflow
        (1280.001, 1290, 0, 0),             # left starts just past edge
        (1000, 1500, 500, 1000),             # box mostly outside frame
        (-50, 200, -50, 200),                # box mostly negative
        (640, 640.0001, 360, 360),           # zero-width box
    ]
    for left, right, top, bottom in cases:
        b = normalize_box(left, top, right, bottom, 1280, 720, "person", 0.5)
        assert b["x"] + b["w"] <= 1.0, (left, right, b)
        assert b["y"] + b["h"] <= 1.0, (top, bottom, b)
        assert 0.0 <= b["x"] <= 1.0
        assert 0.0 <= b["y"] <= 1.0
        assert 0.0 <= b["w"] <= 1.0
        assert 0.0 <= b["h"] <= 1.0
