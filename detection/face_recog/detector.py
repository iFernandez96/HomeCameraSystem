"""iter-355b1a (active-learning rebuild): cv2 Haar-cascade face
detector. Closes the dormant-recognizer gap — face capture happens
on day one whether or not encodings.pkl exists.

Why this exists: `face_recognition.face_locations()` requires `dlib`,
which on the Jetson Nano with dlib v20 deadlocks at import time
(documented sharp edge in CLAUDE.md). The existing recognizer's
init-gate skips loading face_recognition unless encodings.pkl exists;
that means a fresh install has zero face captures until the operator
seeds an initial encoding via SSH.

cv2's Haar cascade is the workaround:
- ships with OpenCV (apt python-opencv on JetPack) — no extra pip dep
- doesn't import dlib
- ~30 ms per 720p frame on the Nano (acceptable post-cooldown-gate)
- accuracy is lower than face_recognition's HOG (more false positives,
  fewer correctly-localized faces), but for "save a crop the operator
  can label later" that's fine — the operator filters out garbage in
  the iter-353 move/delete UI

Contract: `Cv2HaarDetector.face_locations(rgb_image)` returns the
SAME shape as `face_recognition.face_locations(rgb_image, model="hog")`
— a list of (top, right, bottom, left) integer tuples — so the
iter-355a recognizer code path treats both detectors uniformly.

Module is Python 3.6 compatible (CLAUDE.md sharp edge: detection/*.py
must stay 3.6-safe — no walrus, no PEP 604 unions, no f-strings with
`{x=}`, no list[int] generics). cv2 is lazy-imported so the worker
can fall back gracefully on environments without OpenCV.
"""
import logging
import os

log = logging.getLogger(__name__)


# Tuned defaults for Jetson Nano + 720p RGB person-bbox crops:
# - scaleFactor: cv2 default 1.1; we use 1.2 (faster, slightly
#   coarser pyramid) since we're capturing for retraining not for
#   tight bbox alignment.
# - minNeighbors: cv2 default 3; we use 5 (fewer false positives
#   on textures that look like faces — wood grain, leaves, etc.).
# - minSize: 30x30 px floor; faces smaller are unusable for retrain
#   anyway (face_recognition's HOG also wants ~150px ideal).
_SCALE_FACTOR = 1.2
_MIN_NEIGHBORS = 5
_MIN_SIZE = (30, 30)


class Cv2HaarDetector(object):
    """Wraps cv2's CascadeClassifier with the same `face_locations`
    contract as `face_recognition` so the recognizer can fall back
    transparently when face_recognition is not loaded (dormant state).

    Usage:
        d = Cv2HaarDetector()
        if d.load():
            boxes = d.face_locations(rgb_image)  # [(top, right, bottom, left), ...]

    `load()` returns False when cv2 is unavailable OR the bundled
    Haar cascade XML can't be located. In that case the worker is
    fully dormant for face capture (same behavior as today). The
    caller MUST check the return value before calling face_locations.
    """

    def __init__(self):
        self._cv2 = None
        self._cascade = None

    def load(self):
        """Lazy-load cv2 + the bundled Haar cascade. Returns True on
        success, False on any failure (cv2 missing, cascade XML
        missing, etc.). Idempotent — safe to call multiple times."""
        if self._cascade is not None:
            return True
        try:
            import cv2
        except ImportError:
            log.warning(
                "cv2 unavailable — face capture stays dormant until "
                "encodings.pkl exists. Install python-opencv on the "
                "Jetson (apt-get install python3-opencv) to enable "
                "the iter-355b1a always-on capture path."
            )
            return False
        # cv2's `cv2.data.haarcascades` resolves to the bundled XML
        # dir. Some apt builds (older OpenCV 3.x) don't expose
        # `cv2.data` — fall back to a manual path search.
        xml_path = _find_haar_cascade_xml(cv2)
        if xml_path is None:
            log.warning(
                "cv2 Haar cascade XML not found — checked cv2.data.haarcascades "
                "and common fallback paths. Face capture stays dormant."
            )
            return False
        try:
            cascade = cv2.CascadeClassifier(xml_path)
        except Exception as e:
            log.warning("cv2 CascadeClassifier load failed: %s", e)
            return False
        if cascade.empty():
            log.warning("cv2 cascade is empty (XML at %s loaded but invalid)", xml_path)
            return False
        self._cv2 = cv2
        self._cascade = cascade
        log.info("cv2 Haar detector ready (cascade: %s)", xml_path)
        return True

    def face_locations(self, rgb_image):
        """Detect faces in `rgb_image` (HxWx3 uint8 numpy array, RGB).
        Returns a list of (top, right, bottom, left) integer tuples
        — same shape as `face_recognition.face_locations(...)`.

        cv2's CascadeClassifier wants grayscale; we convert internally
        so the caller doesn't have to remember.

        Returns [] when:
        - load() hasn't been called or returned False
        - cv2 detection fails (logged at debug)
        - no faces detected
        """
        if self._cascade is None or self._cv2 is None:
            return []
        try:
            gray = self._cv2.cvtColor(rgb_image, self._cv2.COLOR_RGB2GRAY)
        except Exception as e:
            log.debug("cv2 RGB→GRAY convert failed: %s", e)
            return []
        try:
            rects = self._cascade.detectMultiScale(
                gray,
                scaleFactor=_SCALE_FACTOR,
                minNeighbors=_MIN_NEIGHBORS,
                minSize=_MIN_SIZE,
            )
        except Exception as e:
            log.debug("cv2 detectMultiScale failed: %s", e)
            return []
        # cv2 returns a numpy array of (x, y, w, h) per face. Convert
        # to face_recognition's (top, right, bottom, left) shape.
        # `len(rects)` works on both numpy array AND empty list (cv2
        # returns () when nothing detected).
        if len(rects) == 0:
            return []
        out = []
        for r in rects:
            x, y, w, h = int(r[0]), int(r[1]), int(r[2]), int(r[3])
            top = y
            right = x + w
            bottom = y + h
            left = x
            out.append((top, right, bottom, left))
        return out


def _find_haar_cascade_xml(cv2_module):
    """Locate the bundled `haarcascade_frontalface_default.xml`. Tries
    the modern `cv2.data.haarcascades` attribute first, then falls
    back to a list of common install paths.
    """
    target = "haarcascade_frontalface_default.xml"
    # Modern cv2 (3.4+) exposes the data dir.
    try:
        data_dir = cv2_module.data.haarcascades
        candidate = os.path.join(data_dir, target)
        if os.path.exists(candidate):
            return candidate
    except AttributeError:
        pass
    # Apt-built OpenCV on Ubuntu/JetPack often drops the XMLs here.
    fallback_paths = [
        "/usr/share/opencv4/haarcascades/" + target,
        "/usr/share/opencv/haarcascades/" + target,
        "/usr/local/share/opencv4/haarcascades/" + target,
        "/usr/local/share/OpenCV/haarcascades/" + target,
    ]
    for p in fallback_paths:
        if os.path.exists(p):
            return p
    return None
