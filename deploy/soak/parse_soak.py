#!/usr/bin/env python3
"""Parse one soak run directory and emit summary.json + a human-readable
table to stdout. Python 3.6 compatible (must run on the JetPack host).

Usage:
    parse_soak.py <run-dir>
    parse_soak.py --compare <run-dir-a> <run-dir-b> [...]

Inputs (under <run-dir>):
    tegrastats.log    — one line per second, tegrastats native format
    heartbeat.jsonl   — one JSON line per /api/_internal/heartbeat poll
    status.jsonl      — one JSON line per /api/status poll (auth-gated)
    dmesg.log         — filtered dmesg stream (snapshot + alerts)
    preflight.txt     — context only, not parsed for verdict

Outputs:
    summary.json      — machine-readable verdict
    summary.txt       — printed to stdout (the runner pipes it to a file)

Pass/fail thresholds (mirrored in README.md):
    max_gpu_temp_c       PASS < 78 ; INVESTIGATE >= 78 ; FAIL >= 82
    throttle_pct         PASS < 5  ; INVESTIGATE >= 5  ; FAIL >= 15
    mem_avail_floor_mb   PASS > 200; INVESTIGATE < 200; FAIL < 150
    infer_ms_p95         PASS < 200; INVESTIGATE >= 200; FAIL >= 400
    dropped_per_min      PASS < 1  ; INVESTIGATE >= 5  ; FAIL >= 30
    ram_growth_mb        PASS < 100; INVESTIGATE >= 100; FAIL >= 250
    stability            PASS = 0 alerts AND 0 restarts; otherwise INVESTIGATE
                         (any OOM in dmesg → FAIL)
"""
from __future__ import print_function

import argparse
import json
import os
import re
import sys


# -- thresholds --------------------------------------------------------------

THRESHOLDS = {
    "max_gpu_temp_c":     {"pass_lt": 78.0,  "fail_ge": 82.0},
    "throttle_pct":       {"pass_lt": 5.0,   "fail_ge": 15.0},
    "mem_avail_floor_mb": {"pass_gt": 200.0, "fail_lt": 150.0},
    "infer_ms_p95":       {"pass_lt": 200.0, "fail_ge": 400.0},
    "dropped_per_min":    {"pass_lt": 1.0,   "fail_ge": 30.0},
    "ram_growth_mb":      {"pass_lt": 100.0, "fail_ge": 250.0},
}


# -- tegrastats parser -------------------------------------------------------

# Sample line on JetPack 4.6 (Nano):
#   RAM 1234/1979MB (lfb 4x4MB) SWAP 0/989MB (cached 0MB)
#   IRAM 0/252kB(lfb 252kB) CPU [12%@1479,17%@1479,16%@1479,11%@1479]
#   EMC_FREQ 0%@1600 GR3D_FREQ 0%@921 PLL@29C CPU@29.5C PMIC@100C
#   GPU@28C AO@33.5C thermal@29C POM_5V_IN 1812/1812 POM_5V_GPU 0/0
#   POM_5V_CPU 401/401
_RE_RAM = re.compile(r"\bRAM\s+(\d+)/(\d+)MB")
_RE_SWAP = re.compile(r"\bSWAP\s+(\d+)/(\d+)MB")
_RE_GPU_TEMP = re.compile(r"\bGPU@([0-9.]+)C")
_RE_CPU_TEMP = re.compile(r"\bCPU@([0-9.]+)C")
_RE_GR3D = re.compile(r"\bGR3D_FREQ\s+(\d+)%")
_RE_EMC = re.compile(r"\bEMC_FREQ\s+(\d+)%")
_RE_POM_IN = re.compile(r"\bPOM_5V_IN\s+(\d+)/(\d+)")


def _percentile(values, pct):
    if not values:
        return 0.0
    s = sorted(values)
    k = int(round((pct / 100.0) * (len(s) - 1)))
    k = max(0, min(len(s) - 1, k))
    return float(s[k])


