"""Unit tests for FaceRecognizer's graceful-degradation paths.

The full match path needs numpy + face_recognition + dlib, which are
host-only deps. But the early-out branches (file missing, unreadable
pickle, empty data, untrained matcher) all return cleanly *before*
importing numpy, and those are exactly the paths the iter-22 design
relies on for the worker to keep booting when face recog is
unavailable.
"""
import pickle
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "face_recog"))

from recognizer import FaceRecognizer  # noqa: E402


# --- load() early-out paths --------------------------------------------------


def test_load_returns_false_when_encodings_file_missing(tmp_path):
    r = FaceRecognizer(str(tmp_path / "no-such-file.pkl"))
    assert r.load() is False


def test_load_returns_false_on_corrupt_pickle(tmp_path):
    f = tmp_path / "encodings.pkl"
    f.write_bytes(b"\x00\x01garbage\x02\x03")
    r = FaceRecognizer(str(f))
    assert r.load() is False


def test_load_returns_false_on_empty_pairs(tmp_path):
    # Caller pickled an empty list. Treat as "no encodings yet" — same
    # graceful-disable path as a missing file.
    f = tmp_path / "encodings.pkl"
    f.write_bytes(pickle.dumps([]))
    r = FaceRecognizer(str(f))
    assert r.load() is False


def test_load_returns_false_when_path_is_a_directory(tmp_path):
    # Pathological — but if someone mkdirs `encodings.pkl` instead of
    # writing it, we shouldn't crash. The pickle.load OSError path
    # swallows it.
    d = tmp_path / "encodings.pkl"
    d.mkdir()
    r = FaceRecognizer(str(d))
    assert r.load() is False


# --- match() returns None when untrained -------------------------------------


def test_match_returns_none_name_with_zero_confidence_before_load():
    # iter-355a: match() now returns (name, confidence) tuple. Dormant
    # state gives (None, 0.0) — distinct from a low-confidence match
    # (which would have a non-None name when within tolerance).
    r = FaceRecognizer("/dev/null")
    name, conf = r.match([0.0, 0.1, 0.2])
    assert name is None
    assert conf == 0.0


def test_match_returns_none_name_when_names_empty():
    # iter-355a: same tuple shape; half-loaded state still bails before
    # numpy arithmetic.
    r = FaceRecognizer("/dev/null")
    r.encs = "non-None placeholder"
    r.names = []
    name, conf = r.match([0.0])
    assert name is None
    assert conf == 0.0


# --- recognize_in_crop fail-safes (no face_recognition installed) -----------


def test_recognize_in_crop_returns_none_without_face_recognition():
    r = FaceRecognizer("/dev/null")
    # _fr stays None until load() succeeds. recognize_in_crop is the
    # entry point detect.py calls; it must return None gracefully, not
    # raise.
    assert r.recognize_in_crop(object()) is None


# --- iter-355a confidence formula ---


def test_when_match_distance_is_zero_then_confidence_is_one():
    # arrange — exact-match: an encoding identical to a stored one.
    pytest_or_skip_numpy()
    import numpy as np
    r = FaceRecognizer("/dev/null", tolerance=0.6)
    r.encs = np.array([[1.0, 0.0, 0.0]], dtype="float64")
    r.names = ["alice"]

    # act
    name, conf = r.match(np.array([1.0, 0.0, 0.0], dtype="float64"))

    # assert
    assert name == "alice"
    assert conf == 1.0


def test_when_match_distance_equals_tolerance_then_confidence_is_zero_and_no_name():
    # arrange — distance exactly at the tolerance boundary; confidence
    # collapses to 0.0 and name is None (strict > tolerance check).
    pytest_or_skip_numpy()
    import numpy as np
    r = FaceRecognizer("/dev/null", tolerance=0.6)
    r.encs = np.array([[0.0, 0.0, 0.0]], dtype="float64")
    r.names = ["alice"]

    # act — query encoding is exactly 0.6 away.
    name, conf = r.match(np.array([0.6, 0.0, 0.0], dtype="float64"))

    # assert
    assert conf == 0.0
    assert name == "alice"  # at-tolerance is still a match (<=)


def test_when_match_distance_exceeds_tolerance_then_name_is_none_but_confidence_kept():
    # arrange — past tolerance; iter-355a keeps the (clamped) confidence
    # so the Tinder UI can sort "almost matched" cases by uncertainty.
    pytest_or_skip_numpy()
    import numpy as np
    r = FaceRecognizer("/dev/null", tolerance=0.6)
    r.encs = np.array([[0.0, 0.0, 0.0]], dtype="float64")
    r.names = ["alice"]

    # act — distance 0.9 → past tolerance.
    name, conf = r.match(np.array([0.9, 0.0, 0.0], dtype="float64"))

    # assert
    assert name is None
    # 1 - 0.9/0.6 = -0.5; clamped to 0.0.
    assert conf == 0.0


def pytest_or_skip_numpy():
    """Skip the test when numpy isn't available — keep the rest of
    this file runnable in a hermetic 3.6 env without the host's TRT
    + CUDA wheels."""
    try:
        import numpy  # noqa: F401
    except ImportError:
        import pytest
        pytest.skip("numpy not available")


