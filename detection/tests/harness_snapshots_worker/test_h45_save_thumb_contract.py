import re
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
sys.modules.setdefault("jetson_inference", MagicMock())
sys.modules.setdefault("jetson_utils", MagicMock(saveImage=_save_image_stub))

import detect  # noqa: E402


THUMB_URL_RE = re.compile(r"^/snapshots/thumb_[0-9]+\.jpg$")


def test_given_tmp_thumb_dir_when_save_thumb_runs_then_returns_wire_path_and_writes_file(tmp_path):
    cuda_img_stub = object()
    ts_ms = 1720468123456
    ts = ts_ms / 1000.0

    thumb_url = detect.save_thumb(
        cuda_img_stub,
        ts,
        str(tmp_path),
        max_keep=10,
        quality=90,
    )

    assert thumb_url == "/snapshots/thumb_{}.jpg".format(ts_ms)
    assert THUMB_URL_RE.fullmatch(thumb_url)
    assert (tmp_path / "thumb_{}.jpg".format(ts_ms)).read_bytes() == _TINY_JPEG
    assert "/api/" not in thumb_url
    assert "://" not in thumb_url