def parse_tegrastats(path):
    """Return a dict of sample arrays + summary scalars."""
    out = {
        "samples": 0,
        "ram_used_mb": [],
        "ram_total_mb": 0,
        "ram_avail_mb": [],         # derived = total - used
        "swap_used_mb": [],
        "gpu_temp_c": [],
        "cpu_temp_c": [],
        "gr3d_pct": [],
        "emc_pct": [],
        "power_mw": [],             # POM_5V_IN current draw
    }
    if not os.path.exists(path):
        return out
    with open(path, "r") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            m_ram = _RE_RAM.search(line)
            if not m_ram:
                continue
            used = int(m_ram.group(1))
            total = int(m_ram.group(2))
            if total > out["ram_total_mb"]:
                out["ram_total_mb"] = total
            out["ram_used_mb"].append(used)
            out["ram_avail_mb"].append(max(0, total - used))
            m_swap = _RE_SWAP.search(line)
            if m_swap:
                out["swap_used_mb"].append(int(m_swap.group(1)))
            m_gpu = _RE_GPU_TEMP.search(line)
            if m_gpu:
                out["gpu_temp_c"].append(float(m_gpu.group(1)))
            m_cpu = _RE_CPU_TEMP.search(line)
            if m_cpu:
                out["cpu_temp_c"].append(float(m_cpu.group(1)))
            m_gr3d = _RE_GR3D.search(line)
            if m_gr3d:
                out["gr3d_pct"].append(int(m_gr3d.group(1)))
            m_emc = _RE_EMC.search(line)
            if m_emc:
                out["emc_pct"].append(int(m_emc.group(1)))
            m_pom = _RE_POM_IN.search(line)
            if m_pom:
                out["power_mw"].append(int(m_pom.group(1)))
            out["samples"] += 1
    return out


def summarize_tegra(t):
    if t["samples"] == 0:
        return {"samples": 0}
    n = t["samples"]
    one_hour = 3600
    h1_idx_lo, h1_idx_hi = 0, min(one_hour, n)
    h4_idx_lo = max(0, n - one_hour)
    ram_h1 = t["ram_used_mb"][h1_idx_lo:h1_idx_hi]
    ram_h4 = t["ram_used_mb"][h4_idx_lo:n]
    ram_h1_avg = sum(ram_h1) / len(ram_h1) if ram_h1 else 0
    ram_h4_avg = sum(ram_h4) / len(ram_h4) if ram_h4 else 0
    return {
        "samples": n,
        "duration_s": n,  # tegrastats sampled at 1 Hz
        "gpu_temp_c_avg": round(sum(t["gpu_temp_c"]) / max(1, len(t["gpu_temp_c"])), 1),
        "gpu_temp_c_max": round(max(t["gpu_temp_c"]) if t["gpu_temp_c"] else 0.0, 1),
        "gpu_temp_c_p95": round(_percentile(t["gpu_temp_c"], 95), 1),
        "cpu_temp_c_avg": round(sum(t["cpu_temp_c"]) / max(1, len(t["cpu_temp_c"])), 1),
        "cpu_temp_c_max": round(max(t["cpu_temp_c"]) if t["cpu_temp_c"] else 0.0, 1),
        "ram_total_mb":   t["ram_total_mb"],
        "ram_avail_mb_min": min(t["ram_avail_mb"]) if t["ram_avail_mb"] else 0,
        "ram_avail_mb_avg": round(sum(t["ram_avail_mb"]) / max(1, len(t["ram_avail_mb"])), 0),
        "swap_used_mb_max": max(t["swap_used_mb"]) if t["swap_used_mb"] else 0,
        "ram_used_mb_h1_avg": round(ram_h1_avg, 0),
        "ram_used_mb_h4_avg": round(ram_h4_avg, 0),
        "ram_growth_mb": round(ram_h4_avg - ram_h1_avg, 0),
        "gr3d_pct_avg": round(sum(t["gr3d_pct"]) / max(1, len(t["gr3d_pct"])), 1),
        "gr3d_pct_max": max(t["gr3d_pct"]) if t["gr3d_pct"] else 0,
        "power_mw_avg": round(sum(t["power_mw"]) / max(1, len(t["power_mw"])), 0),
        "power_mw_max": max(t["power_mw"]) if t["power_mw"] else 0,
    }


# -- heartbeat parser --------------------------------------------------------

