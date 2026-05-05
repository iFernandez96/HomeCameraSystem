"""iter-357 (multi-person face-recog) unit tests.

The detect.py module imports jetson_inference + jetson_utils at module
load — both unavailable in the dev venv (they're host-only TensorRT
bindings). So we can't `import detect` in CI / desktop tests; instead
this file tests the multi-person helpers (`_bbox_iou`,
`_read_max_persons`) by extracting them via a controlled import shim
that stubs the jetson modules BEFORE detect.py loads.

The shim approach is the same pattern `detection/tests/test_recognizer.py`
uses to test the recognizer's graceful-degradation paths without dlib +
face_recognition installed. Once stubbed, the helpers under test are
pure-Python and have zero remaining hardware dependency, so we exercise
them directly with synthetic bboxes.

Coverage:
- `_bbox_iou`: separated boxes (IoU=0), identical boxes (IoU=1),
  partial overlaps (typical 0.4-0.7 range), degenerate boxes (zero
  area), inputs that produce zero union (defensive).
- `_read_max_persons`: default value, integer override, malformed
  string fallback, negative clamp, over-ceiling clamp.

The end-to-end loop behavior (greedy IoU dedup, per-person
recognize_in_crop, capture sidecar fan-out) is verified at the
server-payload level by `server/tests/test_internal_multi_person.py`
which posts wire-shape payloads to `/api/_internal/event` and checks
they round-trip cleanly through the Pydantic + event bus + DB
layers. That's the layer where regressions would break user-visible
behavior; this file pins the math.
"""
# arrange — stub jetson_inference + jetson_utils so detect.py imports
# clean on Linux x86_64 dev hosts. The real worker imports them at
# module load; the stubs satisfy the binding without loading TensorRT.
import os
import sys
import types
from pathlib import Path

import pytest


_HERE = Path(__file__).resolve().parent
_DETECTION_DIR = _HERE.parent
sys.path.insert(0, str(_DETECTION_DIR))


def _install_stubs():
    """Install minimal stubs for the host-only modules detect.py
    pulls in. Each stub satisfies the symbols detect.py reads at
    module-load time. Skip when the real modules are present (i.e.
    running on the Jetson) so the tests exercise the production
    import path."""
    if "jetson_inference" not in sys.modules:
        ji = types.ModuleType("jetson_inference")

        class _DetectNet:
            def __init__(self, *a, **kw):
                pass

        ji.detectNet = _DetectNet
        sys.modules["jetson_inference"] = ji
    if "jetson_utils" not in sys.modules:
        ju = types.ModuleType("jetson_utils")

        class _VS:
            def __init__(self, *a, **kw):
                pass

            def Capture(self, *a, **kw):
                return None

        class _CudaImg:
            pass

        ju.videoSource = _VS
        ju.cudaImage = _CudaImg
        sys.modules["jetson_utils"] = ju


_install_stubs()

# act — import the module under test now that stubs are in place.
import detect  # noqa: E402


# --- _bbox_iou ----------------------------------------------------------


class TestBboxIou:
    """iter-357 IoU-dedup math. The greedy person-bbox selector uses
    `_PERSON_DEDUP_IOU = 0.5` to discard SSD double-detects of the
    same physical person while preserving genuine side-by-side
    detections. These tests pin both edges of that threshold."""

    def test_given_two_clearly_separated_boxes_when_iou_called_then_zero(self):
        # arrange — two non-overlapping 100×100 boxes side by side.
        a = (0, 0, 100, 100)
        b = (200, 0, 300, 100)

        # act
        iou = detect._bbox_iou(*a, *b)

        # assert
        assert iou == 0.0

    def test_given_identical_boxes_when_iou_called_then_one(self):
        # arrange
        a = (10, 20, 110, 220)
        b = (10, 20, 110, 220)

        # act
        iou = detect._bbox_iou(*a, *b)

        # assert
        assert iou == 1.0

    def test_given_half_overlapping_boxes_when_iou_called_then_one_third(self):
        # arrange — two 100×100 boxes overlapping by 50px horizontally.
        # intersection = 50*100 = 5000; union = 100*100 + 100*100 - 5000 = 15000
        # IoU = 5000/15000 = 0.333...
        a = (0, 0, 100, 100)
        b = (50, 0, 150, 100)

        # act
        iou = detect._bbox_iou(*a, *b)

        # assert
        assert iou == pytest.approx(1.0 / 3.0)

    def test_given_heavily_overlapping_boxes_when_iou_called_then_above_dedup_threshold(self):
        # arrange — typical SSD-double pattern: two boxes for the
        # same physical person with ~10px jitter on each side.
        a = (100, 200, 300, 600)  # 200×400 = 80,000
        b = (110, 210, 295, 595)  # 185×385 = 71,225

        # act
        iou = detect._bbox_iou(*a, *b)

        # assert — heavy overlap should be well above the 0.5 dedup
        # threshold (typical SSD-doubles land at IoU > 0.7).
        assert iou > 0.5
        assert iou >= detect._PERSON_DEDUP_IOU

    def test_given_two_people_side_by_side_when_iou_called_then_below_dedup_threshold(self):
        # arrange — two distinct people standing apart at the front
        # door. IoU should land well below the 0.5 dedup threshold so
        # the second person isn't filtered out as a "duplicate."
        # 200×400 person A on the left, 200×400 person B on the right
        # with a 50 px gap.
        a = (50, 100, 250, 500)
        b = (300, 100, 500, 500)

        # act
        iou = detect._bbox_iou(*a, *b)

        # assert
        assert iou == 0.0
        assert iou < detect._PERSON_DEDUP_IOU

    def test_given_degenerate_zero_area_box_when_iou_called_then_zero_no_crash(self):
        # arrange — degenerate box with zero width.
        a = (100, 100, 100, 200)
        b = (50, 50, 200, 200)

        # act
        iou = detect._bbox_iou(*a, *b)

        # assert — defensive zero-union path returns 0.0 instead of
        # ZeroDivisionError.
        assert iou == 0.0

    def test_given_box_inside_other_when_iou_called_then_ratio_of_areas(self):
        # arrange — small box wholly inside a large one. intersection
        # = small area; union = large area. IoU = small/large.
        outer = (0, 0, 100, 100)  # area 10000
        inner = (25, 25, 75, 75)  # area 2500

        # act
        iou = detect._bbox_iou(*outer, *inner)

        # assert
        assert iou == pytest.approx(2500.0 / 10000.0)


