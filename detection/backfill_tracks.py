#!/usr/bin/env python3
"""Backfill bbox track sidecars from flight logs for existing clips.

Continuous-capture clips recorded before the sidecar wiring fix only have the
event's trigger-frame boxes. This utility reconstructs best-effort
`<event_id>.tracks.json` files from `recordings/flight.jsonl*`.

Python 3.6-compatible: this runs on the Jetson host.
"""
import argparse
import json
import os
import sqlite3
import subprocess

import tracks


FRAME_W = 1280.0
FRAME_H = 720.0


def _duration_s(path):
    try:
        out = subprocess.check_output(
            [
                "ffprobe",
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "default=noprint_wrappers=1:nokey=1",
                path,
            ],
            stderr=subprocess.STDOUT,
        )
        return max(0.0, float(out.decode("utf-8", "replace").strip()))
    except Exception:
        return 45.0


def _load_flight_samples(paths):
    samples = []
    for path in paths:
        if not os.path.exists(path):
            continue
        with open(path, "r") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    rec = json.loads(line)
                except ValueError:
                    continue
                if rec.get("tag") != "flight":
                    continue
                ts = rec.get("ts")
                boxes = rec.get("boxes")
                if ts is None or not isinstance(boxes, list):
                    continue
                samples.append((float(ts), boxes))
    samples.sort(key=lambda row: row[0])
    return samples


def _norm_box(box):
    label = str(box.get("label", "")).lower()
    score = float(box.get("score", 0.0))
    x1 = max(0.0, min(FRAME_W, float(box.get("x1", 0.0))))
    x2 = max(0.0, min(FRAME_W, float(box.get("x2", 0.0))))
    y1 = max(0.0, min(FRAME_H, float(box.get("y1", 0.0))))
    y2 = max(0.0, min(FRAME_H, float(box.get("y2", 0.0))))
    if x2 <= x1 or y2 <= y1:
        return None
    return {
        "x": x1 / FRAME_W,
        "y": y1 / FRAME_H,
        "w": (x2 - x1) / FRAME_W,
        "h": (y2 - y1) / FRAME_H,
        "label": label,
        "score": score,
    }


def _wanted_labels(boxes_json):
    try:
        boxes = json.loads(boxes_json or "[]")
    except ValueError:
        boxes = []
    labels = set()
    for box in boxes:
        label = str(box.get("label", "")).lower()
        if label:
            labels.add(label)
    return labels or set(["person"])


def _events(db_path, limit, event_id=None):
    con = sqlite3.connect(db_path)
    con.row_factory = sqlite3.Row
    if event_id:
        query = (
            "select id, ts, clip_url, boxes_json from events "
            "where id = ? and clip_url is not null"
        )
        return list(con.execute(query, (event_id,)))
    query = (
        "select id, ts, clip_url, boxes_json from events "
        "where clip_url is not null order by ts desc limit ?"
    )
    return list(con.execute(query, (limit,)))


def backfill(db_path, recordings_dir, limit, force, event_id=None):
    flight_paths = [
        os.path.join(recordings_dir, "flight.jsonl.1"),
        os.path.join(recordings_dir, "flight.jsonl"),
    ]
    flight = _load_flight_samples(flight_paths)
    written = 0
    skipped = 0
    for ev in _events(db_path, limit, event_id=event_id):
        event_id = ev["id"]
        mp4_path = os.path.join(recordings_dir, event_id + ".mp4")
        sidecar_path = os.path.join(recordings_dir, event_id + ".tracks.json")
        if not os.path.exists(mp4_path):
            skipped += 1
            continue
        if os.path.exists(sidecar_path) and not force:
            skipped += 1
            continue
        start_ts = float(ev["ts"])
        duration = _duration_s(mp4_path)
        labels = _wanted_labels(ev["boxes_json"])
        rows = []
        for sample_ts, raw_boxes in flight:
            if sample_ts < start_ts or sample_ts > start_ts + duration:
                continue
            boxes = []
            for raw in raw_boxes:
                norm = _norm_box(raw)
                if norm is None:
                    continue
                if norm["label"] not in labels:
                    continue
                if norm["score"] < 0.20:
                    continue
                boxes.append(norm)
            rows.append((sample_ts, boxes))
        if not rows:
            skipped += 1
            continue
        payload = tracks.build_payload(event_id, start_ts, 0.0, duration, rows)
        if tracks.write_sidecar(recordings_dir, event_id, payload):
            written += 1
        else:
            skipped += 1
    return written, skipped


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", default="/app/secrets/events.db")
    parser.add_argument("--recordings-dir", default="/app/recordings")
    parser.add_argument("--limit", type=int, default=300)
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--event-id")
    args = parser.parse_args()
    written, skipped = backfill(
        args.db, args.recordings_dir, args.limit, args.force,
        event_id=args.event_id,
    )
    print("backfill complete: written={} skipped={}".format(written, skipped))


if __name__ == "__main__":
    main()
