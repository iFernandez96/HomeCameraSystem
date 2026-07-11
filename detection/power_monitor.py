"""Truthful Jetson input-power sampling from Linux INA2xx sysfs nodes.

The Nano 2GB has no onboard INA3221, so this module deliberately reports
``unavailable`` until an external INA219/INA226-compatible monitor is
installed and exposed by the kernel.  It never estimates watts from CPU load,
temperature, or nvpmodel.

Must stay Python 3.6 compatible: this runs in the host detection process.
"""
import glob
import logging
import os
import threading
import time


log = logging.getLogger(__name__)

POWER_UNAVAILABLE = 0
POWER_LIVE = 1
POWER_ERROR = 2

_SUPPORTED_HWMON_NAMES = frozenset(
    ("ina219", "ina226", "ina230", "ina231", "ina3221")
)
_INPUT_LABELS = frozenset(("vdd_in", "pom_5v_in", "vin", "input"))


class SensorUnavailable(Exception):
    """No approved input-power monitor is currently exposed by sysfs."""


def _read_text(path):
    with open(path, "r") as handle:
        return handle.read().strip()


def _read_number(path):
    value = float(_read_text(path))
    if value < 0.0:
        raise ValueError("negative electrical reading")
    return value


def _normal_label(value):
    return value.strip().lower().replace("-", "_").replace(" ", "_")


class PowerMonitor(object):
    """Discover and sample a supported INA2xx input-power sensor.

    ``sensor_root`` may pin an operator-provisioned hwmon directory.  Without
    it, approved Linux hwmon nodes are discovered by their driver ``name``.
    The legacy Jetson INA3221 IIO layout is also supported for Nano variants
    that actually include that monitor.
    """

    def __init__(self, sensor_root=None, sysfs_root="/sys", clock=time.time):
        self.sensor_root = sensor_root
        self.sysfs_root = sysfs_root
        self.clock = clock

    def _hwmon_roots(self):
        if self.sensor_root:
            return [self.sensor_root]
        pattern = os.path.join(self.sysfs_root, "class", "hwmon", "hwmon*")
        roots = []
        for root in sorted(glob.glob(pattern)):
            try:
                name = _normal_label(_read_text(os.path.join(root, "name")))
            except (IOError, OSError, ValueError):
                continue
            if name in _SUPPORTED_HWMON_NAMES:
                roots.append(root)
        return roots

    def _select_hwmon_channel(self, root):
        channels = []
        for voltage_path in sorted(glob.glob(os.path.join(root, "in*_input"))):
            base = os.path.basename(voltage_path)
            channel = base[len("in"):-len("_input")]
            if not channel.isdigit():
                continue
            current_path = os.path.join(root, "curr%s_input" % channel)
            power_path = os.path.join(root, "power%s_input" % channel)
            if not os.path.exists(current_path) and not os.path.exists(power_path):
                continue
            label_path = os.path.join(root, "in%s_label" % channel)
            label = ""
            try:
                label = _normal_label(_read_text(label_path))
            except (IOError, OSError, ValueError):
                pass
            channels.append((channel, label, voltage_path, current_path, power_path))

        if not channels:
            return None
        labelled = [item for item in channels if item[1] in _INPUT_LABELS]
        if labelled:
            return labelled[0]
        # A single-channel INA219/INA226 is unambiguous. Refuse to guess which
        # rail is board input on an unlabeled multi-channel monitor.
        if len(channels) == 1:
            return channels[0]
        return None

    def _sample_hwmon(self, root):
        channel = self._select_hwmon_channel(root)
        if channel is None:
            raise SensorUnavailable("supported sensor has no unambiguous input rail")
        _number, _label, voltage_path, current_path, power_path = channel
        # Linux hwmon ABI: voltage is millivolts, current is milliamps,
        # and power is microwatts. Prefer the monitor's calibrated power
        # register when exported; multiply V*I only as a fallback.
        volts = _read_number(voltage_path) / 1000.0
        if os.path.exists(power_path):
            watts = _read_number(power_path) / 1000000.0
        else:
            watts = None
        if os.path.exists(current_path):
            amps = _read_number(current_path) / 1000.0
        else:
            amps = watts / volts if volts > 0.0 else 0.0
        if watts is None:
            watts = volts * amps
        return {
            "volts": volts,
            "amps": amps,
            "watts": watts,
            "sample_ts": self.clock(),
        }

    def _legacy_roots(self):
        pattern = os.path.join(
            self.sysfs_root,
            "bus", "i2c", "drivers", "ina3221x", "*", "iio:device*",
        )
        return sorted(glob.glob(pattern))

    def _sample_legacy(self, root):
        for channel in range(3):
            rail_path = os.path.join(root, "rail_name_%d" % channel)
            try:
                rail = _normal_label(_read_text(rail_path))
            except (IOError, OSError, ValueError):
                continue
            if rail not in _INPUT_LABELS:
                continue
            volts = _read_number(
                os.path.join(root, "in_voltage%d_input" % channel)
            ) / 1000.0
            amps = _read_number(
                os.path.join(root, "in_current%d_input" % channel)
            ) / 1000.0
            return {
                "volts": volts,
                "amps": amps,
                "watts": volts * amps,
                "sample_ts": self.clock(),
            }
        raise SensorUnavailable("INA3221 has no labelled input rail")

    def sample(self):
        unavailable_reason = "no supported INA2xx input-power sensor"
        for root in self._hwmon_roots():
            try:
                return self._sample_hwmon(root)
            except SensorUnavailable as exc:
                unavailable_reason = str(exc)
        if not self.sensor_root:
            for root in self._legacy_roots():
                try:
                    return self._sample_legacy(root)
                except SensorUnavailable as exc:
                    unavailable_reason = str(exc)
        raise SensorUnavailable(unavailable_reason)


def start_power_sampler(metrics, monitor=None, interval_s=2.0):
    """Continuously update flat heartbeat metrics and auto-retry forever."""
    monitor = monitor or PowerMonitor(
        sensor_root=os.getenv("DETECT_POWER_SENSOR_ROOT") or None,
    )

    def loop():
        last_status = None
        while True:
            try:
                sample = monitor.sample()
                metrics.power_volts = sample["volts"]
                metrics.power_amps = sample["amps"]
                metrics.power_watts = sample["watts"]
                metrics.power_sample_ts = sample["sample_ts"]
                metrics.power_sensor_status = POWER_LIVE
                current_status = POWER_LIVE
            except SensorUnavailable as exc:
                metrics.power_sensor_status = POWER_UNAVAILABLE
                current_status = POWER_UNAVAILABLE
                if current_status != last_status:
                    log.info("power monitor unavailable: %s", exc)
            except (IOError, OSError, ValueError) as exc:
                metrics.power_sensor_status = POWER_ERROR
                metrics.power_read_failures += 1
                current_status = POWER_ERROR
                if current_status != last_status:
                    log.warning(
                        "power monitor read failed; retrying automatically: %s: %s",
                        type(exc).__name__, exc,
                    )
            if current_status == POWER_LIVE and last_status != POWER_LIVE:
                log.info("power monitor is reporting live input readings")
            last_status = current_status
            time.sleep(interval_s)

    thread = threading.Thread(target=loop, name="power-sampler")
    thread.daemon = True
    thread.start()
    return thread
