"""Match a detected person's face against the known-faces database.

Used by `detection/detect.py` (iter-22). Loads `encodings.pkl` once at
worker startup; per-frame, given a numpy RGB crop containing a person,
returns the best-matching name (or `None` for unknown).

Tuning notes:
  - face_recognition's default tolerance is 0.6. Lower = stricter (fewer
    false positives, more "unknown"). For a doorbell with a small set
    of people this can usually go to 0.5.
  - The "best match" is the encoding with the smallest Euclidean distance
    in 128-d face space; we additionally require it to be below the
    tolerance to avoid labeling random visitors as Israel/Sheenal.
  - face_recognition is imported lazily so the worker can boot even when
    the library is missing — events still flow with the generic "person"
    label.
"""
import logging
import os
import pickle

log = logging.getLogger(__name__)


class FaceRecognizer:
    def __init__(self, encodings_path, tolerance=0.55):
        self.encodings_path = encodings_path
        self.tolerance = tolerance
        self.names = []
        self.encs = None  # numpy array, populated lazily
        self._fr = None   # face_recognition module handle, lazily imported
        # iter-355b1b: cv2 fallback detector. Used ONLY when
        # face_recognition is unavailable (no encodings.pkl OR dlib
        # would deadlock). Detect-only — no encoding/matching path
        # since cv2 doesn't ship 128-d face encodings. Lazy-instantiated
        # on first dormant-state recognize_in_crop call so a worker
        # with encodings.pkl never imports cv2 (saves ~25 ms boot).
        self._cv2_detector = None

    def load(self):
        """Load encodings from disk. Returns True if usable, False if file
        is missing or empty (caller should treat recognition as disabled)."""
        if not os.path.exists(self.encodings_path):
            log.warning("recognizer: %s missing - face matching disabled",
                        self.encodings_path)
            return False
        try:
            with open(self.encodings_path, "rb") as f:
                pairs = pickle.load(f)
        except Exception as e:
            log.warning("recognizer: could not read %s: %s", self.encodings_path, e)
            return False
        if not pairs:
            return False
        try:
            import numpy as np
        except ImportError:
            log.warning("recognizer: numpy missing")
            return False
        try:
            import face_recognition as fr
            self._fr = fr
        except Exception as e:
            log.warning("recognizer: face_recognition unavailable (%s) - matching disabled", e)
            return False
        self.names = [name for name, _ in pairs]
        self.encs = np.asarray([enc for _, enc in pairs], dtype="float64")
        log.info("recognizer: loaded %d encodings (%s)",
                 len(self.names), set(self.names))
        return True

    def match(self, encoding):
        """Return (name, confidence) for the closest known encoding, or
        (None, confidence) when no encoding is within tolerance.

        - `name`: the matched person's name when distance <= tolerance,
          else None. Same semantics as pre-iter-355a.
        - `confidence`: float in [0.0, 1.0]. iter-355a addition. Computed
          as `max(0.0, 1.0 - dist/tolerance)` so that distance 0 → 1.0
          and distance == tolerance → 0.0. The Tinder-card review UI
          uses this to surface "73% confident" + sort by uncertainty.

        Returns (None, 0.0) when no encodings are loaded — the dormant
        state. Caller checks both fields, NOT a truthy name alone, since
        the iter-355a sidecar wants the confidence value even on misses
        (a 0.62 "almost matched" is the most interesting case for review).
        """
        if self.encs is None or not self.names:
            return (None, 0.0)
        import numpy as np

        dists = np.linalg.norm(self.encs - encoding, axis=1)
        best_idx = int(np.argmin(dists))
        best_dist = float(dists[best_idx])
        # Confidence: distance 0 → 1.0; distance >= tolerance → 0.0.
        confidence = max(0.0, 1.0 - best_dist / self.tolerance)
        if best_dist > self.tolerance:
            # Past tolerance → not a match; return name=None but keep
            # the confidence (capped at 0.0 by the formula above when
            # distance > tolerance).
            return (None, confidence)
        return (self.names[best_idx], confidence)

    def recognize_in_crop(self, rgb_image, capture_dir=None,
                          event_id=None, ts_ms=None,
                          capture_meta=None, face_origin_xy=None):
        """Detect faces in `rgb_image` (HxWx3 uint8 numpy, RGB), match
        each (when encodings are loaded), and return the best matched
        name or None.

        iter-351/355a (face-capture-for-retraining): when `capture_dir`
        is provided AND faces are detected, EVERY face crop is saved
        with a sidecar JSON carrying `{predicted_name, confidence,
        event_id, ts_ms}`.

        iter-355b1b (always-on capture): when `face_recognition` is
        unavailable (no encodings.pkl yet, OR dlib would deadlock at
        import on the Nano), falls back to cv2's Haar cascade for
        DETECTION ONLY. Crops still save (predicted_name=None,
        confidence=0.0) so the operator's first walk-by populates
        face_captures/__unknown__/ — the iter-355c Tinder-card review
        UI then lets them label, run encode_known_faces.py, and
        graduate to the full match path. Closes the dormant-recognizer
        gap that previously required SSH bootstrap.

        Capture is best-effort — the worker hot-path never crashes on
        a save error. Pass `capture_dir=None` (default) to disable.
        """
        # Path A: face_recognition loaded → detect + match (full path).
        # Path B: cv2 fallback → detect only (always-on capture).
        if self._fr is not None:
            try:
                boxes = self._fr.face_locations(rgb_image, model="hog")
            except Exception:
                # face_locations (dlib HOG) crashed — face matching is
                # dead for this frame, no name returned. log.exception so
                # the dlib/CUDA stack survives (3.6-safe). event_id ties
                # the failure to the triggering detection.
                log.exception(
                    "recognizer: face_locations failed (event_id=%s) - "
                    "face matching skipped this frame",
                    event_id,
                )
                return None
            do_match = True
        else:
            # iter-355b1b: lazy-init cv2 detector. Returns False+empty
            # on environments without cv2 (graceful degrade — same as
            # pre-iter-355b1b dormant state).
            if self._cv2_detector is None:
                from face_recog.detector import Cv2HaarDetector
                self._cv2_detector = Cv2HaarDetector()
                self._cv2_detector.load()
            boxes = self._cv2_detector.face_locations(rgb_image)
            do_match = False

        if not boxes:
            return None
        # boxes: list of (top, right, bottom, left). Sort largest area first.
        boxes_sorted = sorted(
            boxes,
            key=lambda b: (b[2] - b[0]) * (b[1] - b[3]),
            reverse=True,
        )

        # iter-355a: build a parallel list of per-face matches so
        # capture writes can stamp the right name + confidence per face.
        # iter-355b1b: cv2-fallback path skips encoding/match entirely;
        # all faces get (name=None, confidence=0.0). Sidecar still
        # written so the iter-355c review queue has the event_id.
        per_face = []
        first_matched = None
        if do_match:
            try:
                encs = self._fr.face_encodings(rgb_image, boxes_sorted)
            except Exception:
                # face_encodings (dlib 128-d) crashed after locations
                # succeeded — all faces this frame go unmatched. Stack
                # via log.exception (3.6-safe). %d faces names the size
                # of the batch that was lost.
                log.exception(
                    "recognizer: face_encodings failed (event_id=%s, "
                    "faces=%d) - faces unmatched this frame",
                    event_id, len(boxes_sorted),
                )
                return None
            for box, enc in zip(boxes_sorted, encs):
                name, conf = self.match(enc)
                per_face.append((box, name, conf))
                if name and first_matched is None:
                    first_matched = name
        else:
            for box in boxes_sorted:
                per_face.append((box, None, 0.0))

        # Save each face crop + sidecar (best-effort). Lazy-imports PIL
        # only when capture is active.
        # iter-356.62 (slice 1): per-face meta override layers
        # `face_bbox_within_crop` (and, when face_origin_xy is supplied,
        # `face_bbox_within_source`) on top of the worker-supplied
        # capture_meta. The recognizer is the only caller that knows the
        # face's coords inside the face-region crop, so it owns this
        # field.
        if capture_dir and per_face:
            for idx, (box, name, conf) in enumerate(per_face):
                # box is (top, right, bottom, left). Convert to
                # [left, top, right, bottom] pixel-coords within the
                # rgb_image (= face-region crop) the recognizer received.
                top, right, bottom, left = box
                bbox_in_crop = [int(left), int(top), int(right), int(bottom)]
                per_face_meta = {}
                if capture_meta:
                    per_face_meta.update(capture_meta)
                per_face_meta["face_bbox_within_crop"] = bbox_in_crop
                if face_origin_xy is not None:
                    ox, oy = face_origin_xy
                    per_face_meta["face_bbox_within_source"] = [
                        int(left) + int(ox),
                        int(top) + int(oy),
                        int(right) + int(ox),
                        int(bottom) + int(oy),
                    ]
                try:
                    _save_face_capture(
                        rgb_image=rgb_image,
                        box=box,
                        name=name,
                        confidence=conf,
                        capture_dir=capture_dir,
                        event_id=event_id or "unknown",
                        ts_ms=(ts_ms or 0) + idx,
                        meta=per_face_meta,
                    )
                except Exception:
                    # Best-effort capture: a save failure (disk full,
                    # PIL encode error, capture_dir unwritable) must not
                    # crash the hot path, but the operator needs to know
                    # the retrain queue isn't being populated. WARNING +
                    # stack (3.6-safe log.exception). idx/event_id locate
                    # the dropped crop.
                    log.exception(
                        "recognizer: capture save failed (event_id=%s, "
                        "face_idx=%d, capture_dir=%s) - crop NOT saved "
                        "to retrain queue",
                        event_id, idx, capture_dir,
                    )
        return first_matched


