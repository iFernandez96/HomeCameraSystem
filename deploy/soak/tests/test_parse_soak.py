"""Tests for parse_soak.py — runs in the dev venv (Python 3.6+).
BDD-lite naming + arrange/act/assert blocks.
"""
import json
import os
import sys

import pytest

_HERE = os.path.dirname(os.path.abspath(__file__))
_SOAK_DIR = os.path.dirname(_HERE)
if _SOAK_DIR not in sys.path:
    sys.path.insert(0, _SOAK_DIR)

import parse_soak  # noqa: E402


# --- tegrastats parsing -----------------------------------------------------


def test_given_one_tegrastats_line_when_parsed_then_ram_extracted(tmp_path):
    # arrange
    log = tmp_path / "tegrastats.log"
    log.write_text(
        "RAM 1234/1979MB (lfb 4x4MB) SWAP 0/989MB (cached 0MB) "
        "CPU [12%@1479,17%@1479,16%@1479,11%@1479] EMC_FREQ 0%@1600 "
        "GR3D_FREQ 25%@921 PLL@29C CPU@29.5C GPU@28C AO@33.5C thermal@29C "
        "POM_5V_IN 1812/1812\n"
    )

    # act
    out = parse_soak.parse_tegrastats(str(log))

    # assert
    assert out["samples"] == 1
    assert out["ram_used_mb"] == [1234]
    assert out["ram_total_mb"] == 1979
    assert out["ram_avail_mb"] == [745]
    assert out["gpu_temp_c"] == [28.0]
    assert out["cpu_temp_c"] == [29.5]
    assert out["gr3d_pct"] == [25]
    assert out["power_mw"] == [1812]


def test_given_growth_when_summarized_then_ram_growth_mb_reflects_h1_vs_h4(tmp_path):
    # arrange — fabricate 4 hours (14400 samples). Hour 1 avg 1200, hour
    # 4 avg 1350. Expected growth = 150 MB.
    log = tmp_path / "tegrastats.log"
    lines = []
    for i in range(14400):
        if i < 3600:
            ram = 1200
        elif i < 10800:
            ram = 1275
        else:
            ram = 1350
        lines.append(
            "RAM {ram}/1979MB (lfb 4x4MB) SWAP 0/989MB GPU@70C CPU@65C "
            "GR3D_FREQ 30%@921 EMC_FREQ 5%@1600 POM_5V_IN 2000/2000\n".format(
                ram=ram,
            )
        )
    log.write_text("".join(lines))

    # act
    parsed = parse_soak.parse_tegrastats(str(log))
    summary = parse_soak.summarize_tegra(parsed)

    # assert
    assert summary["samples"] == 14400
    assert summary["ram_used_mb_h1_avg"] == 1200.0
    assert summary["ram_used_mb_h4_avg"] == 1350.0
    assert summary["ram_growth_mb"] == 150.0


def test_given_no_tegrastats_log_when_parsed_then_zero_samples(tmp_path):
    # arrange — file does not exist.

    # act
    parsed = parse_soak.parse_tegrastats(str(tmp_path / "missing.log"))

    # assert
    assert parsed["samples"] == 0


# --- heartbeat parsing ------------------------------------------------------


def _write_jsonl(path, records):
    with open(str(path), "w") as f:
        for r in records:
            f.write(json.dumps(r) + "\n")


def test_given_heartbeat_with_throttle_gear_when_summarized_then_throttle_pct_correct(
    tmp_path,
):
    # arrange — 100 samples: 80 active, 15 idle, 5 thermal-throttled.
    records = []
    for i in range(80):
        records.append({"sampled_at": "T", "ok": True,
                        "snapshot": {"metrics": {"gear": "active",
                                                  "infer_ms_recent": 60.0,
                                                  "infer_ms_p95": 90.0,
                                                  "fps": 4.5,
                                                  "dropped": i}}})
    for i in range(15):
        records.append({"sampled_at": "T", "ok": True,
                        "snapshot": {"metrics": {"gear": "idle",
                                                  "infer_ms_recent": 50.0,
                                                  "infer_ms_p95": 70.0,
                                                  "fps": 1.0,
                                                  "dropped": 80}}})
    for i in range(5):
        records.append({"sampled_at": "T", "ok": True,
                        "snapshot": {"metrics": {"gear": "thermal-throttled",
                                                  "infer_ms_recent": 200.0,
                                                  "infer_ms_p95": 240.0,
                                                  "fps": 0.8,
                                                  "dropped": 90}}})
    p = tmp_path / "hb.jsonl"
    _write_jsonl(p, records)

    # act
    parsed = parse_soak.parse_heartbeat(str(p))
    summary = parse_soak.summarize_heartbeat(parsed, run_duration_s=600)

    # assert
    assert summary["samples"] == 100
    assert summary["throttle_pct"] == 5.0
    assert summary["active_pct"] == 80.0
    assert summary["dropped_total"] == 90


