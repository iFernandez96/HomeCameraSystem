"""Prometheus /metrics endpoint (iter-189, Feature #11).

Hand-written exposition-format renderer rather than a
`prometheus_client` dependency:

- The format is trivially simple (one ``# HELP`` + ``# TYPE`` +
  value line per metric, see
  https://prometheus.io/docs/instrumenting/exposition_formats/).
- We expose ~13 gauges + counters; the abstractions a library
  provides aren't load-bearing at this scale.
- Avoids pulling a 1-2 MB pip dep onto the Jetson container for
  what's effectively a string concat.

The route is mounted at the **app root** (`/metrics`), NOT under
`/api/*`, so the iter-184 auth gate doesn't apply. Prometheus
scrapers don't speak browser cookies; they're typically
IP-allowlisted or run on the same host. Operator-side fronting
(Tailscale / Caddy / firewall rule) is the right tier for
exposure control here, mirroring the Charter's stance on
``/api/_internal/*``.

The handler reads from the same in-memory state ``/api/status``
exposes, so the two endpoints stay consistent without a second
source of truth. Probes (`_cpu_temp` etc.) are imported lazily
from ``app.main`` to dodge a circular import at module-load
time — routes are imported BY ``main.py``, so direct top-level
imports the other direction would deadlock.
"""
from __future__ import annotations

import time

from fastapi import APIRouter
from fastapi.responses import PlainTextResponse


router = APIRouter()


def _line(
    name: str,
    value: float | int | None,
    help_text: str,
    mtype: str = "gauge",
) -> str:
    """Render one Prometheus metric exposition block, or empty
    string when ``value`` is None (probe unavailable on this
    platform — silently skip rather than emitting NaN, which
    Prometheus treats as a parse error)."""
    if value is None:
        return ""
    # Prometheus accepts integer or float — int values render as
    # `42` (no `.0`), floats as their str() form. Keep it simple.
    return (
        "# HELP {name} {help}\n"
        "# TYPE {name} {mtype}\n"
        "{name} {value}\n"
    ).format(name=name, help=help_text, mtype=mtype, value=value)


