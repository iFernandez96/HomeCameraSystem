"""Unit tests for MemoryGuard.

The guard is pure stdlib — no jetson-inference, no /proc reads in the
hot path — so these tests run on the dev host.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest  # noqa: E402

from memory_guard import MemoryGuard  # noqa: E402


def test_starts_normal():
    g = MemoryGuard(low_mb=80, recover_mb=150)
    assert g.low is False


def test_enters_low_when_below_threshold():
    g = MemoryGuard(low_mb=80, recover_mb=150)
    assert g.step(100) is False
    assert g.step(60) is True


def test_does_not_enter_low_at_exactly_threshold():
    """The low-entry condition is `mem_avail_mb < low_mb` (strict <).
    A reading exactly at the threshold doesn't trip — only one below
    does. Symmetric to the iter-154 ThermalGuard boundary test, and
    matches the recovery side's already-pinned `step(149) stays low,
    step(150) recovers` rule."""
    g = MemoryGuard(low_mb=80, recover_mb=150)
    assert g.step(80) is False  # exactly at threshold — not yet low
    assert g.step(79) is True   # one below — low


def test_stays_low_inside_hysteresis_band():
    g = MemoryGuard(low_mb=80, recover_mb=150)
    g.step(60)
    # Memory bounces back above the low threshold but below the recover
    # threshold. Should NOT exit low-memory mode.
    assert g.step(120) is True


def test_recovers_only_when_above_recover_threshold():
    g = MemoryGuard(low_mb=80, recover_mb=150)
    g.step(60)
    assert g.step(149) is True
    assert g.step(150) is False
    # And stays normal after.
    assert g.step(200) is False


def test_none_reading_is_fail_open():
    g = MemoryGuard(low_mb=80, recover_mb=150)
    # Even when /proc/meminfo couldn't be read, never spuriously pause.
    assert g.step(None) is False
    g.step(60)
    assert g.step(None) is True  # state unchanged from prior reading


def test_invalid_thresholds_rejected():
    with pytest.raises(ValueError):
        MemoryGuard(low_mb=200, recover_mb=100)


def test_records_last_reading():
    g = MemoryGuard()
    g.step(120)
    assert g.last_mem_avail_mb == 120
    g.step(None)  # None doesn't overwrite the last good reading
    assert g.last_mem_avail_mb == 120
