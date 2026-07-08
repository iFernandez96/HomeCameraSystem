import os
import sys
from pathlib import Path
from unittest.mock import MagicMock

# detect.py sits two levels above this harness package.
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))


# Real 1x1 JPEG bytes. The saveImage stub writes this so save_thumb's file
# contract is exercised without depending on Jetson SDK bindings.
_TINY_JPEG = (
    b"\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01\x01\x01\x00H\x00H\x00\x00"
    b"\xff\xdb\x00C\x00\xff\xff\xff\xff\xff\xff\xff\xff\xff\xff\xff"
    b"\xff\xff\xff\xff\xff\xff\xff\xff\xff\xff\xff\xff\xff\xff\xff"
    b"\xff\xff\xff\xff\xff\xff\xff\xff\xff\xff\xff\xff\xff\xff\xff"
    b"\xff\xff\xff\xff\xff\xff\xff\xff\xff\xff\xff\xff\xff\xff\xff"
    b"\xff\xff\xff\xff\xff\xff\xff\xff\xff\xff\xc0\x00\x0b\x08\x00"
    b"\x01\x00\x01\x01\x01\x11\x00\xff\xc4\x00\x14\x00\x01\x00\x00"
    b"\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00"
    b"\x08\xff\xc4\x00\x14\x10\x01\x00\x00\x00\x00\x00\x00\x00\x00"
    b"\x00\x00\x00\x00\x00\x00\x00\x00\x00\xff\xda\x00\x08\x01\x01"
    b"\x00\x00?\x00\x7f\xff\xd9"
)


def _save_image_stub(path, cuda_img, quality=None):
    Path(path).write_bytes(_TINY_JPEG)


# Mock the host-only Jetson SDK imports BEFORE importing detect.
# detect.py imports these at module top, matching detection/tests/test_capture_recovery.py.
# setdefault means ANOTHER harness's plain MagicMock may already be installed
# (full-suite order), so behavior is patched per-test on detect.jetson_utils
# below — never rely on which stub won the import race.
sys.modules.setdefault("jetson_inference", MagicMock())
sys.modules.setdefault("jetson_utils", MagicMock(saveImage=_save_image_stub))

import detect  # noqa: E402
import pytest  # noqa: E402


@pytest.fixture(autouse=True)
def _writing_save_image(monkeypatch):
    monkeypatch.setattr(detect.jetson_utils, "saveImage", _save_image_stub)


def _seed_file(path, payload, mtime):
    path.write_bytes(payload)
    os.utime(path, (mtime, mtime))


def test_given_preseeded_thumb_dir_when_save_thumb_prunes_then_only_oldest_thumbs_are_removed(tmp_path):
    thumb_names = [
        "thumb_1720468120000.jpg",
        "thumb_1720468121000.jpg",
        "thumb_1720468122000.jpg",
        "thumb_1720468123000.jpg",
    ]
    for index, name in enumerate(thumb_names):
        _seed_file(
            tmp_path / name,
            "seed-{}".format(index).encode("ascii"),
            1_720_468_120 + index,
        )
    _seed_file(tmp_path / "latest.jpg", b"latest", 1_720_468_199)
    _seed_file(tmp_path / "snap_1720468120000.jpg", b"snap", 1_720_468_200)

    thumb_url = detect.save_thumb(
        object(),
        1720468124.0,
        str(tmp_path),
        max_keep=3,
        quality=90,
    )

    assert thumb_url == "/snapshots/thumb_1720468124000.jpg"
    assert sorted(path.name for path in tmp_path.glob("thumb_*.jpg")) == [
        "thumb_1720468122000.jpg",
        "thumb_1720468123000.jpg",
        "thumb_1720468124000.jpg",
    ]
    assert (tmp_path / "latest.jpg").read_bytes() == b"latest"
    assert (tmp_path / "snap_1720468120000.jpg").read_bytes() == b"snap"
