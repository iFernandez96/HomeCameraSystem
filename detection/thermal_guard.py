"""Pause-equivalent detection downshift when the GPU runs hot.

Symmetric counterpart to `memory_guard.py`. iter-3's idle-gear keeps
the Nano at ~50 °C in normal operation; this is the safety net for
unusual ambient (poorly ventilated case, heatwave, dust on the
heatsink) where the GPU climbs past the thermal trip and the kernel
starts pulling `scaling_max_freq` down.

When triggered, detect.py forces the inference loop into idle gear
(1 fps) instead of active (5 fps) — slower-but-still-running so we
don't lose all coverage during a transient hot spell. Hysteresis
prevents flapping at the threshold.

Pure stdlib. Python-3.6 compatible (per the CLAUDE.md sharp edge).
"""
import logging

log = logging.getLogger(__name__)


def read_gpu_temp_c():
    """GPU thermal-zone reading in °C, or None if unavailable.

    Walks `/sys/class/thermal/thermal_zoneN` looking for the zone
    named `GPU-therm` (Tegra). Capped at 16 zones — typical SoCs
    expose 4-8. None on non-Tegra hosts (e.g. when run during
    development on a workstation)."""
    for i in range(16):
        type_path = "/sys/class/thermal/thermal_zone{}/type".format(i)
        try:
            with open(type_path) as f:
                if f.read().strip() != "GPU-therm":
                    continue
            with open("/sys/class/thermal/thermal_zone{}/temp".format(i)) as t:
                return int(t.read().strip()) / 1000.0
        except (OSError, ValueError):
            continue
    return None


class ThermalGuard:
    """Hysteretic thermal-pressure gate.

    Args:
        hot_c: temperature in °C above which we declare thermal
            pressure. Default 80 — Tegra's GPU thermal trip is
            around 87 °C, so 80 gives ~7 °C of warning before the
            kernel starts clamping clocks.
        cool_c: temperature we have to fall back below before we
            leave thermal mode. Must be < hot_c. Default 70 gives
            10 °C of hysteresis so a small variance at 80 doesn't
            flap the gear.
        check_every: how often the calling loop should call `step()`
            (frames). The guard itself doesn't sleep.

    Sticky in both directions: once `hot=True`, stays hot until a
    `step()` sees temp < cool_c. Once cool, stays cool until temp
    > hot_c.
    """

    def __init__(self, hot_c=80.0, cool_c=70.0, check_every=30):
        if cool_c > hot_c:
            raise ValueError("cool_c must be <= hot_c to prevent flapping")
        self.hot_c = hot_c
        self.cool_c = cool_c
        self.check_every = check_every
        self.hot = False
        self.last_temp_c = None

    def step(self, temp_c):
        """Update internal state from a fresh reading. None readings
        (e.g. /sys not available) leave state unchanged — fail-open:
        if we can't measure, don't spuriously throttle."""
        if temp_c is None:
            return self.hot
        self.last_temp_c = temp_c
        if self.hot:
            if temp_c < self.cool_c:
                log.warning(
                    "thermal_guard: cooled (%.1f °C, threshold %.1f)",
                    temp_c, self.cool_c,
                )
                self.hot = False
        else:
            if temp_c > self.hot_c:
                log.warning(
                    "thermal_guard: entering thermal mode (%.1f °C, threshold %.1f)",
                    temp_c, self.hot_c,
                )
                self.hot = True
        return self.hot
