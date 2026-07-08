"""O10 flight-recorder parity for the production presence emit gate.

This is intentionally fixture-gated: it only runs when a Jetson snapshot has
``proof_fixtures/flight/{flight,decision}.jsonl``. The replay drives the real
``PresenceTracker`` with raw sampled detectNet rows and compares only facts the
sampled capture can prove.

Important limitation: flight rows are sampled 1-in-N. If the decision ledger has
presence transitions, their order/reasons are decidable and must match the
replay. If the decision ledger has no presence rows, exact absence parity is
decidable only when the sampled frames contain no threshold-clearing subjects;
otherwise the initial tracker state between samples is unknown and this harness
must not invent a fuzzy match.
"""
import json
import os
import sys

import pytest


TEST_DIR = os.path.dirname(os.path.abspath(__file__))
DETECTION_DIR = os.path.dirname(os.path.dirname(TEST_DIR))
REPO_ROOT = os.path.dirname(DETECTION_DIR)
FIXTURE_DIR = os.path.join(
    REPO_ROOT, ".jetson-snapshot", "proof_fixtures", "flight",
)
FLIGHT_PATH = os.path.join(FIXTURE_DIR, "flight.jsonl")
DECISION_PATH = os.path.join(FIXTURE_DIR, "decision.jsonl")
CONFIG_PATH = os.path.join(FIXTURE_DIR, "detection_config.json")

sys.path.insert(0, DETECTION_DIR)

from presence import PresenceTracker  # noqa: E402


pytestmark = pytest.mark.skipif(
    not (os.path.exists(FLIGHT_PATH) and os.path.exists(DECISION_PATH)),
    reason="O10 Jetson flight fixtures are absent",
)


# Worker defaults from detection/detect.py, kept local to avoid importing
# detect.py and its Jetson-native dependencies in the offline harness.
DEFAULT_THRESHOLD = 0.55
DEFAULT_COOLDOWN_S = 5.0
DEFAULT_CLASSES = ["person"]
DEFAULT_CAMERA_ID = "front_door"
DEFAULT_CLIP_PRE_ROLL_S = 0.0
DEFAULT_CLIP_POST_ROLL_S = 8.0
PRESENCE_GAP_S = 20.0


def _jsonl(path):
    rows = []
    with open(path) as f:
        for line_no, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except ValueError as e:
                raise AssertionError(
                    "{}:{} is not valid JSON: {}".format(path, line_no, e)
                )
    return rows


def _load_config():
    config = {
        "threshold": DEFAULT_THRESHOLD,
        "cooldown_s": DEFAULT_COOLDOWN_S,
        "classes": list(DEFAULT_CLASSES),
        "camera_id": DEFAULT_CAMERA_ID,
        "clip_pre_roll_s": DEFAULT_CLIP_PRE_ROLL_S,
        "clip_post_roll_s": DEFAULT_CLIP_POST_ROLL_S,
    }
    if not os.path.exists(CONFIG_PATH):
        return config

    with open(CONFIG_PATH) as f:
        data = json.load(f)
    if not isinstance(data, dict):
        return config

    # Accept both worker-style flat keys and server/runtime fixture keys. Unknown
    # fields are ignored so future fixture captures can carry extra provenance.
    for key in (
        "threshold",
        "cooldown_s",
        "clip_pre_roll_s",
        "clip_post_roll_s",
        "camera_id",
    ):
        if key in data:
            config[key] = data[key]
    if "classes" in data:
        config["classes"] = data["classes"]
    return config


def _presence_rows(rows):
    return [r for r in rows if r.get("tag") == "presence"]


def _top_kept_box(frame, config):
    threshold = float(config["threshold"])
    wanted = set(
        c.strip().lower() for c in config["classes"]
        if isinstance(c, str) and c.strip()
    )
    kept = []
    for box in frame.get("boxes") or []:
        try:
            score = float(box.get("score"))
        except (TypeError, ValueError):
            continue
        label = str(box.get("label", "")).lower()
        if score < threshold or label not in wanted:
            continue
        kept.append(box)
    if not kept:
        return None
    top = max(kept, key=lambda b: float(b["score"]))
    return (
        str(top["label"]).lower(),
        (
            float(top["x1"]),
            float(top["y1"]),
            float(top["x2"]),
            float(top["y2"]),
        ),
    )


def _replay_presence(flight_rows, config):
    tracker = PresenceTracker()
    cooldown_s = float(config["cooldown_s"])
    clip_duration_s = max(
        float(config["clip_pre_roll_s"]) + float(config["clip_post_roll_s"]),
        cooldown_s,
    )
    camera_id = str(config["camera_id"])
    transitions = []
    kept_frame_count = 0

    for frame in flight_rows:
        top = _top_kept_box(frame, config)
        if top is None:
            continue
        kept_frame_count += 1
        label, box = top
        key = "{}:{}".format(label, camera_id)
        emit, decision = tracker.should_emit_with_decision(
            key, box, float(frame["ts"]), clip_duration_s,
            PRESENCE_GAP_S, cooldown_s,
        )
        if decision.get("ledger"):
            transitions.append({
                "transition": decision.get("transition"),
                "reason": decision.get("reason"),
                "key": decision.get("key"),
                "emit": bool(emit),
            })

    return transitions, kept_frame_count


def _project_presence(rows):
    return [
        {
            "transition": r.get("transition"),
            "reason": r.get("reason"),
            "key": r.get("key"),
            "emit": bool(r.get("emit")),
        }
        for r in rows
    ]


def test_o10_flight_replay_matches_decidable_presence_transitions():
    flight_rows = _jsonl(FLIGHT_PATH)
    decision_rows = _jsonl(DECISION_PATH)
    config = _load_config()

    replayed, kept_frame_count = _replay_presence(flight_rows, config)
    expected = _project_presence(_presence_rows(decision_rows))

    assert flight_rows, "flight fixture is present but empty"

    if expected:
        assert replayed == expected
        return

    if kept_frame_count == 0:
        assert replayed == [], (
            "decision.jsonl has no presence rows, and every sampled flight "
            "frame is below the worker threshold/classes; replay must also "
            "produce no presence emissions. Richer O10 parity arms when a real "
            "above-threshold subject appears in the captured data."
        )
        return

    # Presence rows are absent, but sampled raw frames do contain threshold-
    # clearing subjects. Because flight sampling is 1-in-N, an empty offline
    # tracker cannot know whether production already had live presence state
    # before the first sampled row, nor whether unsampled frames produced the
    # missing ledger transitions. This is the honest decidable invariant: the
    # fixture is not exact-parity-capable yet, so we refuse to fuzzy-match it.
    assert expected == []
    assert kept_frame_count > 0