# --- _read_max_persons --------------------------------------------------


class TestReadMaxPersons:
    """iter-357 env-var parsing for the per-event person cap. The
    cap protects the Nano: each HOG face-locate is ~200 ms, so an
    unbounded loop on a 10-person frame would burn ~2 s before the
    cooldown gate clears."""

    def test_given_no_env_set_when_read_then_default_four(self, monkeypatch):
        # arrange
        monkeypatch.delenv("HOMECAM_MAX_PERSONS_FACE_RECOG", raising=False)

        # act
        v = detect._read_max_persons()

        # assert
        assert v == 4

    def test_given_explicit_one_when_read_then_one(self, monkeypatch):
        # arrange — operator sets =1 to keep iter-22 single-person
        # behavior on a thermally-marginal Nano.
        monkeypatch.setenv("HOMECAM_MAX_PERSONS_FACE_RECOG", "1")

        # act
        v = detect._read_max_persons()

        # assert
        assert v == 1

    def test_given_zero_when_read_then_zero_disables_face_recog(self, monkeypatch):
        # arrange — operator sets =0 to disable face-recog entirely
        # on overheating events. The detect.py loop checks
        # `_MAX_PERSONS_FACE_RECOG > 0` before entering the per-
        # person branch, so zero short-circuits cleanly.
        monkeypatch.setenv("HOMECAM_MAX_PERSONS_FACE_RECOG", "0")

        # act
        v = detect._read_max_persons()

        # assert
        assert v == 0

    def test_given_negative_when_read_then_clamped_to_zero(self, monkeypatch):
        # arrange — operator typo / shell-escape mishap sets =-1.
        monkeypatch.setenv("HOMECAM_MAX_PERSONS_FACE_RECOG", "-1")

        # act
        v = detect._read_max_persons()

        # assert — clamps to zero (disables) rather than triggering
        # an unbounded loop on a negative cap.
        assert v == 0

    def test_given_over_ceiling_when_read_then_clamped_to_sixteen(self, monkeypatch):
        # arrange — operator sets =999. SSD detectNet caps at 32
        # boxes total; face-recog cost is the bound that matters.
        # The hard ceiling at 16 keeps an over-eager operator from
        # stalling the worker on a crowd scene.
        monkeypatch.setenv("HOMECAM_MAX_PERSONS_FACE_RECOG", "999")

        # act
        v = detect._read_max_persons()

        # assert
        assert v == 16

    def test_given_garbage_string_when_read_then_default(self, monkeypatch):
        # arrange — operator sets =abc.
        monkeypatch.setenv("HOMECAM_MAX_PERSONS_FACE_RECOG", "abc")

        # act
        v = detect._read_max_persons()

        # assert — falls back to default (4) rather than crashing
        # the worker on a bad env var.
        assert v == 4

    def test_given_empty_string_when_read_then_default(self, monkeypatch):
        # arrange — operator sets =""  (also covered by the int()
        # ValueError path).
        monkeypatch.setenv("HOMECAM_MAX_PERSONS_FACE_RECOG", "")

        # act
        v = detect._read_max_persons()

        # assert
        assert v == 4
