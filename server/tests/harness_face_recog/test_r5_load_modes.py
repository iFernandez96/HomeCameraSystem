import pickle
import sys

from server.tests.harness_face_recog.fixtures import DETECTION_DIR


def _recognizer(tmp_path):
    sys.path.insert(0, str(DETECTION_DIR))
    from face_recog.recognizer import FaceRecognizer

    return FaceRecognizer(str(tmp_path / "encodings.pkl"))


def _assert_capture_only(rec):
    assert rec.load() is False
    assert rec._fr is None
    assert rec.encs is None
    assert rec.names == []


def test_given_missing_encodings_when_loaded_then_capture_only_mode(tmp_path):
    rec = _recognizer(tmp_path)

    _assert_capture_only(rec)


def test_given_corrupt_encodings_when_loaded_then_capture_only_mode(tmp_path):
    (tmp_path / "encodings.pkl").write_bytes(b"not a pickle")
    rec = _recognizer(tmp_path)

    _assert_capture_only(rec)


def test_given_empty_encodings_when_loaded_then_capture_only_mode(tmp_path):
    with (tmp_path / "encodings.pkl").open("wb") as f:
        pickle.dump([], f)
    rec = _recognizer(tmp_path)

    _assert_capture_only(rec)
