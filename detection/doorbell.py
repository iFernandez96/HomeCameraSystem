"""Python 3.6-compatible physical doorbell debounce core."""


class DebouncedButton(object):
    def __init__(self, debounce_s=0.05, refractory_s=1.0):
        self.debounce_s = float(debounce_s)
        self.refractory_s = float(refractory_s)
        self._candidate_since = None
        self._latched = False
        self._last_emit = -1e30

    def update(self, pressed, now):
        if not pressed:
            self._candidate_since = None
            self._latched = False
            return False
        if self._latched:
            return False
        if self._candidate_since is None:
            self._candidate_since = now
            return False
        if now - self._candidate_since < self.debounce_s:
            return False
        self._latched = True
        if now - self._last_emit < self.refractory_s:
            return False
        self._last_emit = now
        return True