def parse_heartbeat(path):
    """Read JSONL of /api/_internal/heartbeat polls; return aggregated."""
    out = {
        "samples": 0,
        "ok_samples": 0,
        "gear_counts": {},
        "infer_ms_recent": [],
        "infer_ms_p95": [],
        "fps": [],
        "dropped_first": None,
        "dropped_last": None,
        "first_ts": None,
        "last_ts": None,
        "alerts": [],
    }
    if not os.path.exists(path):
        return out
    with open(path, "r") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except ValueError:
                continue
            out["samples"] += 1
            if not rec.get("ok"):
                out["alerts"].append({"sampled_at": rec.get("sampled_at"),
                                      "error": rec.get("error")})
                continue
            out["ok_samples"] += 1
            if out["first_ts"] is None:
                out["first_ts"] = rec.get("sampled_at")
            out["last_ts"] = rec.get("sampled_at")
            snap = rec.get("snapshot") or {}
            metrics = snap.get("metrics") or snap.get("worker_metrics") or snap
            gear = metrics.get("gear")
            if gear:
                out["gear_counts"][gear] = out["gear_counts"].get(gear, 0) + 1
            if "infer_ms_recent" in metrics:
                try:
                    out["infer_ms_recent"].append(float(metrics["infer_ms_recent"]))
                except (TypeError, ValueError):
                    pass
            if "infer_ms_p95" in metrics:
                try:
                    out["infer_ms_p95"].append(float(metrics["infer_ms_p95"]))
                except (TypeError, ValueError):
                    pass
            if "fps" in metrics:
                try:
                    out["fps"].append(float(metrics["fps"]))
                except (TypeError, ValueError):
                    pass
            if "dropped" in metrics:
                try:
                    d = int(metrics["dropped"])
                    if out["dropped_first"] is None:
                        out["dropped_first"] = d
                    out["dropped_last"] = d
                except (TypeError, ValueError):
                    pass
    return out


def summarize_heartbeat(h, run_duration_s):
    n = h["samples"]
    if n == 0:
        return {"samples": 0}
    total_gear = sum(h["gear_counts"].values()) or 1
    throttled = h["gear_counts"].get("thermal-throttled", 0)
    active_count = h["gear_counts"].get("active", 0)
    duration_min = max(1.0, run_duration_s / 60.0)
    dropped_delta = 0
    if h["dropped_first"] is not None and h["dropped_last"] is not None:
        dropped_delta = max(0, h["dropped_last"] - h["dropped_first"])
    return {
        "samples": n,
        "ok_samples": h["ok_samples"],
        "gear_distribution_pct": {
            g: round(100.0 * c / total_gear, 1) for g, c in h["gear_counts"].items()
        },
        "throttle_pct": round(100.0 * throttled / total_gear, 1),
        "active_pct":   round(100.0 * active_count / total_gear, 1),
        "infer_ms_recent_avg": (
            round(sum(h["infer_ms_recent"]) / len(h["infer_ms_recent"]), 1)
            if h["infer_ms_recent"] else 0.0
        ),
        "infer_ms_p95_max": round(max(h["infer_ms_p95"]) if h["infer_ms_p95"] else 0.0, 1),
        "infer_ms_p95_avg": (
            round(sum(h["infer_ms_p95"]) / len(h["infer_ms_p95"]), 1)
            if h["infer_ms_p95"] else 0.0
        ),
        "fps_avg": round(sum(h["fps"]) / max(1, len(h["fps"])), 2),
        "dropped_total":   dropped_delta,
        "dropped_per_min": round(dropped_delta / duration_min, 2),
        "heartbeat_uptime_pct": round(100.0 * h["ok_samples"] / max(1, n), 1),
    }


# -- status parser -----------------------------------------------------------

def parse_status(path):
    """Read JSONL of /api/status polls; pull worker_alive transitions +
    `seconds_since_last_frame` extremes. Auth-gated; if cookies missing
    every line is ok=false → we degrade gracefully."""
    out = {
        "samples": 0,
        "ok_samples": 0,
        "alive_transitions": 0,
        "max_seconds_since_last_frame": 0,
        "stale_stream_count": 0,    # samples with seconds_since_last_frame > 60
    }
    last_alive = None
    if not os.path.exists(path):
        return out
    with open(path, "r") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except ValueError:
                continue
            out["samples"] += 1
            if not rec.get("ok"):
                continue
            out["ok_samples"] += 1
            snap = rec.get("snapshot") or {}
            alive = bool(snap.get("worker_alive"))
            if last_alive is not None and alive != last_alive:
                out["alive_transitions"] += 1
            last_alive = alive
            sslf = snap.get("seconds_since_last_frame")
            if sslf is not None:
                try:
                    sslf = float(sslf)
                except (TypeError, ValueError):
                    sslf = 0.0
                if sslf > out["max_seconds_since_last_frame"]:
                    out["max_seconds_since_last_frame"] = sslf
                if sslf > 60:
                    out["stale_stream_count"] += 1
    return out


# -- dmesg parser ------------------------------------------------------------

