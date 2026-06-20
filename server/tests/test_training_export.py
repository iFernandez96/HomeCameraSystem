"""iter-356.6X (tiered-inference slice 2): unit tests for the
letterbox + iter_capture_files helpers in services/training_export.py.
"""
from __future__ import annotations

import json

import pytest
from PIL import Image

from app.services import training_export
from app.services.training_export import (
    build_export_zip,
    iter_capture_files,
    letterbox,
)


def _make_jpeg(path, w, h, color=(200, 100, 50)):
    path.parent.mkdir(parents=True, exist_ok=True)
    img = Image.new("RGB", (w, h), color)
    img.save(path, format="JPEG", quality=90)


def _make_sidecar(path, **fields):
    path.write_text(json.dumps(fields))


def test_given_landscape_when_letterbox_to_224_then_aspect_preserved_within_1px():
    # arrange
    img = Image.new("RGB", (1280, 720), (255, 0, 0))
    # act
    canvas, scale, pad_x, pad_y = letterbox(img, 224)
    # assert
    assert canvas.size == (224, 224)
    assert scale == pytest.approx(224 / 1280)
    # 1280x720 → 224x126 → pad_y = (224-126)//2 = 49
    assert pad_x == 0
    assert pad_y == 49
    # within ±1px aspect: source ratio 16:9, output filled-area ratio
    filled_w, filled_h = 224, int(round(720 * scale))
    assert abs((filled_w / filled_h) - (1280 / 720)) < 0.02


def test_given_portrait_when_letterbox_to_224_then_pads_top_and_bottom():
    # Note: portrait input -> pads LEFT and RIGHT. Plan called this
    # "pads top and bottom" but for a portrait the symmetric padding is
    # horizontal. We pin both dimensions.
    # arrange
    img = Image.new("RGB", (300, 600), (0, 255, 0))
    # act
    canvas, scale, pad_x, pad_y = letterbox(img, 224)
    # assert
    assert canvas.size == (224, 224)
    assert scale == pytest.approx(224 / 600)
    # new_w = round(300 * 224/600) = 112, pad_x = 56
    assert pad_y == 0
    assert pad_x == 56


def test_given_square_when_letterbox_to_224_then_no_padding():
    # arrange
    img = Image.new("RGB", (100, 100), (0, 0, 255))
    # act
    canvas, scale, pad_x, pad_y = letterbox(img, 224)
    # assert
    assert canvas.size == (224, 224)
    assert scale == pytest.approx(2.24)
    assert pad_x == 0
    assert pad_y == 0


def test_given_tiny_input_when_letterbox_to_224_then_upscaled_to_canvas():
    # arrange
    img = Image.new("RGB", (10, 20), (50, 50, 50))
    # act
    canvas, scale, pad_x, pad_y = letterbox(img, 224)
    # assert
    assert canvas.size == (224, 224)
    # 10x20 → scale=11.2 → 112x224 → pad_x=56, pad_y=0
    assert pad_y == 0
    assert pad_x == 56


def test_given_face_captures_dir_with_pairs_when_iter_capture_files_then_yields_each_pair(tmp_path):
    # arrange
    a = tmp_path / "alice" / "1700000000000_evt-a.jpg"
    b = tmp_path / "bob" / "1700000001000_evt-b.jpg"
    _make_jpeg(a, 100, 100)
    _make_jpeg(b, 200, 100)
    _make_sidecar(a.with_suffix(".json"), predicted_name="alice", confidence=0.9, event_id="evt-a", ts_ms=1700000000000)
    _make_sidecar(b.with_suffix(".json"), predicted_name="bob", confidence=0.8, event_id="evt-b", ts_ms=1700000001000)

    # act
    pairs = list(iter_capture_files(tmp_path, kind="face"))

    # assert
    assert len(pairs) == 2
    names = sorted(side["predicted_name"] for _, side in pairs)
    assert names == ["alice", "bob"]


def test_given_corrupt_sidecar_when_iter_capture_files_then_skipped(tmp_path):
    # arrange
    good = tmp_path / "alice" / "1700000000000_evt-a.jpg"
    bad = tmp_path / "bob" / "1700000001000_evt-b.jpg"
    _make_jpeg(good, 50, 50)
    _make_jpeg(bad, 50, 50)
    _make_sidecar(good.with_suffix(".json"), predicted_name="alice")
    bad.with_suffix(".json").write_text("{not valid json")

    # act
    pairs = list(iter_capture_files(tmp_path, kind="face"))

    # assert
    assert len(pairs) == 1
    assert pairs[0][1]["predicted_name"] == "alice"


