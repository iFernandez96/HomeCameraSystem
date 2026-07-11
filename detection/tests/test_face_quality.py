from face_recog.quality import face_crop_quality


class _Image(object):
    def __init__(self, width, height, pattern):
        self.shape = (height, width, 3)
        self.pattern = pattern

    def __getitem__(self, key):
        y, x = key
        if self.pattern == "constant":
            value = 127
        elif self.pattern == "gradient":
            value = int(255.0 * x / max(1, self.shape[1] - 1))
        else:
            value = 210 if (x + y) % 2 else 30
        return (value, value, value)


def test_rejects_very_small_face_even_when_textured():
    crop = _Image(24, 24, "checker")
    accepted, reason, metrics = face_crop_quality(crop)
    assert accepted is False
    assert reason == "too_small"
    assert metrics["width"] == 24


def test_rejects_low_contrast_face():
    crop = _Image(64, 64, "constant")
    accepted, reason, metrics = face_crop_quality(crop)
    assert accepted is False
    assert reason == "low_contrast"
    assert metrics["contrast"] == 0.0


def test_rejects_blurry_high_contrast_gradient():
    crop = _Image(80, 80, "gradient")
    accepted, reason, metrics = face_crop_quality(crop)
    assert accepted is False
    assert reason == "blurry"
    assert metrics["contrast"] > 8.0


def test_accepts_sharp_well_exposed_crop():
    crop = _Image(80, 80, "checker")
    accepted, reason, metrics = face_crop_quality(crop)
    assert accepted is True
    assert reason == "ok"
    assert metrics["sharpness"] > 2.0