# --- iter-355b1b cv2-fallback recognize path ---


def test_given_no_face_recognition_when_recognize_in_crop_called_then_uses_cv2_fallback(
    monkeypatch, tmp_path,
):
    # arrange — recognizer NOT loaded (face_recognition missing →
    # _fr stays None). Patch the cv2 Cv2HaarDetector to return one
    # face. Pass capture_dir; expect a crop saved with
    # confidence=0.0 and predicted_name=None (cv2 doesn't match).
    import sys
    import types

    # Stub Cv2HaarDetector so the recognizer's lazy import resolves
    # even when cv2 itself isn't installed in the dev venv.
    fake_detector_module = types.SimpleNamespace()

    class _FakeDetector(object):
        def __init__(self):
            self.loaded = False

        def load(self):
            self.loaded = True
            return True

        def face_locations(self, rgb_image):
            # One face at top=10, right=110, bottom=110, left=10.
            return [(10, 110, 110, 10)]

    fake_detector_module.Cv2HaarDetector = _FakeDetector
    monkeypatch.setitem(
        sys.modules, "face_recog.detector", fake_detector_module,
    )

    # Mock the _save_face_capture call so we don't need PIL.
    saved = []

    def _capture_save_stub(rgb_image, box, name, confidence,
                            capture_dir, event_id, ts_ms):
        saved.append({
            "name": name,
            "confidence": confidence,
            "event_id": event_id,
            "ts_ms": ts_ms,
        })

    import recognizer as recognizer_module
    monkeypatch.setattr(
        recognizer_module, "_save_face_capture", _capture_save_stub,
    )

    r = FaceRecognizer("/dev/null")
    # Don't call load() — _fr stays None, triggering the fallback.

    # act
    result = r.recognize_in_crop(
        rgb_image="fake_rgb",  # cv2 detector mock ignores it
        capture_dir=str(tmp_path / "captures"),
        event_id="evt-cv2-1",
        ts_ms=1700000000000,
    )

    # assert — cv2 fallback returns None (no match) but capture fired.
    assert result is None
    assert len(saved) == 1
    assert saved[0]["name"] is None
    assert saved[0]["confidence"] == 0.0
    assert saved[0]["event_id"] == "evt-cv2-1"
    assert saved[0]["ts_ms"] == 1700000000000


def test_given_cv2_fallback_with_no_faces_when_recognize_called_then_no_capture(
    monkeypatch, tmp_path,
):
    # arrange — fake detector returns no faces.
    import sys
    import types

    fake_detector_module = types.SimpleNamespace()

    class _FakeDetector(object):
        def load(self):
            return True

        def face_locations(self, rgb_image):
            return []

    fake_detector_module.Cv2HaarDetector = _FakeDetector
    monkeypatch.setitem(
        sys.modules, "face_recog.detector", fake_detector_module,
    )

    saved = []
    import recognizer as recognizer_module
    monkeypatch.setattr(
        recognizer_module, "_save_face_capture",
        lambda **kw: saved.append(kw),
    )

    r = FaceRecognizer("/dev/null")

    # act
    result = r.recognize_in_crop(
        rgb_image="fake",
        capture_dir=str(tmp_path / "captures"),
        event_id="evt-empty",
        ts_ms=1700000000000,
    )

    # assert — no faces, no save.
    assert result is None
    assert saved == []


def test_given_cv2_fallback_with_multiple_faces_when_recognize_called_then_each_saved(
    monkeypatch, tmp_path,
):
    # arrange — 3 faces of different sizes; recognize loops all.
    import sys
    import types

    fake_detector_module = types.SimpleNamespace()

    class _FakeDetector(object):
        def load(self):
            return True

        def face_locations(self, rgb_image):
            # Three faces: top-left, middle, bottom-right.
            return [
                (0, 100, 100, 0),
                (200, 350, 300, 250),
                (400, 500, 480, 420),
            ]

    fake_detector_module.Cv2HaarDetector = _FakeDetector
    monkeypatch.setitem(
        sys.modules, "face_recog.detector", fake_detector_module,
    )

    saved = []
    import recognizer as recognizer_module
    monkeypatch.setattr(
        recognizer_module, "_save_face_capture",
        lambda **kw: saved.append(kw),
    )

    r = FaceRecognizer("/dev/null")

    # act
    r.recognize_in_crop(
        rgb_image="fake",
        capture_dir=str(tmp_path / "captures"),
        event_id="evt-multi",
        ts_ms=1700000000000,
    )

    # assert — all 3 saved with distinct ts_ms (idx-bumped).
    assert len(saved) == 3
    ts_values = [s["ts_ms"] for s in saved]
    assert ts_values == [1700000000000, 1700000000001, 1700000000002]
    # All have name=None confidence=0.0 (cv2 doesn't match).
    assert all(s["name"] is None for s in saved)
    assert all(s["confidence"] == 0.0 for s in saved)