def test_given_jpeg_without_sidecar_when_iter_capture_files_then_skipped(tmp_path):
    # arrange
    orphan = tmp_path / "alice" / "1700000000000_evt-a.jpg"
    paired = tmp_path / "alice" / "1700000001000_evt-b.jpg"
    _make_jpeg(orphan, 50, 50)
    _make_jpeg(paired, 50, 50)
    _make_sidecar(paired.with_suffix(".json"), predicted_name="alice")

    # act
    pairs = list(iter_capture_files(tmp_path, kind="face"))

    # assert
    assert len(pairs) == 1
    assert pairs[0][0] == paired


def test_given_truncated_jpeg_when_build_export_zip_then_skipped_not_500(tmp_path):
    # arrange
    good = tmp_path / "alice" / "1700000000000_evt-a.jpg"
    truncated = tmp_path / "alice" / "1700000001000_evt-b.jpg"
    _make_jpeg(good, 50, 50)
    _make_sidecar(good.with_suffix(".json"), predicted_name="alice")
    # Truncated JPEG: write a partial stream that PIL can't decode.
    truncated.parent.mkdir(parents=True, exist_ok=True)
    truncated.write_bytes(b"\xff\xd8\xff\xe0not really a jpeg")
    _make_sidecar(truncated.with_suffix(".json"), predicted_name="alice")

    # act
    zip_bytes, summary = build_export_zip(tmp_path, kind="face", size=224)

    # assert
    assert summary["count"] == 1
    assert summary["skipped"] == 1
    assert len(zip_bytes) > 0


# --- logging-plan §5 #13: ValueError from letterbox skipped, not 500 ---

def test_given_zero_dim_image_when_letterbox_then_raises_valueerror():
    """Given a zero-dimension image, When letterbox runs, Then it
    raises ValueError. Pins the exact trigger that build_export_zip
    must now catch (was uncaught → 500'd the whole ZIP)."""
    # arrange — we can't Image.new a 0-dim canvas, so craft an RGB
    # image then force its .size to a degenerate 0xN (PIL stores the
    # tuple in the private `_size` attribute that `.size` reads).
    img = Image.new("RGB", (1, 1), (0, 0, 0))
    img._size = (0, 10)

    # act / assert
    with pytest.raises(ValueError):
        letterbox(img, 224)


def test_given_image_that_letterboxes_to_valueerror_when_build_then_skipped_not_500(
    tmp_path, monkeypatch, caplog
):
    """Given an image whose letterbox raises ValueError (a zero-dim
    crop the worker wrote mid-race), When build_export_zip runs, Then
    that one image is skipped + logged and the rest of the ZIP still
    builds — NOT a 500 that loses every valid crop."""
    import logging as _logging

    # arrange — two valid JPEGs; force letterbox to raise ValueError
    # for the SECOND one only.
    good = tmp_path / "alice" / "1700000000000_evt-a.jpg"
    bad = tmp_path / "alice" / "1700000001000_evt-b.jpg"
    _make_jpeg(good, 50, 50)
    _make_jpeg(bad, 50, 50)
    _make_sidecar(good.with_suffix(".json"), predicted_name="alice")
    _make_sidecar(bad.with_suffix(".json"), predicted_name="alice")

    real_letterbox = training_export.letterbox
    seen = {"n": 0}

    def _letterbox(img, size, **kw):
        seen["n"] += 1
        if seen["n"] == 2:
            raise ValueError("non-positive image dimensions: 0x10")
        return real_letterbox(img, size, **kw)

    monkeypatch.setattr(training_export, "letterbox", _letterbox)

    # act
    with caplog.at_level(_logging.WARNING, logger="app.services.training_export"):
        zip_bytes, summary = build_export_zip(tmp_path, kind="face", size=224)

    # assert — one kept, one skipped, no exception escaped.
    assert summary["count"] == 1
    assert summary["skipped"] == 1
    assert len(zip_bytes) > 0
    warns = [
        r for r in caplog.records if "bad image" in r.getMessage()
    ]
    assert warns, "expected a WARN naming the skipped bad image"
