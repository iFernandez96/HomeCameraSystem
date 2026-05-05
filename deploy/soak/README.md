# Detector Soak-Test Harness

Measures whether a detector swap (today: SSD-MobileNet-v2 → YOLOv5n TRT) is
viable on **Jetson Nano 2GB** under sustained load. Designed as a hardware-
viability gate, not a quick benchmark.

## Why this exists

The camera-algorithm-auditor flagged YOLOv5n at 640×640 as **marginal** on a
2GB Nano: ~7 MB engine + 400–600 MB TRT workspace competes with the FastAPI
container, MediaMTX, and NVDEC inside a 2 GB unified memory pool.
SSD-MobileNet-v2 is the safe default. Before flipping the switch on YOLOv5n,
prove sustained 4-hour stability with no thermal throttle, no memory growth,
and no NVDEC/NVENC contention.

## What it measures

For each scenario, the harness records:

| Source | Cadence | Captures |
|---|---|---|
| `tegrastats` | 1 Hz | RAM, SWAP, CPU/GPU temp, GPU util, EMC bandwidth, power |
| `/api/_internal/heartbeat` poll | 0.1 Hz (10 s) | `gear`, `infer_ms_recent`, `infer_ms_p95`, `dropped`, `fps`, `last_frame_ts` |
| `/api/status` poll | 0.1 Hz | `worker_alive`, `seconds_since_last_frame`, `cpu_temp_c`, `gpu_temp_c`, `cpu_freq_pct`, `memory_used_mb` |
| `dmesg --follow` filter | event-driven | `soctherm`, `throttle`, `OOM`, `Killed`, `nvargus`, `nvdec`, `nvenc`, `cuda`, `tensorrt` |
| `systemctl status homecam-detect` snapshot | once at start + end | `MainPID`, restart count |

## Pass/fail thresholds (4-hour active soak)

| Metric | Pass | Investigate | Fail |
|---|---|---|---|
| Max GPU temp | < 78 °C | ≥ 78 °C | ≥ 82 °C |
| Time in `thermal-throttled` gear | < 5 % | ≥ 5 % | ≥ 15 % |
| `MemAvailable` floor | > 200 MB | < 200 MB | < 150 MB |
| `infer_ms` p95 (active gear) | < 200 ms | ≥ 200 ms | ≥ 400 ms |
| Dropped-frame growth rate | < 1/min | ≥ 5/min | ≥ 30/min |
| Hour-4 RAM vs hour-1 RAM | < +100 MB | ≥ +100 MB | ≥ +250 MB |
| Worker SIGKILL / restarts | 0 | ≥ 1 | ≥ 1 |
| `nvargus` / `nvdec` / OOM in `dmesg` | 0 | any | any |

If any **Investigate** threshold trips, keep YOLOv5n as opt-in only — do NOT
promote to default. If any **Fail** threshold trips, do not ship the YOLOv5n
opt-in either; reconsider hardware (fan upgrade, MAXN, or a Nano 4GB).

## Scenarios

Each scenario lives in `scenarios/<NN>-<name>.env`. The runner sources the
file as a systemd drop-in (`/etc/systemd/system/homecam-detect.service.d/
soak.conf`) so the `homecam-detect` worker picks up the env on the next
restart.

| # | Name | Detector | Active FPS | Notes |
|---|---|---|---|---|
| 00 | `idle` | n/a | n/a | Detection disabled via `/api/detection/config` PATCH; pure idle baseline. |
| 01 | `ssd-baseline` | `ssd-mobilenet-v2` | 5 | Current production. The control. |
| 02 | `yolo-416` | `yolov5n` | 5 | YOLO at 416×416 (workspace ~300 MB). |
| 03 | `yolo-3hz` | `yolov5n` | 3 | YOLO at 416×416 with active FPS halved per audit recommendation. |
| 04 | `stress` | `yolov5n` | 3 | Plus a synthetic person-event ffmpeg loop AND face_recognition active. |

YOLOv5n input-size knob: **today the worker has no `DETECT_INPUT_W/H` env
var.** The jetson-inference YOLOv5 wrapper uses the engine's compiled input
size, set at engine-build time. Operator must build the YOLO TRT engine at
the desired input size before scenario 02. A note appears in `02-yolo-416.env`.

## Usage on the Jetson

```bash
# 1. Confirm power mode + clock pinning (reproducibility)
sudo nvpmodel -q                        # expect: NV Power Mode: 5W (mode 1) or MAXN (0)
sudo nvpmodel -m 0                      # MAXN — uncap thermal headroom for the soak
sudo jetson_clocks --show               # snapshot
sudo jetson_clocks                      # pin clocks

# 2. Get on a clean main, deploy this directory to the Jetson
ssh jetson 'mkdir -p /home/israel/HomeCameraSystem/soak'
rsync -a deploy/soak/ jetson:/home/israel/HomeCameraSystem/soak/

# 3. Run a scenario for 4 hours. From the Jetson:
ssh jetson
cd /home/israel/HomeCameraSystem/soak
sudo ./run_scenario.sh 01-ssd-baseline 14400        # 4 h baseline
# … wait 4 h …
sudo ./run_scenario.sh 02-yolo-416    14400
sudo ./run_scenario.sh 03-yolo-3hz    14400
sudo ./run_scenario.sh 04-stress      14400
sudo ./run_scenario.sh 00-idle         3600         # 1 h idle is enough

# 4. Each run drops a directory:  ./logs/<scenario>-<utc-ts>/
#    Inside: tegrastats.log, heartbeat.jsonl, status.jsonl, dmesg.log,
#    summary.json (parser output), summary.txt (table).

# 5. Compare scenarios:
./parse_soak.py --compare logs/01-ssd-baseline-* logs/02-yolo-416-*
```

