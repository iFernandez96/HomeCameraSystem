#!/usr/bin/env python3
"""Diff active vs shadow presence decisions in a decision.jsonl file.

Reads production ledger rows, splits ``tag=presence`` active rows from
``shadow=true`` rows, aligns by timestamp window, and prints machine-readable
JSON. Exit status is 1 when any aligned decision disagrees or one side is
missing.
"""
import argparse
import json
import sys


DEFAULT_WINDOW_S = 0.25


def _load_jsonl(path):
    rows = []
    with open(path) as f:
        for line_no, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except ValueError as e:
                raise ValueError(
                    "{}:{} invalid JSON: {}".format(path, line_no, e)
                )
    return rows


def _presence_rows(rows, shadow):
    out = []
    for row in rows:
        if row.get("tag") != "presence":
            continue
        if bool(row.get("shadow")) != bool(shadow):
            continue
        out.append(row)
    return out


def _project(row):
    if row is None:
        return None
    return {
        "transition": row.get("transition"),
        "reason": row.get("reason"),
        "key": row.get("key"),
        "emit": bool(row.get("emit")),
    }


def _find_nearest(row, candidates, used, window_s):
    best_idx = None
    best_delta = None
    try:
        row_ts = float(row.get("ts"))
    except (TypeError, ValueError):
        row_ts = 0.0
    for idx, candidate in enumerate(candidates):
        if idx in used:
            continue
        try:
            candidate_ts = float(candidate.get("ts"))
        except (TypeError, ValueError):
            continue
        delta = abs(candidate_ts - row_ts)
        if delta > window_s:
            continue
        if best_delta is None or delta < best_delta:
            best_idx = idx
            best_delta = delta
    return best_idx


def diff_rows(rows, window_s=DEFAULT_WINDOW_S):
    active = _presence_rows(rows, False)
    shadow = _presence_rows(rows, True)
    used_shadow = set()
    agreements = 0
    disagreements = []

    for active_row in active:
        idx = _find_nearest(active_row, shadow, used_shadow, window_s)
        if idx is None:
            disagreements.append({
                "ts": active_row.get("ts"),
                "active": _project(active_row),
                "shadow": None,
            })
            continue
        used_shadow.add(idx)
        shadow_row = shadow[idx]
        active_decision = _project(active_row)
        shadow_decision = _project(shadow_row)
        if active_decision == shadow_decision:
            agreements += 1
        else:
            disagreements.append({
                "ts": active_row.get("ts"),
                "active": active_decision,
                "shadow": shadow_decision,
            })

    for idx, shadow_row in enumerate(shadow):
        if idx in used_shadow:
            continue
        disagreements.append({
            "ts": shadow_row.get("ts"),
            "active": None,
            "shadow": _project(shadow_row),
        })

    return {
        "agreements": agreements,
        "disagreements": disagreements,
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("decision_jsonl")
    parser.add_argument(
        "--window-s", type=float, default=DEFAULT_WINDOW_S,
        help="timestamp alignment window in seconds",
    )
    args = parser.parse_args(argv)
    result = diff_rows(_load_jsonl(args.decision_jsonl), args.window_s)
    print(json.dumps(result, sort_keys=True, separators=(",", ":")))
    if result["disagreements"]:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