_DMESG_FAIL_KEYWORDS = re.compile(
    r"out of memory|oom-killer|killed process|sigkill|hung_task", re.IGNORECASE
)
_DMESG_INVESTIGATE_KEYWORDS = re.compile(
    r"soctherm|throttle|nvargus|nvbufsurface|nvv4l2|nvdec|nvenc|cuda|tensorrt|libargus",
    re.IGNORECASE,
)


def parse_dmesg(path):
    out = {
        "fail_alerts": [],     # OOM, hung_task, etc — always FAIL
        "investigate_alerts": [],   # soctherm, nvargus, etc — INVESTIGATE
        "snapshot_lines": 0,
        "follow_alerts": 0,
    }
    if not os.path.exists(path):
        return out
    in_follow = False
    with open(path, "r") as f:
        for line in f:
            line = line.rstrip("\n")
            if "=== tail -F begin ===" in line:
                in_follow = True
                continue
            if not in_follow:
                out["snapshot_lines"] += 1
                continue
            out["follow_alerts"] += 1
            if _DMESG_FAIL_KEYWORDS.search(line):
                out["fail_alerts"].append(line)
            elif _DMESG_INVESTIGATE_KEYWORDS.search(line):
                out["investigate_alerts"].append(line)
    return out


# -- verdict ----------------------------------------------------------------

def evaluate(tegra_s, heart_s, status_s, dmesg_s, run_duration_s):
    v = {}

    def _three_way(name, value, pass_check, fail_check):
        if fail_check(value):
            v[name] = {"value": value, "verdict": "FAIL"}
        elif pass_check(value):
            v[name] = {"value": value, "verdict": "PASS"}
        else:
            v[name] = {"value": value, "verdict": "INVESTIGATE"}

    if tegra_s.get("samples", 0) > 0:
        gpu_max = tegra_s.get("gpu_temp_c_max", 0.0)
        _three_way("max_gpu_temp_c", gpu_max,
                   lambda x: x < THRESHOLDS["max_gpu_temp_c"]["pass_lt"],
                   lambda x: x >= THRESHOLDS["max_gpu_temp_c"]["fail_ge"])
        floor = tegra_s.get("ram_avail_mb_min", 0)
        _three_way("mem_avail_floor_mb", floor,
                   lambda x: x > THRESHOLDS["mem_avail_floor_mb"]["pass_gt"],
                   lambda x: x < THRESHOLDS["mem_avail_floor_mb"]["fail_lt"])
        growth = tegra_s.get("ram_growth_mb", 0)
        _three_way("ram_growth_mb", growth,
                   lambda x: x < THRESHOLDS["ram_growth_mb"]["pass_lt"],
                   lambda x: x >= THRESHOLDS["ram_growth_mb"]["fail_ge"])
    else:
        v["max_gpu_temp_c"] = {"value": None, "verdict": "INVESTIGATE",
                                "reason": "no tegrastats samples"}
        v["mem_avail_floor_mb"] = {"value": None, "verdict": "INVESTIGATE",
                                   "reason": "no tegrastats samples"}
        v["ram_growth_mb"] = {"value": None, "verdict": "INVESTIGATE",
                              "reason": "no tegrastats samples"}

    if heart_s.get("samples", 0) > 0:
        thr = heart_s.get("throttle_pct", 0.0)
        _three_way("throttle_pct", thr,
                   lambda x: x < THRESHOLDS["throttle_pct"]["pass_lt"],
                   lambda x: x >= THRESHOLDS["throttle_pct"]["fail_ge"])
        p95 = heart_s.get("infer_ms_p95_max", 0.0)
        _three_way("infer_ms_p95", p95,
                   lambda x: x < THRESHOLDS["infer_ms_p95"]["pass_lt"],
                   lambda x: x >= THRESHOLDS["infer_ms_p95"]["fail_ge"])
        dpm = heart_s.get("dropped_per_min", 0.0)
        _three_way("dropped_per_min", dpm,
                   lambda x: x < THRESHOLDS["dropped_per_min"]["pass_lt"],
                   lambda x: x >= THRESHOLDS["dropped_per_min"]["fail_ge"])
    else:
        for k in ("throttle_pct", "infer_ms_p95", "dropped_per_min"):
            v[k] = {"value": None, "verdict": "INVESTIGATE",
                    "reason": "no heartbeat samples"}

    stability_verdict = "PASS"
    stability_reason = ""
    if dmesg_s["fail_alerts"]:
        stability_verdict = "FAIL"
        stability_reason = "dmesg has {} OOM/hung_task entries".format(
            len(dmesg_s["fail_alerts"])
        )
    elif dmesg_s["investigate_alerts"]:
        stability_verdict = "INVESTIGATE"
        stability_reason = "dmesg has {} thermal/driver alerts".format(
            len(dmesg_s["investigate_alerts"])
        )
    if status_s.get("alive_transitions", 0) >= 2:
        stability_verdict = "FAIL"
        stability_reason = "worker died and restarted ({} transitions)".format(
            status_s["alive_transitions"]
        )
    v["stability"] = {
        "verdict": stability_verdict,
        "reason": stability_reason or "no alerts",
        "fail_alerts": dmesg_s["fail_alerts"][:10],
        "investigate_alerts": dmesg_s["investigate_alerts"][:10],
        "alive_transitions": status_s.get("alive_transitions", 0),
    }

    overall = "PASS"
    for key, entry in v.items():
        if entry.get("verdict") == "FAIL":
            overall = "FAIL"
            break
        if entry.get("verdict") == "INVESTIGATE" and overall == "PASS":
            overall = "INVESTIGATE"
    v["OVERALL"] = overall
    return v


