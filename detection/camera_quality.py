"""Low-cadence, Python 3.6-compatible camera quality state machine."""


class CameraQualityGuard(object):
    """Detect only sustained, high-confidence blur and frozen imagery."""

    CLEAR = 1
    BLURRED = 2
    FROZEN = 3

    def __init__(self, consecutive=6, baseline_samples=6,
                 blur_ratio=0.25, frozen_delta=0.03):
        self.consecutive = int(consecutive)
        self.baseline_samples = int(baseline_samples)
        self.blur_ratio = float(blur_ratio)
        self.frozen_delta = float(frozen_delta)
        self.baseline_sharpness = None
        self._baseline_count = 0
        self._candidate = None
        self._count = 0
        self.state = self.CLEAR

    def observe(self, sharpness, frame_delta):
        sharpness = max(0.0, float(sharpness))
        candidate = None
        if frame_delta is not None and float(frame_delta) <= self.frozen_delta:
            candidate = self.FROZEN
        elif (
                self.baseline_sharpness is not None
                and self._baseline_count >= self.baseline_samples
                and sharpness < self.baseline_sharpness * self.blur_ratio):
            candidate = self.BLURRED

        if candidate != self._candidate:
            self._candidate = candidate
            self._count = 1 if candidate is not None else 0
        elif candidate is not None:
            self._count += 1

        transition = None
        if candidate is not None and self._count >= self.consecutive:
            if self.state != candidate:
                self.state = candidate
                transition = (
                    "camera_frozen" if candidate == self.FROZEN
                    else "camera_blurred"
                )
        elif candidate is None:
            if self.state != self.CLEAR:
                self.state = self.CLEAR
                transition = "camera_quality_recovered"
            if self.baseline_sharpness is None:
                self.baseline_sharpness = sharpness
            else:
                self.baseline_sharpness = (
                    self.baseline_sharpness * 0.95 + sharpness * 0.05
                )
            self._baseline_count += 1
        return transition

    def suspend(self):
        self._candidate = None
        self._count = 0
        self.state = self.CLEAR
