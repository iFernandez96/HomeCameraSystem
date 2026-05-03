"""Unit tests for `_meminfo`.

The /proc/meminfo parser is shared by /api/status and (transitively)
by the LiveStats memory pill that color-codes ≥75 % yellow / ≥90 %
red. A regression in the kB→MB math or in the MemAvailable lookup
would either misreport free memory or silently drop the metric to
None. Both fail subtly on a healthy host. Pin the contract here.
"""
from pathlib import Path

from app.main import _meminfo


# Realistic-ish /proc/meminfo from a Jetson Nano 2GB. Trimmed to the
# fields we care about plus a couple of decoys so the parser has to
# pick the right keys, not just take the first/last.
SAMPLE_MEMINFO = """\
MemTotal:        2027240 kB
MemFree:          850000 kB
MemAvailable:     192268 kB
Buffers:           50000 kB
Cached:           700000 kB
SwapCached:            0 kB
Active:           400000 kB
Inactive:         300000 kB
SwapTotal:       5207916 kB
SwapFree:        4841256 kB
"""


def _write_meminfo(path: Path, content: str) -> None:
    path.write_text(content)


def test_parses_jetson_meminfo(tmp_path):
    f = tmp_path / "meminfo"
    _write_meminfo(f, SAMPLE_MEMINFO)
    used_mb, total_mb = _meminfo(path=str(f))
    # MemAvailable=192268 kB, MemTotal=2027240 kB.
    # used_kb = 2027240 - 192268 = 1834972 → 1834972 // 1024 = 1791 MB.
    # total_mb = 2027240 // 1024 = 1979 MB.
    assert used_mb == 1791
    assert total_mb == 1979


def test_returns_none_when_file_missing(tmp_path):
    used, total = _meminfo(path=str(tmp_path / "no-such-file"))
    assert used is None
    assert total is None


def test_returns_none_when_memavailable_missing(tmp_path):
    f = tmp_path / "meminfo"
    # Older kernels (pre-3.14) lack MemAvailable. We don't try to
    # synthesize it; just bail to None.
    _write_meminfo(f, "MemTotal:        2027240 kB\n")
    used, total = _meminfo(path=str(f))
    assert used is None
    assert total is None


def test_returns_none_when_memtotal_missing(tmp_path):
    f = tmp_path / "meminfo"
    _write_meminfo(f, "MemAvailable:     192268 kB\n")
    used, total = _meminfo(path=str(f))
    assert used is None
    assert total is None


def test_returns_none_on_garbage_value(tmp_path):
    f = tmp_path / "meminfo"
    # First line has a non-numeric "kB" value — int() raises and the
    # whole read returns (None, None). We deliberately don't try to
    # skip-and-continue: a corrupt /proc/meminfo is severe enough to
    # warrant flat-out None rather than a half-populated reading.
    _write_meminfo(f, "MemTotal:        not-a-number kB\n")
    used, total = _meminfo(path=str(f))
    assert used is None
    assert total is None


def test_picks_correct_keys_amid_decoys(tmp_path):
    # MemFree appears before MemAvailable; the parser must use the
    # named keys, not positional ones. Same for MemTotal which comes
    # before SwapTotal.
    f = tmp_path / "meminfo"
    _write_meminfo(f, SAMPLE_MEMINFO)
    used_mb, total_mb = _meminfo(path=str(f))
    # If the parser used MemFree (850000) instead of MemAvailable
    # (192268), used would compute differently.
    assert used_mb != (2027240 - 850000) // 1024  # would be 1149
    # And if it used SwapTotal (5207916) instead of MemTotal:
    assert total_mb != 5207916 // 1024  # would be 5085