# -- formatting -------------------------------------------------------------

def render_table(scenario, run_duration_s, tegra_s, heart_s, status_s,
                 dmesg_s, verdict):
    lines = []
    lines.append("=" * 78)
    lines.append("Soak summary: {}  (duration {} s, {:.1f} h)".format(
        scenario, run_duration_s, run_duration_s / 3600.0
    ))
    lines.append("=" * 78)
    lines.append("")
    lines.append("Thermal:")
    lines.append("  GPU temp avg/p95/max:  {} / {} / {} C".format(
        tegra_s.get("gpu_temp_c_avg", "-"),
        tegra_s.get("gpu_temp_c_p95", "-"),
        tegra_s.get("gpu_temp_c_max", "-"),
    ))
    lines.append("  CPU temp avg/max:      {} / {} C".format(
        tegra_s.get("cpu_temp_c_avg", "-"),
        tegra_s.get("cpu_temp_c_max", "-"),
    ))
    lines.append("  Time in throttled gear: {} %".format(
        heart_s.get("throttle_pct", "-")
    ))
    lines.append("")
    lines.append("Memory:")
    lines.append("  RAM total:             {} MB".format(tegra_s.get("ram_total_mb", "-")))
    lines.append("  RAM avail floor/avg:   {} / {} MB".format(
        tegra_s.get("ram_avail_mb_min", "-"),
        tegra_s.get("ram_avail_mb_avg", "-"),
    ))
    lines.append("  Swap used (max):       {} MB".format(tegra_s.get("swap_used_mb_max", "-")))
    lines.append("  RAM used h1 / h4 / growth:  {} / {} / {} MB".format(
        tegra_s.get("ram_used_mb_h1_avg", "-"),
        tegra_s.get("ram_used_mb_h4_avg", "-"),
        tegra_s.get("ram_growth_mb", "-"),
    ))
    lines.append("")
    lines.append("Inference:")
    lines.append("  infer_ms recent avg:   {}".format(heart_s.get("infer_ms_recent_avg", "-")))
    lines.append("  infer_ms p95 avg/max:  {} / {}".format(
        heart_s.get("infer_ms_p95_avg", "-"),
        heart_s.get("infer_ms_p95_max", "-"),
    ))
    lines.append("  fps avg:               {}".format(heart_s.get("fps_avg", "-")))
    lines.append("  dropped total / per-min: {} / {}".format(
        heart_s.get("dropped_total", "-"),
        heart_s.get("dropped_per_min", "-"),
    ))
    lines.append("  gear distribution:     {}".format(heart_s.get("gear_distribution_pct", "-")))
    lines.append("  heartbeat uptime:      {} %".format(heart_s.get("heartbeat_uptime_pct", "-")))
    lines.append("")
    lines.append("Stability:")
    lines.append("  worker alive transitions: {}".format(status_s.get("alive_transitions", "-")))
    lines.append("  max seconds_since_last_frame: {}".format(
        status_s.get("max_seconds_since_last_frame", "-")
    ))
    lines.append("  stale-stream samples (>60s): {}".format(status_s.get("stale_stream_count", "-")))
    lines.append("  dmesg fail alerts:        {}".format(len(dmesg_s["fail_alerts"])))
    lines.append("  dmesg investigate alerts: {}".format(len(dmesg_s["investigate_alerts"])))
    if dmesg_s["fail_alerts"]:
        lines.append("  --- dmesg fail samples ---")
        for s in dmesg_s["fail_alerts"][:3]:
            lines.append("    {}".format(s))
    if dmesg_s["investigate_alerts"]:
        lines.append("  --- dmesg investigate samples ---")
        for s in dmesg_s["investigate_alerts"][:3]:
            lines.append("    {}".format(s))
    lines.append("")
    lines.append("Verdict (per metric):")
    width = 24
    for key in ("max_gpu_temp_c", "throttle_pct", "mem_avail_floor_mb",
                "infer_ms_p95", "dropped_per_min", "ram_growth_mb",
                "stability"):
        entry = verdict.get(key, {})
        v_text = entry.get("verdict", "?")
        val = entry.get("value", entry.get("reason", ""))
        lines.append("  {:<{w}} {:<12}  {}".format(
            key + ":", v_text, val, w=width
        ))
    lines.append("")
    lines.append("OVERALL: {}".format(verdict.get("OVERALL", "?")))
    lines.append("=" * 78)
    return "\n".join(lines)