@router.get("/metrics", response_class=PlainTextResponse)
async def metrics_prom() -> str:
    # Lazy imports to avoid the circular `app.main → app.routes →
    # app.routes.metrics_prom → app.main` chain at module load.
    from ..main import (
        START_TIME,
        _cpu_freq_pct,
        _cpu_temp,
        _disk_free_gb,
        _gpu_temp,
        _meminfo,
    )
    from ..services.camera import camera_service
    from ..config import settings
    from ..services.detection import detection_service
    from ..services.health import worker_health
    from ..services.push_service import push_service
    from ..services.recording_assurance import status as recording_assurance_status

    used_mb, total_mb = _meminfo()
    worker_alive, _last_seen_s, worker_metrics = worker_health.snapshot()

    parts: list[str] = []

    # Liveness — always present, 0/1 gauges so they render even
    # when the worker is dead (which is itself useful information).
    parts.append(_line(
        "homecam_worker_alive",
        1 if worker_alive else 0,
        "Whether the host detection worker has heartbeat'd in the last 30s",
    ))
    parts.append(_line(
        "homecam_detection_active",
        1 if detection_service.active else 0,
        "Whether detection routing is active (UI Detect toggle)",
    ))

    # Thermal + governor.
    parts.append(_line(
        "homecam_cpu_temp_celsius",
        _cpu_temp(),
        "CPU thermal zone temperature in Celsius",
    ))
    parts.append(_line(
        "homecam_gpu_temp_celsius",
        _gpu_temp(),
        "GPU (GPU-therm) thermal zone temperature in Celsius",
    ))
    parts.append(_line(
        "homecam_cpu_freq_pct",
        _cpu_freq_pct(),
        "CPU governor max-freq as percent of cpuinfo_max_freq (100 = no thermal cap)",
    ))

    # Memory.
    parts.append(_line(
        "homecam_memory_used_mb", used_mb, "Used memory in MB",
    ))
    parts.append(_line(
        "homecam_memory_total_mb", total_mb, "Total memory in MB",
    ))
    parts.append(_line(
        "homecam_disk_free_gb",
        _disk_free_gb(str(settings.recordings_dir)),
        "Free disk space on the recording filesystem in GB",
    ))
    parts.append(_line(
        "homecam_system_disk_free_gb",
        _disk_free_gb("/"),
        "Free disk space on the Jetson root filesystem in GB",
    ))

    # Camera + push.
    parts.append(_line(
        "homecam_camera_fps",
        round(camera_service.fps, 2),
        "Server camera-service measured FPS",
    ))
    parts.append(_line(
        "homecam_push_subs",
        len(push_service.subs),
        "Number of registered Web Push subscriptions",
    ))
    parts.append(_line(
        "homecam_server_uptime_seconds",
        round(time.time() - START_TIME, 1),
        "Server process uptime in seconds",
    ))

    assurance = recording_assurance_status()
    if assurance["checked_at"] is not None:
        parts.append(_line(
            "homecam_recording_canary_ok",
            1 if assurance["state"] == "ok" else 0,
            "Whether the latest RTSP recording sample fully decoded and cleaned",
        ))
        parts.append(_line(
            "homecam_recording_canary_checked_age_seconds",
            assurance["age_s"],
            "Seconds since the most recent end-to-end recording check",
        ))
    storage = assurance.get("storage")
    if isinstance(storage, dict):
        parts.append(_line(
            "homecam_recording_storage_writable",
            1 if storage.get("writable") and storage.get("read_only") is not True else 0,
            "Whether the recording filesystem accepted and fsynced a test write",
        ))
        parts.append(_line(
            "homecam_recording_storage_write_probe_ms",
            storage.get("write_probe_ms"),
            "Fsync latency of the recording filesystem test write in milliseconds",
        ))
        smart = storage.get("smart_status")
        if smart in ("healthy", "failed"):
            parts.append(_line(
                "homecam_recording_drive_smart_healthy",
                1 if smart == "healthy" else 0,
                "SMART overall-health result when exposed by the USB storage bridge",
            ))
    event_clip = assurance.get("event_clip")
    if isinstance(event_clip, dict) and event_clip.get("state") != "none":
        parts.append(_line(
            "homecam_recent_event_clip_playable",
            1 if event_clip.get("state") == "playable" else 0,
            "Whether the most recently sampled real event clip fully decoded",
        ))
        parts.append(_line(
            "homecam_recent_event_clip_check_ms",
            event_clip.get("elapsed_ms"),
            "Wall-clock time spent fully decoding the sampled real event clip",
        ))

    # Worker — gauges (fps, infer_ms_*) are gated on `worker_alive`
    # because a stale value misrepresents current state. Counters
    # (`*_total`) emit unconditionally with the last-known value
    # whenever `worker_metrics` exists — Prometheus' rate() handles
    # the flat-line correctly, and the alternative (counters
    # disappearing when the worker dies) blanks the rate graph
    # exactly when the operator most needs it (iter-302,
    # systems-engineering-auditor B2).
    if worker_metrics:
        wm = worker_metrics
        if worker_alive:
            parts.append(_line(
                "homecam_worker_fps", wm.get("fps"),
                "Worker steady-state FPS (frames captured per second)",
            ))
            parts.append(_line(
                "homecam_worker_infer_ms_recent", wm.get("infer_ms_recent"),
                "Wall-clock latency of the most recent net.Detect() in ms",
            ))
            parts.append(_line(
                "homecam_worker_infer_ms_p95", wm.get("infer_ms_p95"),
                "95th-percentile inference latency over the last ~20 calls",
            ))
            parts.append(_line(
                "homecam_worker_thumb_ms_recent", wm.get("thumb_ms_recent"),
                "Wall-clock latency of the most recent save_thumb() in ms (iter-187)",
            ))
            parts.append(_line(
                "homecam_worker_uptime_seconds", wm.get("uptime_s"),
                "Worker process uptime in seconds",
            ))
            parts.append(_line(
                "homecam_camera_quality_status", wm.get("camera_quality_status"),
                "Image quality state: 0 warming, 1 clear, 2 blurred, 3 frozen",
            ))
            parts.append(_line(
                "homecam_camera_luma", wm.get("camera_luma"),
                "Mean luma of the low-cadence camera quality sample",
            ))
            parts.append(_line(
                "homecam_camera_sharpness", wm.get("camera_sharpness"),
                "Relative edge-energy score of the camera quality sample",
            ))
            power_sample_ts = wm.get("power_sample_ts", 0.0)
            power_age_s = (
                max(0.0, time.time() - power_sample_ts)
                if isinstance(power_sample_ts, (int, float)) and power_sample_ts > 0.0
                else None
            )
            if wm.get("power_sensor_status") == 1 and power_age_s is not None and power_age_s <= 15.0:
                parts.append(_line(
                    "homecam_input_power_watts", wm.get("power_watts"),
                    "Measured Jetson input power in watts",
                ))
                parts.append(_line(
                    "homecam_input_voltage_volts", wm.get("power_volts"),
                    "Measured Jetson input voltage in volts",
                ))
                parts.append(_line(
                    "homecam_input_current_amps", wm.get("power_amps"),
                    "Measured Jetson input current in amps",
                ))
        # Counters — Prometheus convention is *_total suffix. iter-302:
        # emit even when worker_alive is false so rate() graphs don't
        # blank at exactly the moment of failure.
        parts.append(_line(
            "homecam_worker_dropped_total", wm.get("dropped"),
            "Cumulative Capture() failures since worker start",
            "counter",
        ))
        parts.append(_line(
            "homecam_worker_mediamtx_restarts_total",
            wm.get("mediamtx_restarts"),
            "Cumulative MediaMTX watchdog kicks since worker start",
            "counter",
        ))
        # iter-302: nvargus-daemon escalation count. Non-zero means
        # the heavy-hammer recovery path was needed (mediamtx alone
        # couldn't unstick the libargus wedge). Each escalation
        # blanks consumers for ~5-10 s while the daemon restarts.
        parts.append(_line(
            "homecam_worker_argus_restarts_total",
            wm.get("argus_restarts"),
            "Cumulative nvargus-daemon escalations since worker start (iter-302)",
            "counter",
        ))
        parts.append(_line(
            "homecam_power_read_failures_total",
            wm.get("power_read_failures"),
            "Cumulative input-power sensor read failures since worker start",
            "counter",
        ))
        # iter-302: stream-stale signal. seconds since the worker's
        # most recent successful Capture(). Distinct from
        # `homecam_worker_alive`: the iter-300 outage had this
        # gauge climbing to 50,000+ while alive stayed at 1.
        # Alert: `homecam_worker_seconds_since_last_frame > 60`
        # is the canonical "video stalled but worker alive" signal.
        last_frame_ts = wm.get("last_frame_ts", 0.0)
        if last_frame_ts and last_frame_ts > 0.0:
            parts.append(_line(
                "homecam_worker_seconds_since_last_frame",
                round(time.time() - last_frame_ts, 1),
                "Wall-clock seconds since the worker's last successful Capture (iter-302)",
            ))

    return "".join(parts)
