"""iter-199 (Feature #11 slice 2): pin Grafana dashboard validity.

The dashboards in `deploy/grafana/dashboards/` reference Prometheus
metric names that come from `app/routes/metrics_prom.py` (iter-189).
A drift between the two surfaces is silent — the dashboard would
just render "no data" forever in Grafana, no error. These tests
walk both files and assert:

1. Each dashboard JSON parses.
2. `schemaVersion >= 30` (Grafana 7+ minimum so older Grafana
   instances reject loudly rather than render broken layouts).
3. Each `targets[].expr` references a metric name that exists
   in `metrics_prom.py`'s `_line()` calls — extracted by
   regex-walking the source.

These are static-validation tests; we do NOT run an actual Grafana
to render the dashboards. That tier of testing belongs to a
deploy-time smoke probe (operator opens http://jetson:3000 and
checks panels render).
"""
from __future__ import annotations

import json
import re
from pathlib import Path

import pytest


_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
_DASHBOARD_DIR = _REPO_ROOT / "deploy" / "grafana" / "dashboards"
_METRICS_SRC = _REPO_ROOT / "server" / "app" / "routes" / "metrics_prom.py"
_PROMETHEUS_CONFIG = _REPO_ROOT / "deploy" / "prometheus" / "prometheus.yml"
_PROMETHEUS_ALERTS = _REPO_ROOT / "deploy" / "prometheus" / "alerts.yml"


def _exposed_metric_names() -> set[str]:
    """Walk `metrics_prom.py` and pull out every `_line("homecam_X", ...)`
    metric name. The hand-rolled exposition renderer uses `_line()`
    consistently — if a future iter swaps to `prometheus_client`
    library calls (Gauge, Counter), this regex needs to learn the new
    pattern."""
    text = _METRICS_SRC.read_text()
    pattern = re.compile(r'_line\(\s*"(homecam_[A-Za-z0-9_]+)"')
    return set(pattern.findall(text))


def _all_dashboards() -> list[Path]:
    return sorted(_DASHBOARD_DIR.glob("*.json"))


def _extract_referenced_metrics(panels: list[dict]) -> set[str]:
    """Walk the dashboard's panel tree and pull bare metric names
    out of each panel's `targets[].expr`. Strips `rate(...[5m])`
    wrappers so a counter referenced via `rate()` still matches the
    underlying name in the metrics_prom whitelist."""
    seen: set[str] = set()
    for panel in panels:
        for tgt in panel.get("targets", []):
            expr = tgt.get("expr", "").strip()
            # Match every `homecam_*` token in the expression — handles
            # bare metrics, rate() wrappers, math, label selectors.
            for match in re.finditer(r"homecam_[A-Za-z0-9_]+", expr):
                seen.add(match.group(0))
    return seen


@pytest.mark.parametrize("dashboard_path", _all_dashboards(), ids=lambda p: p.stem)
def test_dashboard_parses_as_valid_json(dashboard_path: Path):
    """Hand-written JSON must parse — a stray comma kills the whole
    provisioning loader at Grafana startup, no per-dashboard
    fallback."""
    data = json.loads(dashboard_path.read_text())
    assert isinstance(data, dict)


@pytest.mark.parametrize("dashboard_path", _all_dashboards(), ids=lambda p: p.stem)
def test_dashboard_has_required_top_level_fields(dashboard_path: Path):
    data = json.loads(dashboard_path.read_text())
    for key in ("uid", "title", "schemaVersion", "panels"):
        assert key in data, "{} missing top-level key {!r}".format(
            dashboard_path.name, key,
        )


@pytest.mark.parametrize("dashboard_path", _all_dashboards(), ids=lambda p: p.stem)
def test_dashboard_schema_version_is_modern(dashboard_path: Path):
    """schemaVersion 30 ≈ Grafana 7.x; dropping below that risks
    silent layout breakage on operator's Grafana version."""
    data = json.loads(dashboard_path.read_text())
    assert data["schemaVersion"] >= 30


@pytest.mark.parametrize("dashboard_path", _all_dashboards(), ids=lambda p: p.stem)
def test_dashboard_uses_only_exposed_metric_names(dashboard_path: Path):
    """Every metric the dashboard references MUST exist in
    metrics_prom.py. Drift here is silent — Grafana renders the
    panel as 'No data' instead of erroring."""
    data = json.loads(dashboard_path.read_text())
    referenced = _extract_referenced_metrics(data.get("panels", []))
    exposed = _exposed_metric_names()
    missing = referenced - exposed
    assert not missing, (
        "{} references metrics that metrics_prom.py doesn't expose: "
        "{}. Either add the metric to the exposition (and cite "
        "where it comes from in the heartbeat / probe layer) OR "
        "fix the dashboard's expr.".format(
            dashboard_path.name, sorted(missing),
        )
    )


def test_metrics_prom_extractor_finds_canonical_names():
    """Sanity check on the regex: known-canonical metric names must
    be found. If this fires, the regex broke and the dashboard
    cross-check is silently passing."""
    exposed = _exposed_metric_names()
    for canonical in (
        "homecam_worker_alive",
        "homecam_worker_fps",
        "homecam_worker_thumb_ms_recent",
        "homecam_cpu_temp_celsius",
    ):
        assert canonical in exposed, (
            "extractor failed to find {!r} in metrics_prom.py — "
            "regex may have drifted from `_line(...)` pattern.".format(
                canonical,
            )
        )


def test_at_least_two_dashboards_ship():
    """Feature #11 slice 2 ships overview + detection minimum."""
    assert len(_all_dashboards()) >= 2


def test_prometheus_loads_camera_health_alert_rules():
    config = _PROMETHEUS_CONFIG.read_text()
    assert "/etc/prometheus/alerts.yml" in config
    alerts = _PROMETHEUS_ALERTS.read_text()
    for alert in (
        "HomecamDetectionWorkerDown",
        "HomecamVideoStale",
        "HomecamJetsonHot",
        "HomecamDiskLow",
        "HomecamCameraRecoveryLoop",
        "HomecamWhepProbeFailed",
        "HomecamWhepExternalCellularOnlyFailure",
    ):
        assert "alert: {}".format(alert) in alerts
    assert (
        "homecam_whep_probe_success == 1 and "
        "homecam_whep_external_cellular_consecutive_failures >= 3"
    ) in alerts
