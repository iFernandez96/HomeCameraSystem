"""Internal Prometheus /metrics endpoint (iter-189, PR-105).

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
`/api/*`, because Prometheus does not use browser sessions. PR-105 keeps it out
of the remote application surface with a source boundary instead: only
loopback and the fixed HomeCam Compose network may scrape. Uvicorn has already
resolved trusted proxy headers before this route sees ``request.client``;
remote Tailscale Serve clients therefore retain their tailnet address and get
the same 404 as an unknown public route.

The handler reads from the same in-memory state ``/api/status``
exposes, so the two endpoints stay consistent without a second
source of truth. Probes (`_cpu_temp` etc.) are imported lazily
from ``app.main`` to dodge a circular import at module-load
time — routes are imported BY ``main.py``, so direct top-level
imports the other direction would deadlock.
"""
from __future__ import annotations

import ipaddress
import logging
import time

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import PlainTextResponse

from ..log import RateLimitedLog
from ..services.internal_peer import normalize_ip


router = APIRouter()
log = logging.getLogger(__name__)


_INTERNAL_METRICS_NETWORKS = (
    ipaddress.ip_network("127.0.0.0/8"),
    ipaddress.ip_network("::1/128"),
    ipaddress.ip_network("172.30.0.0/24"),
)
_metrics_reject_log_gate = RateLimitedLog(60.0)


def _trusted_metrics_peer(host: str | None) -> bool:
    normalized = normalize_ip(host or "")
    if normalized is None:
        return False
    address = ipaddress.ip_address(normalized)
    return any(address in network for network in _INTERNAL_METRICS_NETWORKS)


def _metrics_peer_class(host: str | None) -> str:
    normalized = normalize_ip(host or "")
    if normalized is None:
        return "missing"
    address = ipaddress.ip_address(normalized)
    if address.is_loopback:
        return "loopback"
    if address in _INTERNAL_METRICS_NETWORKS[-1]:
        return "compose"
    return "remote"


def _require_internal_metrics(request: Request) -> None:
    host = request.client.host if request.client is not None else None
    if _trusted_metrics_peer(host):
        return
    if _metrics_reject_log_gate.should_log():
        log.warning(
            "metrics access rejected: method=%s route=%s source=%s",
            request.method,
            request.url.path,
            _metrics_peer_class(host),
        )
    # Match Starlette's unknown-route response so the public application
    # surface does not disclose whether observability is enabled.
    raise HTTPException(status_code=404, detail="Not Found")


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


@router.get(
    "/metrics/",
    response_class=PlainTextResponse,
    include_in_schema=False,
)
@router.get("/metrics", response_class=PlainTextResponse)
async def metrics_prom(request: Request) -> str:
    _require_internal_metrics(request)
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
    from ..services import operational_metrics, whep_probe_status

    used_mb, total_mb = _meminfo()
    worker_alive, _last_seen_s, worker_metrics = worker_health.snapshot()
    recording_free_gb = _disk_free_gb(str(settings.recordings_dir))
    system_free_gb = _disk_free_gb("/")

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
        recording_free_gb,
        "Free disk space on the recording filesystem in GB",
    ))
    parts.append(_line(
        "homecam_system_disk_free_gb",
        system_free_gb,
        "Free disk space on the Jetson root filesystem in GB",
    ))
    parts.append(_line(
        "homecam_recording_storage_probe_success",
        1 if recording_free_gb is not None else 0,
        "Whether the server can inspect the configured recording storage",
    ))
    parts.append(_line(
        "homecam_system_storage_probe_success",
        1 if system_free_gb is not None else 0,
        "Whether the server can inspect the Jetson root storage",
    ))

    # Persisted operations. Export numeric outcomes only: ledgers and backup
    # state contain filenames, digests, and reasons that must not become labels.
    backup = operational_metrics.backup_metrics(settings.backup_status_path)
    parts.append(_line(
        "homecam_backup_status_present",
        backup["status_present"],
        "Whether a valid encrypted-backup status record exists",
    ))
    parts.append(_line(
        "homecam_backup_last_attempt_success",
        backup.get("last_attempt_success"),
        "Whether the latest encrypted-backup attempt succeeded",
    ))
    parts.append(_line(
        "homecam_backup_last_success_timestamp_seconds",
        backup.get("last_success_timestamp"),
        "Unix timestamp of the latest successful encrypted backup",
    ))
    restore_success = operational_metrics.latest_restore_success(
        settings.backup_ledger_path
    )
    parts.append(_line(
        "homecam_restore_last_attempt_success",
        restore_success,
        "Whether the latest restore attempt succeeded",
    ))
    update_success = operational_metrics.latest_update_success(settings.ota_ledger_path)
    parts.append(_line(
        "homecam_update_last_attempt_success",
        update_success,
        "Whether the latest terminal update attempt applied successfully",
    ))
    supervisor = operational_metrics.supervisor_metrics(
        settings.recordings_dir / ".server-supervisor-state.json"
    )
    parts.append(_line(
        "homecam_server_supervisor_state_present",
        supervisor["state_present"],
        "Whether the host server-supervisor state file exists",
    ))
    parts.append(_line(
        "homecam_server_supervisor_state_valid",
        supervisor.get("state_valid"),
        "Whether the host server-supervisor state file is valid",
    ))
    parts.append(_line(
        "homecam_server_supervisor_latched",
        supervisor.get("latched"),
        "Whether server recovery stopped after exhausting its restart budget",
    ))
    parts.append(_line(
        "homecam_server_supervisor_restarts_in_window",
        supervisor.get("restarts_in_window"),
        "Server-only recovery actions during the supervisor ten-minute window",
    ))
    parts.append(_line(
        "homecam_server_supervisor_last_action_timestamp_seconds",
        supervisor.get("last_action_timestamp"),
        "Unix timestamp of the latest server-supervisor action",
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
            result = wm.get("whep_probe_result")
            parts.append(_line(
                "homecam_whep_probe_success",
                1 if result == "success" else 0,
                "Whether the latest Jetson-local WHEP probe received RTP",
            ))
            parts.append(_line(
                "homecam_whep_probe_ttff_ms", wm.get("whep_probe_ttff_ms"),
                "Latest Jetson-local WHEP time to first RTP in milliseconds",
            ))
            parts.append(_line(
                "homecam_whep_probe_last_ok_timestamp_seconds",
                wm.get("whep_probe_last_ok_ts"),
                "Unix timestamp of the latest successful local WHEP probe",
            ))
            parts.append(_line(
                "homecam_whep_probe_consecutive_failures",
                wm.get("whep_probe_consec_fails"),
                "Maximum consecutive local WHEP failures across probe rungs",
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
        parts.append(_line(
            "homecam_stream_stale_restarts_total",
            wm.get("stream_stale_restarts"),
            "Existing watchdog ladder actions requested by local WHEP failures",
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

    external = whep_probe_status.snapshot()
    parts.append(_line(
        "homecam_whep_external_cellular_consecutive_failures",
        external["consecutive_failures"],
        "Consecutive authenticated cellular-client WHEP failures",
    ))
    parts.append(_line(
        "homecam_whep_external_cellular_last_ok_timestamp_seconds",
        external["last_ok_ts"],
        "Unix timestamp of the latest cellular-client first frame",
    ))

    return "".join(parts)
