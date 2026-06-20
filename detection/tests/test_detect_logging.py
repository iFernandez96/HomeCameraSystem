"""Pinning tests for the failure-point logging added to detect.py
(docs/logging_plan.md §2 "Detection / events" worker-side bullets).

Scope: every failure point the plan assigns to detect.py must, after the
edit, log WHY it failed at the level the plan specifies and (where a
counter exists) bump the matching `metrics.*` failure-rate counter. The
inference loop's per-frame inner path stays silent — only transition /
throttled / once-flagged lines are emitted.

The detection worker only runs on a Jetson host, so the inference loop
itself is integration-heavy and not exercised here. Instead we pin:
  * the pure decision helpers (`gear_transition`, `apply_config`,
    `top_label_for_log`) directly — no hardware, no logger fixture; and
  * the leaf failure paths that are reachable off-Jetson with the
    jetson SDK mocked (`post_event`, `save_thumb`, `init_face_recognizer`).

Guardrail coverage: a negative test asserts no event payload body /
person_name leaks into the logs, and that the gear-transition line never
repeats when the gear is unchanged (no per-frame logging).

Run from `detection/`:
    /tmp/homecam-venv/bin/python -m pytest tests/test_detect_logging.py -q
"""
import logging
import sys
from pathlib import Path
from unittest.mock import MagicMock

import pytest

# detect.py / metrics.py sit one level up.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

# Mock the host-only Jetson SDK imports BEFORE importing detect, exactly
# as test_capture_recovery.py does — detect.py imports them at module top.
sys.modules.setdefault("jetson_inference", MagicMock())
sys.modules.setdefault("jetson_utils", MagicMock())

import detect  # noqa: E402
from metrics import Metrics  # noqa: E402


# --------------------------------------------------------------------------
# gear_transition: pure decision helper (the "healthy but zero events"
# footgun). Logs ONCE per transition, never when the gear is unchanged.
# --------------------------------------------------------------------------

def test_given_unchanged_gear_when_gear_transition_then_does_not_log():
    # arrange
    prev = "active"
    new = "active"

    # act
    should_log, msg = detect.gear_transition(prev, new)

    # assert — same gear must NOT log (would be per-frame spam).
    assert should_log is False
    assert msg == ""


def test_given_gear_change_to_off_when_gear_transition_then_logs_reason():
    # arrange
    prev = "active"
    new = "off"

    # act
    should_log, msg = detect.gear_transition(prev, new)

    # assert — transition logs and the message carries the WHY so an
    # operator reading the journal knows zero events is intentional.
    assert should_log is True
    assert "active" in msg and "off" in msg
    assert "NO events" in msg


def test_given_first_gear_from_none_when_gear_transition_then_logs():
    # arrange — seed state is None so the FIRST gear is always logged.
    prev = None
    new = "idle"

    # act
    should_log, msg = detect.gear_transition(prev, new)

    # assert
    assert should_log is True
    assert "idle" in msg


# --------------------------------------------------------------------------
# apply_config: per-field cast. One bad field must NOT discard the whole
# update (the plan's "one bad field discards whole update" footgun).
# --------------------------------------------------------------------------

def test_given_clean_config_when_apply_config_then_all_fields_set_no_warnings():
    # arrange
    rt = detect.RuntimeConfig()
    data = {
        "threshold": 0.7,
        "cooldown_s": 3.0,
        "enabled": False,
        "classes": ["Person", "dog"],
    }

    # act
    warnings = detect.apply_config(rt, data)

    # assert
    assert warnings == []
    assert rt.threshold == 0.7
    assert rt.cooldown_s == 3.0
    assert rt.enabled is False
    assert rt.classes == ["person", "dog"]


def test_given_one_bad_field_when_apply_config_then_others_still_apply():
    # arrange — threshold is garbage; cooldown_s + enabled are valid.
    rt = detect.RuntimeConfig(threshold=0.55, cooldown_s=5.0)
    data = {"threshold": "not-a-float", "cooldown_s": 2.0, "enabled": False}

    # act
    warnings = detect.apply_config(rt, data)

    # assert — the bad field is reported and skipped (threshold keeps its
    # old value); the good fields took effect.
    bad_fields = [f for f, _ in warnings]
    assert "threshold" in bad_fields
    assert rt.threshold == 0.55          # unchanged — not discarded-with-update
    assert rt.cooldown_s == 2.0          # still applied
    assert rt.enabled is False           # still applied


def test_given_non_list_classes_when_apply_config_then_warns_and_keeps_old():
    # arrange
    rt = detect.RuntimeConfig()
    rt.classes = ["person"]
    data = {"classes": "person"}  # string, not list

    # act
    warnings = detect.apply_config(rt, data)

    # assert
    assert any(f == "classes" for f, _ in warnings)
    assert rt.classes == ["person"]


# --------------------------------------------------------------------------
# top_label_for_log: best-effort, never raises.
# --------------------------------------------------------------------------

