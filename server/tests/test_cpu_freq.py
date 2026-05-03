"""Unit tests for `_cpu_freq_pct`.

The cpufreq ratio is the cause-side throttle signal that drives the
LiveStats `⚠` warning and the Settings `CPU clock` row. The function
divides one sysfs file by another — small enough that nothing should
go wrong, but the failure modes (missing files, garbage data,
zero-divisor) all return `None` and we want to be sure that
contract holds.
"""
from pathlib import Path

from app.main import _cpu_freq_pct


def _write_cpufreq(base: Path, scaled: str, mx: str) -> None:
    base.mkdir(parents=True, exist_ok=True)
    (base / "scaling_max_freq").write_text(scaled)
    (base / "cpuinfo_max_freq").write_text(mx)


def test_returns_100_when_unconstrained(tmp_path):
    _write_cpufreq(tmp_path, "1479000\n", "1479000\n")
    assert _cpu_freq_pct(base=str(tmp_path)) == 100.0


def test_returns_half_when_clamped_to_half(tmp_path):
    # Tegra's mode-1 (5 W) cap pulls scaling_max_freq to ~918 MHz on a
    # 1479 MHz max — that's 62.1 %. Round-trip a similar half-rate
    # config and check the math.
    _write_cpufreq(tmp_path, "739500", "1479000")
    assert _cpu_freq_pct(base=str(tmp_path)) == 50.0


def test_returns_none_when_files_missing(tmp_path):
    # Empty dir — neither file exists. Helper should swallow the
    # OSError and return None rather than raising.
    assert _cpu_freq_pct(base=str(tmp_path)) is None


def test_returns_none_when_max_is_zero(tmp_path):
    # Kernel bug or virtualised host: cpuinfo_max_freq=0 would make
    # the division NaN. The mx<=0 guard converts it to None.
    _write_cpufreq(tmp_path, "1000", "0")
    assert _cpu_freq_pct(base=str(tmp_path)) is None


def test_returns_none_on_garbage(tmp_path):
    _write_cpufreq(tmp_path, "not-a-number\n", "1479000\n")
    assert _cpu_freq_pct(base=str(tmp_path)) is None


def test_rounds_to_one_decimal(tmp_path):
    # 1234567 / 1479000 = 0.83472..., * 100 = 83.472... → 83.5.
    _write_cpufreq(tmp_path, "1234567", "1479000")
    assert _cpu_freq_pct(base=str(tmp_path)) == 83.5