def test_given_failed_heartbeat_samples_when_summarized_then_uptime_pct_below_100(
    tmp_path,
):
    # arrange — 10 ok, 5 failed.
    records = []
    for _ in range(10):
        records.append({"sampled_at": "T", "ok": True,
                        "snapshot": {"metrics": {"gear": "idle",
                                                  "infer_ms_p95": 80.0}}})
    for _ in range(5):
        records.append({"sampled_at": "T", "ok": False,
                        "error": "URLError(...)"})
    p = tmp_path / "hb.jsonl"
    _write_jsonl(p, records)

    # act
    parsed = parse_soak.parse_heartbeat(str(p))
    summary = parse_soak.summarize_heartbeat(parsed, run_duration_s=600)

    # assert
    assert summary["samples"] == 15
    assert summary["ok_samples"] == 10
    assert summary["heartbeat_uptime_pct"] == pytest.approx(66.7, abs=0.1)


# --- dmesg parsing ----------------------------------------------------------


def test_given_dmesg_with_oom_after_follow_marker_then_fail_alerts_collected(tmp_path):
    # arrange — snapshot section + post-marker OOM line.
    p = tmp_path / "dmesg.log"
    p.write_text(
        "=== dmesg snapshot at 2026-05-04T00:00:00Z ===\n"
        "[12345.0] some pre-soak noise\n"
        "=== tail -F begin ===\n"
        "[12999.5] Out of memory: Kill process 4242 (python) score 800\n"
        "[13000.0] tegra_soctherm: oc_alarm_throttle\n"
    )

    # act
    parsed = parse_soak.parse_dmesg(str(p))

    # assert — OOM is FAIL-tier; soctherm is INVESTIGATE-tier.
    assert len(parsed["fail_alerts"]) == 1
    assert "Out of memory" in parsed["fail_alerts"][0]
    assert len(parsed["investigate_alerts"]) == 1
    assert "soctherm" in parsed["investigate_alerts"][0]


def test_given_dmesg_pre_follow_only_then_no_alerts_collected(tmp_path):
    # arrange — alert appears in pre-soak snapshot section only. We
    # treat that as historical context, not a soak failure.
    p = tmp_path / "dmesg.log"
    p.write_text(
        "=== dmesg snapshot at 2026-05-04T00:00:00Z ===\n"
        "[1.0] Out of memory: Kill process from a year ago\n"
        "=== tail -F begin ===\n"
    )

    # act
    parsed = parse_soak.parse_dmesg(str(p))

    # assert
    assert parsed["fail_alerts"] == []
    assert parsed["investigate_alerts"] == []


# --- verdict ----------------------------------------------------------------


def test_given_clean_metrics_when_evaluated_then_overall_pass():
    # arrange
    tegra_s = {"samples": 14400, "gpu_temp_c_max": 70.0, "ram_avail_mb_min": 350,
               "ram_growth_mb": 40}
    heart_s = {"samples": 1440, "throttle_pct": 1.0,
               "infer_ms_p95_max": 90.0, "dropped_per_min": 0.3}
    status_s = {"alive_transitions": 0}
    dmesg_s = {"fail_alerts": [], "investigate_alerts": []}

    # act
    v = parse_soak.evaluate(tegra_s, heart_s, status_s, dmesg_s, 14400)

    # assert
    assert v["max_gpu_temp_c"]["verdict"] == "PASS"
    assert v["throttle_pct"]["verdict"] == "PASS"
    assert v["mem_avail_floor_mb"]["verdict"] == "PASS"
    assert v["infer_ms_p95"]["verdict"] == "PASS"
    assert v["dropped_per_min"]["verdict"] == "PASS"
    assert v["ram_growth_mb"]["verdict"] == "PASS"
    assert v["stability"]["verdict"] == "PASS"
    assert v["OVERALL"] == "PASS"


def test_given_one_investigate_metric_then_overall_investigate():
    # arrange — GPU max 80 C → INVESTIGATE band (>= 78, < 82).
    tegra_s = {"samples": 14400, "gpu_temp_c_max": 80.0, "ram_avail_mb_min": 350,
               "ram_growth_mb": 40}
    heart_s = {"samples": 1440, "throttle_pct": 1.0,
               "infer_ms_p95_max": 90.0, "dropped_per_min": 0.3}
    status_s = {"alive_transitions": 0}
    dmesg_s = {"fail_alerts": [], "investigate_alerts": []}

    # act
    v = parse_soak.evaluate(tegra_s, heart_s, status_s, dmesg_s, 14400)

    # assert
    assert v["max_gpu_temp_c"]["verdict"] == "INVESTIGATE"
    assert v["OVERALL"] == "INVESTIGATE"