def test_given_empty_kept_when_top_label_for_log_then_returns_placeholder():
    # arrange / act
    label = detect.top_label_for_log([])

    # assert — never KeyError/ValueError on the throttled zone log line.
    assert label == "?"


def test_given_kept_when_top_label_for_log_then_returns_highest_conf_label():
    # arrange
    d_low = MagicMock()
    d_low.Confidence = 0.6
    d_high = MagicMock()
    d_high.Confidence = 0.9
    kept = [(d_low, "dog"), (d_high, "person")]

    # act
    label = detect.top_label_for_log(kept)

    # assert
    assert label == "person"


# --------------------------------------------------------------------------
# post_event: event-POST failure ERROR + bump event_post_failures.
# --------------------------------------------------------------------------

def test_given_post_event_network_reject_when_post_then_errors_and_bumps_counter(
    monkeypatch, caplog,
):
    # arrange — make urlopen raise a transient network error.
    def _boom(*_a, **_k):
        raise OSError("connection refused")

    monkeypatch.setattr(detect.urllib.request, "urlopen", _boom)
    metrics = Metrics()
    payload = {"id": "evt123", "label": "person", "person_name": "Alice"}

    # act
    with caplog.at_level(logging.ERROR, logger="detect"):
        detect.post_event("http://127.0.0.1:8000/api/_internal/event",
                           payload, metrics=metrics)

    # assert — ERROR fired naming the lost event id; counter bumped.
    errs = [r for r in caplog.records if r.levelno == logging.ERROR]
    assert len(errs) == 1
    assert "evt123" in errs[0].getMessage()
    assert "LOST" in errs[0].getMessage()
    assert metrics.event_post_failures == 1


def test_given_post_event_failure_when_post_then_no_payload_body_leaks(
    monkeypatch, caplog,
):
    # arrange — guardrail: the person_name / thumb_url PII must not leak
    # into the log line (only the event id is safe).
    def _boom(*_a, **_k):
        raise OSError("down")

    monkeypatch.setattr(detect.urllib.request, "urlopen", _boom)
    metrics = Metrics()
    payload = {
        "id": "evt999",
        "person_name": "SecretPerson",
        "thumb_url": "/snapshots/thumb_1.jpg",
    }

    # act
    with caplog.at_level(logging.ERROR, logger="detect"):
        detect.post_event("http://127.0.0.1:8000/api/_internal/event",
                           payload, metrics=metrics)

    # assert
    blob = " ".join(r.getMessage() for r in caplog.records)
    assert "SecretPerson" not in blob
    assert "thumb_1.jpg" not in blob


def test_given_post_event_http_error_when_post_then_logs_status_and_bumps(
    monkeypatch, caplog,
):
    # arrange — a 422 (permanent schema drift) HTTPError.
    import urllib.error

    def _http_err(*_a, **_k):
        raise urllib.error.HTTPError(
            "http://x", 422, "Unprocessable", {}, None,
        )

    monkeypatch.setattr(detect.urllib.request, "urlopen", _http_err)
    metrics = Metrics()

    # act
    with caplog.at_level(logging.ERROR, logger="detect"):
        detect.post_event("http://127.0.0.1:8000/api/_internal/event",
                           {"id": "e1"}, metrics=metrics)

    # assert — status code is in the line; counter bumped.
    errs = [r for r in caplog.records if r.levelno == logging.ERROR]
    assert errs and "422" in errs[0].getMessage()
    assert metrics.event_post_failures == 1


# --------------------------------------------------------------------------
# save_thumb: failure -> ERROR naming the dir; returns None.
# --------------------------------------------------------------------------

def test_given_save_image_raises_when_save_thumb_then_errors_and_returns_none(
    monkeypatch, caplog,
):
    # arrange — saveImage blows up (disk full / RO mount / bad extension).
    monkeypatch.setattr(detect.os, "makedirs", lambda *a, **k: None)
    monkeypatch.setattr(
        detect.jetson_utils, "saveImage",
        MagicMock(side_effect=OSError("No space left on device")),
    )

    # act
    with caplog.at_level(logging.ERROR, logger="detect"):
        url = detect.save_thumb(
            object(), 1000.0, "/some/thumb/dir", 100, 70,
        )

    # assert — None return (caller omits thumb_url) + ERROR names the dir.
    assert url is None
    errs = [r for r in caplog.records if r.levelno == logging.ERROR]
    assert errs and "/some/thumb/dir" in errs[0].getMessage()


# --------------------------------------------------------------------------
# init_face_recognizer: import-disable site logs WARNING.
# --------------------------------------------------------------------------

def test_given_no_face_wrapper_when_init_recognizer_then_warns_and_returns_none(
    monkeypatch, caplog,
):
    # arrange — simulate mode 3 (wrapper module missing).
    monkeypatch.setattr(detect, "FaceRecognizer", None)

    # act
    with caplog.at_level(logging.WARNING, logger="detect"):
        rec = detect.init_face_recognizer()

    # assert
    assert rec is None
    warns = [r for r in caplog.records if r.levelno == logging.WARNING]
    assert warns and "disabled" in warns[0].getMessage()
