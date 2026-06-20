"""Per-event bbox-track sidecar (iter-356.53, Feature #1 follow-up).

The iter-202+iter-324 ClipRecorder writes a single MP4 per detection
event. The browser-side bbox overlay (iter-356.44) draws the trigger
frame's boxes statically for the whole clip duration — fine for a
single-moment event, wrong for any clip that captures movement.

This module is the worker-side write path for a JSON sidecar that
stores a sequence of `(ts_offset_s, boxes)` samples spanning pre-roll
+ post-roll. The client reads the sidecar in `ClipModal` and draws
the closest-in-time sample on every `<video>` `timeupdate`, so the
bbox follows the object as it moves.

Wire shape (matches design brief iter-356.53):
    {
      "v": 1,
      "event_id": "<id>",
      "pre_roll_s": 3.0,
      "post_roll_s": 7.0,
      "samples": [
        {"ts_offset_s": 0.05, "boxes": [{"x":..,"y":..,"w":..,"h":..,"label":..,"score":..}, ...]},
        ...
      ]
    }

`samples` ascending by `ts_offset_s`. `ts_offset_s` is wall-clock
seconds from clip start (= `event_ts - pre_roll_s`).

Pure stdlib, Python-3.6 compatible — runs on the Jetson host where
detect.py imports this module. No future-import annotations, no
PEP-604 unions, no walrus, no match.
"""
import json
import os
import re

import applog


# Mirror of `recording_service._VALID_EVENT_ID` and the iter-202
# ClipRecorder's filename guard. Keep these regexes aligned — the
# server resolves `recordings/<event_id>.tracks.json` against the
# same charset and a drift between sides becomes a quiet 404.
_VALID_EVENT_ID_RE = re.compile(r"^[A-Za-z0-9_-]+$")

# Hard cap on samples per sidecar. At default 5 fps active inference
# × 10 s clip → 50 samples. The cap protects worst-case (high-fps
# active mode + 30-min week-preset clip). 5000 samples ≈ ~2 MB JSON
# uncompressed — well below disk-budget threshold per event.
SAMPLE_CAP = 5000


def build_payload(event_id, event_ts, pre_roll_s, post_roll_s, samples):
    """Build the sidecar payload dict.

    `samples` is a list of `(frame_ts, boxes)` tuples in arbitrary
    order; this function sorts ascending by `ts_offset_s` (computed
    as `frame_ts - clip_start`) and clamps to `SAMPLE_CAP` (every Mth
    sample retained). Empty `samples` is legal — represents "track
    recorded but every frame had zero detections."

    `boxes` reuses the iter-95 server `Box` shape: dicts with x/y/w/h
    in [0, 1] + label + score. Worker passes through whatever
    `box_norm.normalize_box` produced for the emit path so geometry
    is bitwise identical to `event.boxes`.
    """
    if pre_roll_s < 0:
        pre_roll_s = 0.0
    if post_roll_s < 0:
        post_roll_s = 0.0
    clip_start = float(event_ts) - float(pre_roll_s)
    rendered = []
    for frame_ts, boxes in samples:
        offset = float(frame_ts) - clip_start
        # Drop samples outside the clip window (defensive — caller
        # should already filter, but a stale deque entry shouldn't
        # corrupt the sidecar).
        if offset < 0 or offset > pre_roll_s + post_roll_s + 1.0:
            continue
        rendered.append({
            "ts_offset_s": round(offset, 3),
            "boxes": list(boxes) if boxes else [],
        })
    rendered.sort(key=lambda s: s["ts_offset_s"])
    if len(rendered) > SAMPLE_CAP:
        # Sub-sample uniformly to exactly SAMPLE_CAP entries via
        # integer index arithmetic (FP accumulation overshoots by 1
        # at the 1.2 step + 5000-iter scale). Keep first + last so
        # playback ends don't drift visually.
        n = len(rendered)
        kept = [rendered[(i * (n - 1)) // (SAMPLE_CAP - 1)] for i in range(SAMPLE_CAP)]
        rendered = kept
    return {
        "v": 1,
        "event_id": event_id,
        "pre_roll_s": float(pre_roll_s),
        "post_roll_s": float(post_roll_s),
        "samples": rendered,
    }


def write_sidecar(recordings_dir, event_id, payload):
    """Write `<recordings_dir>/<event_id>.tracks.json` atomically.

    Returns True on success, False on validation/IO failure (caller
    treats as best-effort). `tmp + os.rename` mirrors the iter-350
    G2 atomic-rename merge in `recording.py` so a concurrent reader
    (`/api/events/<id>/tracks`) sees either nothing or the complete
    JSON, never a half-written file.
    """
    if not event_id or not _VALID_EVENT_ID_RE.match(event_id):
        # Charset reject: a worker/server drift in the event_id rules
        # surfaces here as a quiet /tracks 404 (the server resolves the
        # sidecar against the same regex). Name the offending id so the
        # drift is greppable rather than invisible.
        applog.emit(
            "tracks",
            "write_sidecar rejected event_id=%r (failed charset "
            "%s) - sidecar NOT written, clip falls back to static "
            "overlay" % (event_id, _VALID_EVENT_ID_RE.pattern),
        )
        return False
    final_path = os.path.join(
        recordings_dir, "{}.tracks.json".format(event_id),
    )
    tmp_path = final_path + ".tmp"
    try:
        os.makedirs(recordings_dir, exist_ok=True)
        # `separators=(",", ":")` shaves ~30% off the file size for
        # large sample arrays without losing fidelity. The client's
        # JSON.parse accepts compact form identically.
        encoded = json.dumps(payload, separators=(",", ":"))
        with open(tmp_path, "w") as f:
            f.write(encoded)
            f.flush()
            os.fsync(f.fileno())
        os.rename(tmp_path, final_path)
        return True
    except (OSError, IOError, ValueError, TypeError) as e:
        # Fail-quiet for the caller (the merge thread + clip MP4 are
        # independent; a missing sidecar just means the client falls
        # back to the static `event.boxes` overlay, same code path as
        # legacy clips pre-iter-356.53). But this False return was
        # previously swallowed with no caller try/except, so the
        # degrade was invisible. Log WHY at the False site: the
        # operation, the express reason (exc type + text), and the
        # event_id so the degraded clip is identifiable.
        applog.emit(
            "tracks",
            "write_sidecar failed for event_id=%s at %s: %s: %s - "
            "sidecar NOT written, clip degrades to static overlay"
            % (event_id, final_path, type(e).__name__, e),
        )
        # Defense-in-depth: clean up any half-written tmp.
        try:
            if os.path.exists(tmp_path):
                os.remove(tmp_path)
        except OSError:
            pass
        return False