def test_given_oom_in_dmesg_then_overall_fail():
    # arrange — clean metrics but an OOM alert.
    tegra_s = {"samples": 14400, "gpu_temp_c_max": 70.0, "ram_avail_mb_min": 350,
               "ram_growth_mb": 40}
    heart_s = {"samples": 1440, "throttle_pct": 1.0,
               "infer_ms_p95_max": 90.0, "dropped_per_min": 0.3}
    status_s = {"alive_transitions": 0}
    dmesg_s = {"fail_alerts": ["[1.0] Out of memory: Kill process 1 (init)"],
               "investigate_alerts": []}

    # act
    v = parse_soak.evaluate(tegra_s, heart_s, status_s, dmesg_s, 14400)

    # assert
    assert v["stability"]["verdict"] == "FAIL"
    assert v["OVERALL"] == "FAIL"


def test_given_worker_alive_transition_when_evaluated_then_stability_fail():
    # arrange — 2 alive transitions = died and came back.
    tegra_s = {"samples": 14400, "gpu_temp_c_max": 70.0, "ram_avail_mb_min": 350,
               "ram_growth_mb": 40}
    heart_s = {"samples": 1440, "throttle_pct": 1.0,
               "infer_ms_p95_max": 90.0, "dropped_per_min": 0.3}
    status_s = {"alive_transitions": 2}
    dmesg_s = {"fail_alerts": [], "investigate_alerts": []}

    # act
    v = parse_soak.evaluate(tegra_s, heart_s, status_s, dmesg_s, 14400)

    # assert
    assert v["stability"]["verdict"] == "FAIL"
    assert "alive_transitions" in v["stability"]["reason"] or \
           "transitions" in v["stability"]["reason"]
    assert v["OVERALL"] == "FAIL"


def test_given_low_mem_when_evaluated_then_fail():
    # arrange — RAM avail floor 130 MB → FAIL (< 150).
    tegra_s = {"samples": 14400, "gpu_temp_c_max": 70.0, "ram_avail_mb_min": 130,
               "ram_growth_mb": 40}
    heart_s = {"samples": 1440, "throttle_pct": 1.0,
               "infer_ms_p95_max": 90.0, "dropped_per_min": 0.3}
    status_s = {"alive_transitions": 0}
    dmesg_s = {"fail_alerts": [], "investigate_alerts": []}

    # act
    v = parse_soak.evaluate(tegra_s, heart_s, status_s, dmesg_s, 14400)

    # assert
    assert v["mem_avail_floor_mb"]["verdict"] == "FAIL"
    assert v["OVERALL"] == "FAIL"


def test_given_missing_inputs_when_evaluated_then_metrics_marked_investigate():
    # arrange — no tegrastats, no heartbeat samples (e.g. logger died early).
    tegra_s = {"samples": 0}
    heart_s = {"samples": 0}
    status_s = {"alive_transitions": 0}
    dmesg_s = {"fail_alerts": [], "investigate_alerts": []}

    # act
    v = parse_soak.evaluate(tegra_s, heart_s, status_s, dmesg_s, 0)

    # assert
    for key in ("max_gpu_temp_c", "throttle_pct", "mem_avail_floor_mb",
                "infer_ms_p95", "dropped_per_min", "ram_growth_mb"):
        assert v[key]["verdict"] == "INVESTIGATE"
    assert v["OVERALL"] == "INVESTIGATE"


# --- end-to-end -------------------------------------------------------------


def test_given_full_run_dir_when_parse_run_then_summary_written(tmp_path):
    # arrange — minimal run directory with one sample of each input.
    run = tmp_path / "01-ssd-baseline-20260504T120000Z"
    run.mkdir()
    (run / "tegrastats.log").write_text(
        "RAM 1200/1979MB SWAP 0/989MB GPU@70C CPU@65C GR3D_FREQ 25%@921 "
        "EMC_FREQ 0%@1600 POM_5V_IN 2000/2000\n"
    )
    _write_jsonl(run / "heartbeat.jsonl", [
        {"sampled_at": "T", "ok": True, "snapshot": {"metrics": {
            "gear": "active", "infer_ms_recent": 50.0, "infer_ms_p95": 80.0,
            "fps": 5.0, "dropped": 0,
        }}},
    ])
    _write_jsonl(run / "status.jsonl", [
        {"sampled_at": "T", "ok": True, "snapshot": {"worker_alive": True,
                                                       "seconds_since_last_frame": 0.5}},
    ])
    (run / "dmesg.log").write_text("=== tail -F begin ===\n")

    # act — main() writes summary.json next to the inputs.
    rc = parse_soak.main([str(run), "--json"])
    summary_path = run / "summary.json"

    # assert
    assert rc in (0, 1)
    assert summary_path.exists()
    with open(str(summary_path)) as f:
        on_disk = json.load(f)
    assert on_disk["scenario"].startswith("01-ssd-baseline")
    assert on_disk["verdict"]["OVERALL"] in ("PASS", "INVESTIGATE", "FAIL")
    assert on_disk["heartbeat"]["samples"] == 1
