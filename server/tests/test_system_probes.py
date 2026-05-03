"""Unit tests for `_load_avg` and `_disk_free_gb` — the last two
sysprobe helpers that lacked isolated coverage. Together with
iter-58/59/60 they round out the system-probe test set.
"""
from pathlib import Path

from app.main import _disk_free_gb, _load_avg


# --- _load_avg ---------------------------------------------------------------


def test_load_avg_parses_typical_proc_loadavg(tmp_path):
    f = tmp_path / "loadavg"
    # /proc/loadavg format: "1m 5m 15m running/total lastpid"
    # Real Jetson reading; only the first three matter.
    f.write_text("0.42 0.63 0.93 1/247 31415\n")
    assert _load_avg(path=str(f)) == [0.42, 0.63, 0.93]


def test_load_avg_returns_none_when_file_missing(tmp_path):
    assert _load_avg(path=str(tmp_path / "no-such-file")) is None


def test_load_avg_returns_none_on_truncated_file(tmp_path):
    f = tmp_path / "loadavg"
    # Only two values — IndexError when we try parts[2].
    f.write_text("0.5 0.6\n")
    assert _load_avg(path=str(f)) is None


def test_load_avg_returns_none_on_garbage(tmp_path):
    f = tmp_path / "loadavg"
    # Non-numeric — ValueError on float().
    f.write_text("not numbers here\n")
    assert _load_avg(path=str(f)) is None


def test_load_avg_handles_extra_trailing_fields(tmp_path):
    # The split() doesn't care about extras after the first 3;
    # this is the typical kernel output shape.
    f = tmp_path / "loadavg"
    f.write_text("1.00 2.00 3.00 4/567 89012\n")
    assert _load_avg(path=str(f)) == [1.0, 2.0, 3.0]


# --- _disk_free_gb -----------------------------------------------------------


def test_disk_free_returns_a_number_for_existing_path(tmp_path):
    # tmp_path is a real filesystem location (the host's /tmp or the
    # pytest tmpdir root). The function should return a non-negative
    # number rather than None.
    result = _disk_free_gb(str(tmp_path))
    assert result is not None
    assert isinstance(result, float)
    assert result >= 0


def test_disk_free_returns_none_for_missing_path(tmp_path):
    nope = tmp_path / "no-such-dir"
    assert _disk_free_gb(str(nope)) is None


def test_disk_free_rounds_to_one_decimal(tmp_path):
    # Check formatting: `round(x, 1)` always gives a value that looks
    # like a one-decimal float when serialized.
    result = _disk_free_gb(str(tmp_path))
    # `round(x, 1)` may legitimately produce values like 28.0; ensure
    # the rounding doesn't wreck precision (e.g. truncate to int).
    assert result == round(result, 1)