# iter-351 (user "highest quality the camera can take"): bumped JPEG
# quality 85 → 95. The crop is bounded above by the source frame's
# resolution (today 720p from MediaMTX's NVENC, tomorrow whatever the
# new camera produces); within that ceiling, q=95 keeps face_recognition's
# HOG model happy on retrain (q=85 introduces ringing at face edges
# that costs a few percentage points of distance accuracy when the
# operator re-encodes via encode_known_faces.py).
_FACE_JPEG_QUALITY = 95

# iter-351: pad the face bbox by ~30 % on each side so the saved crop
# carries enough context for face_recognition to re-detect the face on
# retrain (the library's `face_locations(model="hog")` wants ~150 px of
# face + breathing room; a tight bbox crop makes re-detection fail and
# the example gets silently dropped from the training set). Padding is
# bounded to the source-image dimensions — never escapes the array.
_FACE_BBOX_PAD_FRAC = 0.30
_FACE_QUALITY_REJECTIONS = {}


def _record_face_quality_rejection(reason):
    safe_reason = reason if reason in (
        "too_small", "low_contrast", "blurry", "invalid",
    ) else "invalid"
    count = _FACE_QUALITY_REJECTIONS.get(safe_reason, 0) + 1
    _FACE_QUALITY_REJECTIONS[safe_reason] = count
    # First occurrence is immediately visible; sustained rejection is sampled
    # rather than logged once per face on the camera hot path.
    if count == 1 or count % 100 == 0:
        log.info(
            "face capture quality rejected reason=%s count=%d",
            safe_reason, count,
        )


