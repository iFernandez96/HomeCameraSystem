import importlib
import sys
from unittest.mock import MagicMock

import pytest

from server.tests.harness_face_recog.fixtures import (
    DETECTION_DIR,
    ENCODINGS_PATH,
)


@pytest.mark.skipif(
    ENCODINGS_PATH.exists(),
    reason="detection/face_recog/encodings.pkl exists; lazy no-encoding boundary needs capture-only startup",
)
def test_given_no_encodings_when_worker_init_runs_then_face_recognition_is_not_imported():
    sys.path.insert(0, str(DETECTION_DIR))
    sys.modules.setdefault("jetson_inference", MagicMock())
    sys.modules.setdefault("jetson_utils", MagicMock())
    sys.modules.pop("detect", None)
    sys.modules.pop("face_recog.recognizer", None)
    sys.modules.pop("face_recognition", None)

    detect = importlib.import_module("detect")
    rec = detect.init_face_recognizer()

    assert rec is not None
    assert rec._fr is None
    assert rec.encs is None
    assert rec.names == []
    assert "face_recognition" not in sys.modules
