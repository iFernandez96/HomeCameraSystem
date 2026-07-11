import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from power_monitor import PowerMonitor, SensorUnavailable  # noqa: E402


def _write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(str(value))


def test_given_single_channel_ina226_when_sampled_then_reports_real_units(tmp_path):
    # arrange
    root = tmp_path / "sys" / "class" / "hwmon" / "hwmon0"
    _write(root / "name", "ina226\n")
    _write(root / "in1_input", "5030\n")
    _write(root / "curr1_input", "1250\n")
    monitor = PowerMonitor(sysfs_root=str(tmp_path / "sys"), clock=lambda: 123.0)

    # act
    sample = monitor.sample()

    # assert
    assert sample == {
        "volts": 5.03,
        "amps": 1.25,
        "watts": pytest.approx(6.2875),
        "sample_ts": 123.0,
    }


def test_given_calibrated_power_register_then_uses_it_instead_of_recomputing(tmp_path):
    # arrange
    root = tmp_path / "sys" / "class" / "hwmon" / "hwmon0"
    _write(root / "name", "ina226")
    _write(root / "in1_input", "5000")
    _write(root / "curr1_input", "1200")
    _write(root / "power1_input", "6150000")
    monitor = PowerMonitor(sysfs_root=str(tmp_path / "sys"))

    # act
    sample = monitor.sample()

    # assert — 5V*1.2A is 6W, but the sensor's calibrated register is 6.15W.
    assert sample["watts"] == pytest.approx(6.15)


def test_given_unrelated_hwmon_when_sampled_then_does_not_invent_power(tmp_path):
    # arrange
    root = tmp_path / "sys" / "class" / "hwmon" / "hwmon0"
    _write(root / "name", "cpu_thermal")
    _write(root / "in1_input", "5000")
    _write(root / "curr1_input", "1000")
    monitor = PowerMonitor(sysfs_root=str(tmp_path / "sys"))

    # act / assert
    with pytest.raises(SensorUnavailable, match="no supported"):
        monitor.sample()


def test_given_unlabelled_multi_channel_sensor_then_refuses_to_guess_rail(tmp_path):
    # arrange
    root = tmp_path / "sys" / "class" / "hwmon" / "hwmon0"
    _write(root / "name", "ina3221")
    for channel in (1, 2):
        _write(root / ("in%d_input" % channel), "5000")
        _write(root / ("curr%d_input" % channel), "1000")
    monitor = PowerMonitor(sysfs_root=str(tmp_path / "sys"))

    # act / assert
    with pytest.raises(SensorUnavailable, match="unambiguous"):
        monitor.sample()


def test_given_labelled_input_rail_then_selects_it_from_multiple_channels(tmp_path):
    # arrange
    root = tmp_path / "sys" / "class" / "hwmon" / "hwmon0"
    _write(root / "name", "ina3221")
    for channel in (1, 2):
        _write(root / ("in%d_input" % channel), 5000 + channel)
        _write(root / ("curr%d_input" % channel), 1000)
    _write(root / "in1_label", "GPU")
    _write(root / "in2_label", "VDD_IN")
    monitor = PowerMonitor(sysfs_root=str(tmp_path / "sys"))

    # act
    sample = monitor.sample()

    # assert
    assert sample["volts"] == pytest.approx(5.002)
    assert sample["watts"] == pytest.approx(5.002)


def test_given_operator_pinned_root_then_name_file_is_not_required(tmp_path):
    # arrange
    root = tmp_path / "external-meter"
    _write(root / "in1_input", "5100")
    _write(root / "power1_input", "7650000")
    monitor = PowerMonitor(sensor_root=str(root), clock=lambda: 44.0)

    # act
    sample = monitor.sample()

    # assert
    assert sample["volts"] == pytest.approx(5.1)
    assert sample["watts"] == pytest.approx(7.65)
    assert sample["amps"] == pytest.approx(1.5)