def face_quality_rejection_counts():
    return dict(_FACE_QUALITY_REJECTIONS)


def _save_face_capture(rgb_image, box, name, confidence, capture_dir,
                       event_id, ts_ms, meta=None):
    """Crop the face from `rgb_image` per `box` (top, right, bottom,
    left) WITH padding for retrain context, JPEG-encode it via PIL at
    quality 95, hand off to capture.save_face_capture with the iter-355a
    sidecar fields. Lazy PIL import — only loaded when capture is active.

    iter-355a: takes `confidence` so the sidecar JSON can record the
    classifier's certainty for the Tinder-card review queue. None
    `name` on a no-match still passes the confidence so the operator
    can see "62% — almost matched Alice" on near-miss crops.
    """
    from PIL import Image
    import io
    from face_recog.capture import save_face_capture
    from face_recog.quality import face_crop_quality

    top, right, bottom, left = box
    h = rgb_image.shape[0]
    w = rgb_image.shape[1]
    fh = bottom - top
    fw = right - left
    # Gate the actual detected face, not its padded context.  Recognition has
    # already happened; this only prevents unusable biometric training data
    # from being persisted.
    tight_crop = rgb_image[max(0, top):min(h, bottom), max(0, left):min(w, right)]
    accepted, _reason, _quality = face_crop_quality(tight_crop)
    if not accepted:
        _record_face_quality_rejection(_reason)
        return False
    pad_h = int(fh * _FACE_BBOX_PAD_FRAC)
    pad_w = int(fw * _FACE_BBOX_PAD_FRAC)
    top_p = max(0, top - pad_h)
    bottom_p = min(h, bottom + pad_h)
    left_p = max(0, left - pad_w)
    right_p = min(w, right + pad_w)
    crop = rgb_image[top_p:bottom_p, left_p:right_p]
    if crop.size == 0:
        return False
    img = Image.fromarray(crop)
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=_FACE_JPEG_QUALITY)
    capture_meta = dict(meta or {})
    capture_meta["quality"] = dict(
        (key, _quality[key])
        for key in ("width", "height", "contrast", "sharpness")
        if key in _quality
    )
    written = save_face_capture(
        capture_dir=capture_dir,
        name=name,
        event_id=event_id,
        ts_ms=ts_ms,
        jpeg_bytes=buf.getvalue(),
        confidence=confidence,
        predicted_name=name,
        meta=capture_meta,
    )
    return bool(written)
