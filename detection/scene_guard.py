"""Pure Python 3.6-compatible tamper/scene-change state machine."""


class SceneGuard(object):
    def __init__(self, consecutive=3, dark_luma=8.0, flat_stddev=2.0,
                 moved_difference=45.0):
        self.consecutive = int(consecutive)
        self.dark_luma = float(dark_luma)
        self.flat_stddev = float(flat_stddev)
        self.moved_difference = float(moved_difference)
        self._kind = None
        self._count = 0
        self._announced = None

    def observe(self, mean_luma, stddev_luma, difference):
        kind = None
        if mean_luma <= self.dark_luma or stddev_luma <= self.flat_stddev:
            kind = "camera_covered"
        elif difference is not None and difference >= self.moved_difference:
            kind = "camera_moved"

        if kind != self._kind:
            self._kind = kind
            self._count = 1 if kind else 0
        elif kind:
            self._count += 1

        if kind is None:
            self._announced = None
            return None
        if self._count >= self.consecutive and self._announced != kind:
            self._announced = kind
            return kind
        return None

    def should_update_reference(self, mean_luma, stddev_luma, difference,
                                emitted):
        """Whether the caller may replace its held scene reference."""
        covered = mean_luma <= self.dark_luma or stddev_luma <= self.flat_stddev
        if covered:
            return False
        if emitted == "camera_moved":
            return True
        if difference is None:
            return True
        # A possible one-time displacement must be compared against the same
        # held reference on the next sample; updating here would erase it.
        return difference < self.moved_difference

    def suspend(self):
        """Clear candidates across an intentional off/privacy interval."""
        self._kind = None
        self._count = 0
        self._announced = None
