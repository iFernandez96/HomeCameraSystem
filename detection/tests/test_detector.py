"""iter-355b1a: pin Cv2HaarDetector behavior. cv2 is mocked because
the dev venv (`/tmp/homecam-venv`) doesn't have python-opencv — on
the Jetson host cv2 is installed via apt and the real path is
exercised at worker boot. These tests pin the module's CONTRACT
(graceful-degrade when cv2 missing, correct shape conversion
cv2→face_recognition format, empty result when no faces) without
needing the heavy CUDA-linked OpenCV in the test env.
"""
import os
import sys
import types

import pytest

# Add detection/ to sys.path so `face_recog.detector` import resolves
# (detection/ has no __init__.py per CLAUDE.md sharp edge — modules
# are discovered via PYTHONPATH not package import).
_HERE = os.path.dirname(os.path.abspath(__file__))
_DETECT_DIR = os.path.dirname(_HERE)
if _DETECT_DIR not in sys.path:
    sys.path.insert(0, _DETECT_DIR)

from face_recog.detector import Cv2HaarDetector  # noqa: E402


def test_when_cv2_unavailable_then_load_returns_false_and_face_locations_empty():
    # arrange — cv2 isn't installed in the dev venv. Real path is
    # ImportError → load() returns False without raising.
    d = Cv2HaarDetector()

    # act
    loaded = d.load()

    # assert
    assert loaded is False
    assert d.face_locations(object()) == []


def test_when_load_called_twice_then_idempotent():
    # arrange — load() should be a no-op after the first successful
    # call. This test pins the early-return path even when cv2 is
    # missing: subsequent calls also return False without re-importing.
    d = Cv2HaarDetector()

    # act
    first = d.load()
    second = d.load()

    # assert
    assert first == second


def test_given_mock_cv2_with_faces_when_face_locations_called_then_returns_top_right_bottom_left(
    monkeypatch,
):
    # arrange — install a fake cv2 module that returns one face at
    # (x=10, y=20, w=50, h=60). Expected output: (top=20, right=60,
    # bottom=80, left=10) — the face_recognition shape.
    fake_cv2 = _build_fake_cv2_module(
        rects_returned=[[10, 20, 50, 60]],
    )
    monkeypatch.setitem(sys.modules, "cv2", fake_cv2)
    d = Cv2HaarDetector()
    loaded = d.load()
    assert loaded is True

    # act
    out = d.face_locations(_fake_rgb_image())

    # assert
    assert out == [(20, 60, 80, 10)]


def test_given_mock_cv2_with_no_faces_when_face_locations_called_then_returns_empty(
    monkeypatch,
):
    # arrange — fake cv2 returns no detections (cv2's actual
    # detectMultiScale returns an empty tuple in this case).
    fake_cv2 = _build_fake_cv2_module(rects_returned=())
    monkeypatch.setitem(sys.modules, "cv2", fake_cv2)
    d = Cv2HaarDetector()
    d.load()

    # act
    out = d.face_locations(_fake_rgb_image())

    # assert
    assert out == []


def test_given_mock_cv2_with_multiple_faces_when_called_then_each_face_converted(
    monkeypatch,
):
    # arrange — two faces of different sizes/positions.
    fake_cv2 = _build_fake_cv2_module(
        rects_returned=[
            [0, 0, 100, 100],     # top-left face: top=0, right=100, bottom=100, left=0
            [200, 150, 80, 80],   # second face:   top=150, right=280, bottom=230, left=200
        ],
    )
    monkeypatch.setitem(sys.modules, "cv2", fake_cv2)
    d = Cv2HaarDetector()
    d.load()

    # act
    out = d.face_locations(_fake_rgb_image())

    # assert
    assert out == [(0, 100, 100, 0), (150, 280, 230, 200)]


def test_given_mock_cv2_with_empty_cascade_when_loaded_then_returns_false(
    monkeypatch,
):
    # arrange — fake cv2 whose CascadeClassifier reports empty()=True
    # (XML failed to load even though the path exists).
    fake_cv2 = _build_fake_cv2_module(rects_returned=[], cascade_empty=True)
    monkeypatch.setitem(sys.modules, "cv2", fake_cv2)
    d = Cv2HaarDetector()

    # act
    loaded = d.load()

    # assert
    assert loaded is False
    assert d.face_locations(_fake_rgb_image()) == []


def test_given_mock_cv2_with_no_data_attr_then_falls_back_to_apt_path(
    monkeypatch, tmp_path,
):
    # arrange — older cv2 builds drop the cv2.data attribute; the
    # detector falls back to /usr/share/opencv4/haarcascades. We
    # simulate that path by creating a fake cascade XML and
    # monkeypatching os.path.exists to claim it's there.
    fake_cv2 = _build_fake_cv2_module(rects_returned=[], drop_data_attr=True)
    monkeypatch.setitem(sys.modules, "cv2", fake_cv2)

    # Patch the detector's _find_haar_cascade_xml to return a path
    # that "exists" (the os.path.exists guard inside the function
    # picks the first valid one).
    from face_recog import detector as detector_module
    original_exists = os.path.exists
    fake_path = "/usr/share/opencv4/haarcascades/haarcascade_frontalface_default.xml"

    def _fake_exists(p):
        if p == fake_path:
            return True
        return original_exists(p)

    monkeypatch.setattr(detector_module.os.path, "exists", _fake_exists)

    d = Cv2HaarDetector()

    # act
    loaded = d.load()

    # assert — the apt fallback path was found.
    assert loaded is True


# --- helpers ---


def _build_fake_cv2_module(rects_returned, cascade_empty=False, drop_data_attr=False):
    """Build a stand-in `cv2` module that exposes the surface
    `Cv2HaarDetector.load()` and `.face_locations()` rely on:
    - cv2.COLOR_RGB2GRAY constant
    - cv2.cvtColor function (passthrough)
    - cv2.CascadeClassifier class
    - cv2.data.haarcascades attribute (or absent if drop_data_attr)
    """
    fake = types.SimpleNamespace()
    fake.COLOR_RGB2GRAY = 0  # arbitrary int

    def _cvtColor(img, code):
        # In the real path this returns a single-channel grayscale
        # numpy array. For tests we just pass through — the cascade
        # mock doesn't care.
        return img

    fake.cvtColor = _cvtColor

    class _FakeCascade(object):
        def __init__(self, xml_path):
            self._empty = cascade_empty

        def empty(self):
            return self._empty

        def detectMultiScale(self, gray, scaleFactor, minNeighbors, minSize):
            return rects_returned

    fake.CascadeClassifier = _FakeCascade

    if not drop_data_attr:
        fake.data = types.SimpleNamespace(haarcascades="/fake/haar/dir/")

        # Make the fake path "exist" so the detector picks it.
        import os as _os
        _real_exists = _os.path.exists

        def _patched_exists(p):
            if p == "/fake/haar/dir/haarcascade_frontalface_default.xml":
                return True
            return _real_exists(p)

        # Patch on the imported os.path inside detector.py.
        import face_recog.detector as _det
        _det.os.path.exists = _patched_exists

    return fake


def _fake_rgb_image():
    """Stand-in for an HxWx3 numpy array. The mocked cv2.cvtColor
    is a passthrough so we just need any object."""
    return object()
