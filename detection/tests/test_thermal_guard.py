"""Unit tests for ThermalGuard.

Pure stdlib — no /sys reads in the hot path — so these run on the
dev host without any Tegra dependencies.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest  # noqa: E402

from thermal_guard import ThermalGuard  # noqa: E402


def test_starts_cool():
    g = ThermalGuard(hot_c=80, cool_c=70)
    assert g.hot is False


def test_enters_hot_above_threshold():
    g = ThermalGuard(hot_c=80, cool_c=70)
    assert g.step(75) is False
    assert g.step(81) is True


def test_does_not_enter_hot_at_exactly_threshold():
    """The hot-entry condition is `temp_c > hot_c` (strict >). A
    reading exactly at the threshold doesn't trip — only one above
    does. Pin so a future refactor that flips `>` to `>=` (more
    eager) is observable. The recovery side already tests `step(70)
    stays hot` for the symmetric `< cool_c` rule."""
    g = ThermalGuard(hot_c=80, cool_c=70)
    assert g.step(80) is False  # exactly at threshold — not yet hot
    assert g.step(80.001) is True  # one micro above — hot


def test_stays_hot_inside_hysteresis_band():
    g = ThermalGuard(hot_c=80, cool_c=70)
    g.step(85)
    # Drops below hot_c but still above cool_c — stays hot.
    assert g.step(75) is True


def test_recovers_only_below_cool_threshold():
    g = ThermalGuard(hot_c=80, cool_c=70)
    g.step(85)
    assert g.step(70) is True  # exactly at threshold — still hot
    assert g.step(69) is False  # below cool_c — recovered
    assert g.step(75) is False  # mid-band, but already cool


def test_none_reading_is_fail_open():
    g = ThermalGuard(hot_c=80, cool_c=70)
    assert g.step(None) is False
    g.step(85)
    assert g.step(None) is True  # state unchanged from prior reading


def test_invalid_thresholds_rejected():
    with pytest.raises(ValueError):
        ThermalGuard(hot_c=70, cool_c=80)


def test_records_last_reading():
    g = ThermalGuard()
    g.step(55.5)
    assert g.last_temp_c == 55.5
    g.step(None)  # None doesn't overwrite
    assert g.last_temp_c == 55.5


def test_equal_thresholds_allowed():
    # Edge case: hot_c == cool_c is technically allowed (no
    # hysteresis band). Should still work, just flappy.
    g = ThermalGuard(hot_c=70, cool_c=70)
    assert g.step(75) is True
    assert g.step(70) is True   # not strictly below cool_c
    assert g.step(69) is False