## Pulling logs back for analysis

```bash
# From dev box, after a run finishes:
rsync -a jetson:/home/israel/HomeCameraSystem/soak/logs/ ./soak-logs/
./deploy/soak/parse_soak.py --compare ./soak-logs/01-ssd-baseline-* ./soak-logs/02-yolo-416-*
```

## Stopping a soak early

```bash
sudo ./run_scenario.sh --abort
# Cleans up the systemd drop-in, kills tegrastats + loggers, restores
# original detector. Already idempotent against ctrl-C mid-run.
```

## Building the YOLOv5n TRT engine (one-time, before scenario 02)

This is operator-side; the worker won't build it for you. Two paths:

**A. via jetson-inference's built-in download**
```bash
# Pre-built model from NVIDIA's model zoo. May not have a 416 variant.
detectnet --network=yolov5n   # builds engine on first run; caches under ~/.cache
```

**B. via ultralytics → ONNX → trtexec (gives you input-size control)**
```bash
pip install ultralytics
python -c "from ultralytics import YOLO; YOLO('yolov5n.pt').export(format='onnx', imgsz=416)"
/usr/src/tensorrt/bin/trtexec --onnx=yolov5n.onnx --saveEngine=yolov5n_416.trt --fp16
# Move the engine where jetson-inference expects (or wire DETECT_MODEL to a
# local path; current detect.py passes the string straight to detectNet,
# which accepts a model file path as well as a network name).
```

Verify before the soak:
```bash
ls -la ~/.cache/jetson-inference/networks/   # or wherever the TRT engine landed
free -m                                       # baseline MemAvailable
sudo nvpmodel -q                              # confirm mode
```

## Files in this directory

```
README.md                — this file
run_scenario.sh          — main entry; orchestrates one scenario for N seconds
tegrastats.sh            — wraps tegrastats with logfile rotation
heartbeat_log.py         — Python 3.6 polling loop → heartbeat.jsonl
status_log.py            — Python 3.6 polling loop → status.jsonl
dmesg_watch.sh           — dmesg --follow filtered for relevant signals
synthetic_load.sh        — ffmpeg loop pushing test footage to RTSP (scenario 04)
parse_soak.py            — Python 3.6 parser; emits summary.json + summary.txt
scenarios/               — per-scenario env drop-ins
tests/test_parse_soak.py — dev-venv pytest for the parser
```

## Reading `parse_soak.py` output

The `summary.json` per run looks like:

```json
{
  "scenario": "02-yolo-416",
  "duration_s": 14403,
  "samples": {"tegrastats": 14400, "heartbeat": 1440, "status": 1440},
  "thermal": {"gpu_temp_c_avg": 71.4, "gpu_temp_c_max": 79.2, "throttle_pct": 6.3},
  "memory":  {"avail_mb_min": 178, "avail_mb_avg": 312, "swap_mb_max": 0,
              "ram_used_mb_h1": 1280, "ram_used_mb_h4": 1395, "growth_mb": 115},
  "inference": {"infer_ms_avg": 95.2, "infer_ms_p95_max": 218,
                "fps_active_avg": 4.2, "dropped_per_min_avg": 1.8,
                "dropped_per_min_max": 12},
  "stability": {"worker_restarts": 0, "dmesg_alerts": ["nvargus: TIMEOUT 2 times"]},
  "verdict": {
    "max_gpu_temp_c":   {"pass": false, "reason": "79.2 >= 78"},
    "throttle_pct":     {"pass": false, "reason": "6.3 >= 5"},
    "mem_avail_floor":  {"pass": true},
    "infer_p95":        {"pass": false, "reason": "218 >= 200"},
    "dropped_rate":     {"pass": true},
    "ram_growth":       {"pass": false, "reason": "115 >= 100"},
    "stability":        {"pass": false, "reason": "1 dmesg alert"},
    "OVERALL": "INVESTIGATE"
  }
}
```

`summary.txt` is a human-readable table of the same.

`OVERALL` is one of:
- `PASS` — every metric pass, no dmesg alerts, no restarts.
- `INVESTIGATE` — at least one Investigate threshold tripped.
- `FAIL` — at least one Fail threshold tripped, OR worker SIGKILL/restart, OR OOM in dmesg.

## Anti-patterns the harness deliberately blocks

- Short runs (< 30 min). The TRT engine cache warms after ~10 min; thermal
  trends only become evident at ~60 min. The runner refuses durations below
  1800 s except in `--smoke` mode (5 min, for testing the harness itself).
- Running two scenarios concurrently. The runner takes a `flock` on
  `/var/lock/homecam-soak.lock`; a second invocation aborts immediately.
- Running without `nvpmodel` pinned. Throws a warning and prompts; bypass
  with `--allow-unpinned-clocks` (don't, unless you're testing the harness).
- Skipping the cooldown step between scenarios. The runner waits for GPU
  temp to drop below 50 °C before declaring the next scenario ready, OR
  refuses to start until 10 minutes have elapsed since the last run.
