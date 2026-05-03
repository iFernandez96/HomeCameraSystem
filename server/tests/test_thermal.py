"""Unit tests for `_read_thermal_zone_by_name`.

The helper is the cause-side throttle indicator on the Jetson —
finding the right thermal zone by name rather than by an unstable
index. Tests build a synthetic `/sys/class/thermal/` tree under
tmp_path so the lookup logic can be validated without depending on
the host actually having Tegra zones.
"""
from pathlib import Path

from app.main import _read_thermal_zone_by_name


def _write_zone(base: Path, idx: int, name: str, milli_c: int) -> None:
    zone = base / f"thermal_zone{idx}"
    zone.mkdir(parents=True)
    (zone / "type").write_text(f"{name}\n")
    (zone / "temp").write_text(f"{milli_c}\n")


def test_returns_none_when_no_zones(tmp_path):
    assert _read_thermal_zone_by_name("GPU-therm", base=str(tmp_path)) is None


def test_finds_zone_at_arbitrary_index(tmp_path):
    # Tegra exposes GPU-therm at zone2 — the by-name lookup should still
    # work whether it's at 0, 2, or 7.
    _write_zone(tmp_path, 2, "GPU-therm", 46500)
    assert _read_thermal_zone_by_name("GPU-therm", base=str(tmp_path)) == 46.5


def test_returns_none_for_missing_name(tmp_path):
    _write_zone(tmp_path, 0, "AO-therm", 56000)
    _write_zone(tmp_path, 1, "CPU-therm", 48000)
    assert _read_thermal_zone_by_name("GPU-therm", base=str(tmp_path)) is None


def test_picks_first_match_when_duplicate_names(tmp_path):
    # Pathological (kernels don't usually do this) — but if the same
    # type is exposed at multiple indices, we pick the lowest-index
    # match. Fixed behaviour so a future kernel quirk doesn't surprise
    # us.
    _write_zone(tmp_path, 1, "GPU-therm", 50000)
    _write_zone(tmp_path, 5, "GPU-therm", 60000)
    assert _read_thermal_zone_by_name("GPU-therm", base=str(tmp_path)) == 50.0


def test_skips_zones_without_type_or_temp(tmp_path):
    # A partial/half-populated zone shouldn't crash the scan — keep
    # walking to the next index. We also drop a properly-formed zone
    # later so we can verify we didn't bail early.
    (tmp_path / "thermal_zone0").mkdir()  # missing both files
    half = tmp_path / "thermal_zone1"
    half.mkdir()
    (half / "type").write_text("GPU-therm\n")  # has type, no temp
    _write_zone(tmp_path, 2, "GPU-therm", 46500)
    assert _read_thermal_zone_by_name("GPU-therm", base=str(tmp_path)) == 46.5


def test_handles_trailing_newline_and_whitespace(tmp_path):
    # The kernel writes `temp` and `type` with a trailing newline; the
    # helper has to strip both. Belt-and-braces — also handle leading
    # spaces in case some kernel exposes them.
    zone = tmp_path / "thermal_zone3"
    zone.mkdir()
    (zone / "type").write_text("  GPU-therm\n")
    (zone / "temp").write_text("  46500  \n")
    assert _read_thermal_zone_by_name("GPU-therm", base=str(tmp_path)) == 46.5