def parse_run(run_dir):
    tegra = parse_tegrastats(os.path.join(run_dir, "tegrastats.log"))
    tegra_s = summarize_tegra(tegra)
    duration = tegra_s.get("duration_s", 0)
    heart = parse_heartbeat(os.path.join(run_dir, "heartbeat.jsonl"))
    heart_s = summarize_heartbeat(heart, duration)
    status = parse_status(os.path.join(run_dir, "status.jsonl"))
    dmesg = parse_dmesg(os.path.join(run_dir, "dmesg.log"))
    verdict = evaluate(tegra_s, heart_s, status, dmesg, duration)
    return {
        "scenario": os.path.basename(run_dir.rstrip("/")),
        "run_dir": os.path.abspath(run_dir),
        "duration_s": duration,
        "tegra": tegra_s,
        "heartbeat": heart_s,
        "status": status,
        "dmesg": {
            "snapshot_lines": dmesg["snapshot_lines"],
            "follow_alerts": dmesg["follow_alerts"],
            "fail_alerts": dmesg["fail_alerts"],
            "investigate_alerts": dmesg["investigate_alerts"],
        },
        "verdict": verdict,
    }


def render_compare(runs):
    lines = []
    lines.append("=" * 78)
    lines.append("Soak comparison ({} runs)".format(len(runs)))
    lines.append("=" * 78)
    header = "{:<28} {:>9} {:>9} {:>9} {:>9} {:>11}".format(
        "scenario", "gpu_max", "thr_pct", "mem_min", "p95_max", "ram_growth"
    )
    lines.append(header)
    lines.append("-" * len(header))
    for r in runs:
        t = r["tegra"]
        h = r["heartbeat"]
        lines.append("{:<28} {:>9} {:>9} {:>9} {:>9} {:>11}  {}".format(
            r["scenario"][:28],
            t.get("gpu_temp_c_max", "-"),
            h.get("throttle_pct", "-"),
            t.get("ram_avail_mb_min", "-"),
            h.get("infer_ms_p95_max", "-"),
            t.get("ram_growth_mb", "-"),
            r["verdict"].get("OVERALL", "?"),
        ))
    return "\n".join(lines)


def main(argv):
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("paths", nargs="+", help="run directory or directories")
    p.add_argument("--compare", action="store_true",
                   help="render comparison table across multiple runs")
    p.add_argument("--json", action="store_true",
                   help="emit JSON only (default emits human table)")
    args = p.parse_args(argv)

    runs = []
    for path in args.paths:
        result = parse_run(path)
        runs.append(result)
        # Always write summary.json next to inputs.
        with open(os.path.join(path, "summary.json"), "w") as f:
            json.dump(result, f, indent=2, sort_keys=True, default=str)

    if args.compare or len(runs) > 1:
        if args.json:
            print(json.dumps(runs, indent=2, sort_keys=True, default=str))
        else:
            print(render_compare(runs))
    else:
        r = runs[0]
        if args.json:
            print(json.dumps(r, indent=2, sort_keys=True, default=str))
        else:
            print(render_table(
                r["scenario"], r["duration_s"], r["tegra"], r["heartbeat"],
                r["status"], {
                    "fail_alerts": r["dmesg"]["fail_alerts"],
                    "investigate_alerts": r["dmesg"]["investigate_alerts"],
                }, r["verdict"]
            ))
    return 0 if all(r["verdict"]["OVERALL"] != "FAIL" for r in runs) else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
