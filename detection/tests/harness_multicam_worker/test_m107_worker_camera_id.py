import json
import logging
import sys
from pathlib import Path
from unittest.mock import MagicMock

# detect.py sits two levels above this harness package.
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

# Mock the host-only Jetson SDK imports BEFORE importing detect.
# detect.py imports these at module top, matching detection/tests/test_capture_recovery.py.
sys.modules.setdefault("jetson_inference", MagicMock())
sys.modules.setdefault("jetson_utils", MagicMock())

import camera_ident  # noqa: E402
import detect  # noqa: E402


def test_resolve_camera_id_uses_valid_env_and_invalid_warns_fallback(caplog):
    caplog.set_level(logging.WARNING, logger="camera_ident")

    assert (
        camera_ident.camera_id_from_env({"DETECT_CAMERA_ID": "garage_02"})
        == "garage_02"
    )
    assert camera_ident.camera_id_from_env({}) == camera_ident.DEFAULT_CAMERA_ID
    assert caplog.records == []

    assert (
        camera_ident.camera_id_from_env({"DETECT_CAMERA_ID": "Garage-02"})
        == camera_ident.DEFAULT_CAMERA_ID
    )

    warnings = [r for r in caplog.records if r.levelno == logging.WARNING]
    assert len(warnings) == 1
    message = warnings[0].getMessage()
    assert "camera_id resolve" in message
    assert "Garage-02" in message
    assert "^[a-z0-9_]{1,32}$" in message


def test_worker_event_payload_includes_detect_camera_id_via_real_post_path(
    monkeypatch, tmp_path,
):
    posted_bodies = []

    class _Response:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def read(self):
            return b"{}"

    def _urlopen(req, timeout=None):
        posted_bodies.append(req.data)
        return _Response()

    monkeypatch.setenv("DETECT_CAMERA_ID", "side_yard")
    monkeypatch.setattr(detect.urllib.request, "urlopen", _urlopen)

    runner = detect._build_visit_runner(
        str(tmp_path),
        MagicMock(),
        None,
        "http://127.0.0.1:8000/api/_internal/event",
        camera_ident.camera_id_from_env(),
    )
    runner._post_event(
        "visit-1",
        "person:side_yard",
        1000.0,
        [
            {
                "label": "person",
                "score": 0.9,
                "x1": 0.1,
                "y1": 0.1,
                "x2": 0.5,
                "y2": 0.5,
            }
        ],
    )

    assert len(posted_bodies) == 1
    payload = json.loads(posted_bodies[0].decode("utf-8"))
    assert payload["camera_id"] == "side_yard"
