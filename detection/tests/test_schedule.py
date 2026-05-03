"""Unit tests for `in_off_window`.

The detection schedule pause has subtle semantics — daytime windows,
overnight wraparound, malformed input, equal endpoints. None had
isolated coverage before this iter.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from schedule import in_off_window  # noqa: E402


def hm(h, m=0):
    """Minutes-since-midnight helper for readable test inputs."""
    return h * 60 + m


# --- unconfigured / malformed inputs ----------------------------------------


def test_returns_false_when_start_unset():
    assert in_off_window(None, "06:00", hm(3)) is False


def test_returns_false_when_end_unset():
    assert in_off_window("22:00", None, hm(3)) is False


def test_returns_false_when_both_unset():
    assert in_off_window(None, None, hm(12)) is False


def test_returns_false_when_string_empty():
    assert in_off_window("", "06:00", hm(3)) is False


def test_returns_false_on_malformed_start():
    assert in_off_window("not-a-time", "06:00", hm(3)) is False


def test_returns_false_on_malformed_end():
    assert in_off_window("22:00", "garbage", hm(3)) is False


# --- equal endpoints --------------------------------------------------------


def test_equal_endpoints_is_empty_window():
    # Same start/end could mean "always" or "never". We chose "never"
    # because the UI implies that — and it matches the user's likely
    # mental model when they accidentally typed the same time twice.
    assert in_off_window("22:00", "22:00", hm(12)) is False
    assert in_off_window("22:00", "22:00", hm(22)) is False


# --- normal day window (start < end) ----------------------------------------


def test_inside_normal_window():
    # 09:00 - 17:00, current 12:30
    assert in_off_window("09:00", "17:00", hm(12, 30)) is True


def test_at_start_boundary_inclusive():
    # The window is half-open: start inclusive, end exclusive.
    assert in_off_window("09:00", "17:00", hm(9)) is True


def test_at_end_boundary_exclusive():
    assert in_off_window("09:00", "17:00", hm(17)) is False


def test_just_before_window():
    assert in_off_window("09:00", "17:00", hm(8, 59)) is False


def test_after_window():
    assert in_off_window("09:00", "17:00", hm(20)) is False


# --- overnight wraparound (start > end) -------------------------------------


def test_overnight_window_during_evening():
    # 22:00 - 06:00, current 23:00 — inside the late-evening half.
    assert in_off_window("22:00", "06:00", hm(23)) is True


def test_overnight_window_at_midnight():
    # The wrap point should still be inside the window.
    assert in_off_window("22:00", "06:00", hm(0)) is True


def test_overnight_window_during_early_morning():
    # 22:00 - 06:00, current 04:30 — inside the morning half.
    assert in_off_window("22:00", "06:00", hm(4, 30)) is True


def test_overnight_window_at_evening_start_boundary():
    # 22:00 inclusive.
    assert in_off_window("22:00", "06:00", hm(22)) is True


def test_overnight_window_at_morning_end_boundary():
    # 06:00 exclusive — same half-open semantics as the day case.
    assert in_off_window("22:00", "06:00", hm(6)) is False


def test_overnight_window_outside_during_afternoon():
    assert in_off_window("22:00", "06:00", hm(15)) is False


# --- HH:MM minute precision -------------------------------------------------


def test_minute_precision_inside():
    assert in_off_window("22:30", "06:15", hm(22, 30)) is True


def test_minute_precision_outside():
    assert in_off_window("22:30", "06:15", hm(22, 29)) is False
