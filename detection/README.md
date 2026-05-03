# detection

Host-side person-detection worker. Runs SSD-MobileNet-v2 via jetson-inference (TensorRT FP16) on the Jetson Nano. Reads frames from MediaMTX's RTSP stream (`rtsp://localhost:8554/cam`) via jetson-utils' `videoSource`, which decodes the H.264 with NVDEC; POSTs events to the FastAPI server's `/api/_internal/event` endpoint.

We re-decode the encoder output instead of teeing raw frames into a shmsink because JetPack's stock apt OpenCV (3.2.0) is built without GStreamer support, so `cv2` can't read from `shmsrc`. NVDEC is essentially free on the Nano (<10 % of decoder capacity), so single-pass-encode-then-decode is cheaper than maintaining a parallel shmem path.

## Why it lives outside `server/`

The FastAPI server runs in a Docker container with Python 3.11, because JetPack 4.x ships only Python 3.6 (FastAPI 0.115 / Pydantic v2 require 3.8+). Detection in turn needs the host's CUDA + TensorRT + jetson-inference stack — that's a Python 3.6 dependency tree that won't run inside the container without dragging in nvidia-docker bind mounts. Cleaner split: server in container, detection as a host systemd unit.

## Run manually

```bash
# On the Jetson:
ssh jetson 'cd ~/HomeCameraSystem && DETECT_THRESHOLD=0.55 python3 detection/detect.py'
```

First run downloads the model and TRT-engines it (~30 s on Nano). Subsequent runs reuse the cached engine in `~/.cache/...`.

## Run as a service

The `deploy/install-jetson.sh` script installs `homecam-detect.service`. Manual:

```bash
sudo systemctl enable --now homecam-detect.service
journalctl -u homecam-detect.service -f
```

## Tuning

| Env var | Default | What it does |
| ------- | ------- | ------------ |
| `DETECT_SOURCE` | `rtsp://localhost:8554/cam` | jetson-utils `videoSource` URI. Override to point at a different MediaMTX path or a file:// for offline replay. |
| `DETECT_THRESHOLD` | `0.55` | Drop detections below this confidence. Raise to reduce false positives. |
| `DETECT_COOLDOWN_S` | `5.0` | Minimum gap between emitted events for the same camera. |
| `DETECT_MODEL` | `ssd-mobilenet-v2` | Any jetson-inference detectNet model name (`pednet`, `multiped`, `ssd-inception-v2`, …). |
| `DETECT_ACTIVE_FPS` | `5.0` | Max inference rate while a detection happened recently. SSD-MobileNet-v2 will run at ~22 fps if uncapped — that drives the Nano 2GB to thermal throttle without cooling. |
| `DETECT_IDLE_FPS` | `1.0` | Max inference rate when nothing has been detected in `DETECT_IDLE_AFTER_S`. Drops sustained GPU load by ~80 % during nights / empty rooms. |
| `DETECT_IDLE_AFTER_S` | `15.0` | Seconds after the last detection before we shift to idle rate. |
| `DETECT_THUMB_DIR` | `/home/israel/HomeCameraSystem/snapshots` | Where to write per-event JPEG thumbnails. Bind-mounted into the server container so `/snapshots/<file>.jpg` resolves. |
| `DETECT_THUMB_MAX` | `100` | Keep this many most-recent thumbnails. Older ones are pruned on each emit. |
| `DETECT_THUMB_QUALITY` | `70` | JPEG quality 1–100. |
| `EVENT_URL` | `http://127.0.0.1:8000/api/_internal/event` | Where to POST events. |

## Models

`ssd-mobilenet-v2` is the safe default: ~25 fps on Nano 2GB at 640×360, 90 COCO classes. Person ID is 1.

For a "people-only" setup (faster, fewer false positives outdoors), try `pednet` — but it's older and only detects people, no bounding-box class info.

## Calibration

If the worker is too eager (false positives) or too quiet (missed real events), the dials are:

1. **Threshold** — tune `DETECT_THRESHOLD` per-room. A doorbell camera with controlled lighting can use `0.6+`; a yard camera in dappled shade may need `0.45`.
2. **Cooldown** — `DETECT_COOLDOWN_S` controls how often an event fires while a person is in frame. 5 s is doorbell-friendly; lower for a security camera.
3. **Frame rate** — bumping `DETECT_ACTIVE_FPS` to `10` makes detection more responsive but costs CPU/GPU and can push the Nano into thermal throttle (the iter-89 `ThermalGuard` will downshift gear automatically if you hit 80 °C). 5 fps is enough for most camera-cover events (people don't teleport).
