"""Worker slice of docs/multicam_contract.md (camera dimension).

Pins two things:
  * the pure env resolution (`camera_ident.resolve_camera_id` /
    `camera_id_from_env`): default `front_door`, valid override wins,
    invalid value WARNs (operation + reason) and falls back — never
    crashes the worker at boot; and
  * the wire shape: the event payload the worker POSTs to
    `/api/_internal/event` carries `"camera_id"` for both the default
    and the env-override case (mirror of the server-side
    `test_internal.py` camera_id pins, per the wire-contract-sync rule).

The Jetson SDK is stubbed at the import boundary exactly as
test_capture_recovery.py does; the payload-building logic under test is
the real `detect._build_visit_runner` wiring, not a mock.

Run from `detection/`:
    /tmp/homecam-venv/bin/python -m pytest tests/test_camera_ident.py -q
"""
import logging
import sys
from pathlib import Path
from unittest.mock import MagicMock

# camera_ident.py / detect.py sit one level up.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

# Mock the host-only Jetson SDK imports BEFORE importing detect —
# detect.py imports them at module top. Never mock the decision logic.
sys.modules.setdefault("jetson_inference", MagicMock())
sys.modules.setdefault("jetson_utils", MagicMock())

import camera_ident  # noqa: E402
import detect  # noqa: E402


# --------------------------------------------------------------------------
# Pure resolution: default / override / invalid-fallback. No hardware.
# --------------------------------------------------------------------------

def test_given_env_unset_when_resolving_then_default_front_door():
    # arrange — an environ with no DETECT_CAMERA_ID at all.
    environ = {}

    # act
    resolved = camera_ident.camera_id_from_env(environ)

    # assert — contract default, matching the server-side payload default.
    assert resolved == "front_door"


def test_given_valid_override_when_resolving_then_override_wins():
    # arrange
    environ = {"DETECT_CAMERA_ID": "backyard_2"}

    # act
    resolved = camera_ident.camera_id_from_env(environ)

    # assert
    assert resolved == "backyard_2"


def test_given_empty_string_when_resolving_then_default_without_warning(
    caplog,
):
    # arrange — empty string is "unset", the normal single-camera deploy.
    caplog.set_level(logging.WARNING, logger="camera_ident")

    # act
    resolved = camera_ident.resolve_camera_id("")

    # assert — silent fallback: nothing to warn an operator about.
    assert resolved == "front_door"
    assert caplog.records == []


def test_given_invalid_chars_when_resolving_then_warns_and_falls_back(
    caplog,
):
    # arrange — uppercase + hyphen both violate ^[a-z0-9_]{1,32}$.
    caplog.set_level(logging.WARNING, logger="camera_ident")

    # act
    resolved = camera_ident.resolve_camera_id("Front-Door")

    # assert — falls back (never crashes) and the WARN names the
    # operation, the rejected value, and the reason (the pattern).
    assert resolved == "front_door"
    warnings = [r for r in caplog.records if r.levelno == logging.WARNING]
    assert len(warnings) == 1
    message = warnings[0].getMessage()
    assert "camera_id resolve" in message
    assert "Front-Door" in message
    assert "[a-z0-9_]{1,32}" in message


def test_given_33_char_id_when_resolving_then_warns_and_falls_back(caplog):
    # arrange — one char past the 32-char contract cap.
    caplog.set_level(logging.WARNING, logger="camera_ident")
    too_long = "a" * 33

    # act
    resolved = camera_ident.resolve_camera_id(too_long)

    # assert
    assert resolved == "front_door"
    assert any(
        r.levelno == logging.WARNING for r in caplog.records
    )


def test_given_32_char_id_when_resolving_then_accepted():
    # arrange — exactly at the cap: valid.
    at_cap = "a" * 32

    # act
    resolved = camera_ident.resolve_camera_id(at_cap)

    # assert
    assert resolved == at_cap


# --------------------------------------------------------------------------
# Wire shape: the POSTed event payload carries camera_id. Exercises the
# real `_build_visit_runner` open-event path with post_event captured.
# --------------------------------------------------------------------------

def _open_event_payload(monkeypatch, tmp_path):
    """Build the visit runner exactly as main() does (camera_id from the
    ambient env) and capture the payload its open-event POST would send."""
    captured = []
    monkeypatch.setattr(
        detect, "post_event",
        lambda url, payload, **kwargs: captured.append(payload),
    )
    runner = detect._build_visit_runner(
        str(tmp_path),
        MagicMock(),  # clip_recorder — only touched by finalize, not here
        None,         # preroll_buffer — None = preroll disabled
        "http://127.0.0.1:8000/api/_internal/event",
        camera_ident.camera_id_from_env(),
    )
    boxes = [{"label": "person", "score": 0.9,
              "x1": 0.1, "y1": 0.1, "x2": 0.5, "y2": 0.5}]
    runner._post_event("visit-1", "person:test", 1000.0, boxes)
    assert len(captured) == 1, "open event was not POSTed"
    return captured[0]


def test_given_env_unset_when_event_posted_then_payload_has_default_camera_id(
    monkeypatch, tmp_path,
):
    # arrange
    monkeypatch.delenv("DETECT_CAMERA_ID", raising=False)

    # act
    payload = _open_event_payload(monkeypatch, tmp_path)

    # assert — the wire pin: camera_id present, contract default.
    assert payload["camera_id"] == "front_door"
    assert payload["visit_id"] == payload["id"]


def test_given_env_override_when_event_posted_then_payload_has_override(
    monkeypatch, tmp_path,
):
    # arrange
    monkeypatch.setenv("DETECT_CAMERA_ID", "garage")

    # act
    payload = _open_event_payload(monkeypatch, tmp_path)

    # assert
    assert payload["camera_id"] == "garage"


# --------------------------------------------------------------------------
# Continuation marker (2026-07-07): a cap-split continuation open
# (segment_index > 0) marks its payload so the server suppresses the push;
# a first open (segment_index 0) must NOT carry the key at all.
# --------------------------------------------------------------------------

def _open_event_payload_with_segment(monkeypatch, tmp_path, segment_index,
                                     root_visit_id=None):
    captured = []
    monkeypatch.setattr(
        detect, "post_event",
        lambda url, payload, **kwargs: captured.append(payload),
    )
    runner = detect._build_visit_runner(
        str(tmp_path), MagicMock(), None,
        "http://127.0.0.1:8000/api/_internal/event",
        camera_ident.camera_id_from_env(),
    )
    boxes = [{"label": "person", "score": 0.9,
              "x1": 0.1, "y1": 0.1, "x2": 0.5, "y2": 0.5}]
    event_id = "visit-1" if segment_index == 0 else "visit-2"
    runner._post_event(
        event_id, "person:test", 1000.0, boxes, segment_index,
        root_visit_id=root_visit_id,
    )
    assert len(captured) == 1
    return captured[0]


def test_given_first_open_when_event_posted_then_no_continuation_key(
    monkeypatch, tmp_path,
):
    # arrange / act
    payload = _open_event_payload_with_segment(monkeypatch, tmp_path, 0)

    # assert — absent, not False: the server default covers it and the
    # wire stays byte-identical to pre-continuation workers.
    assert "continuation" not in payload


def test_given_cap_split_open_when_event_posted_then_continuation_true(
    monkeypatch, tmp_path,
):
    # arrange / act
    payload = _open_event_payload_with_segment(
        monkeypatch, tmp_path, 1, root_visit_id="visit-1",
    )

    # assert
    assert payload["continuation"] is True
    assert payload["id"] == "visit-2"
    assert payload["visit_id"] == "visit-1"


def test_visit_open_enrichment_adds_names_once_without_duplicate_visit(monkeypatch, tmp_path):
    captured = []
    prepared = []
    monkeypatch.setattr(
        detect, "post_event",
        lambda _url, payload, **_kwargs: captured.append(payload),
    )

    def prepare(visit_id, key, start_ts, boxes, cuda_img, segment_index):
        prepared.append((visit_id, key, segment_index, cuda_img))
        return {"person_name": "Alice", "person_names": ["Alice", "Bob"]}

    runner = detect._build_visit_runner(
        str(tmp_path), MagicMock(), None,
        "http://127.0.0.1:8000/api/_internal/event",
        "front_door", prepare_open_event=prepare,
    )
    runner._free_space = lambda _path: 10 ** 12
    boxes = [{
        "label": "person", "score": 0.9,
        "x": 0.1, "y": 0.1, "w": 0.4, "h": 0.6,
    }]
    runner.observe(
        "person:front_door", (10, 10, 50, 70), 100.0, 0.0, 10.0, 150.0,
        boxes=boxes, cuda_img=object(),
    )
    runner.observe(
        "person:front_door", (11, 10, 51, 70), 101.0, 0.0, 10.0, 150.0,
        boxes=boxes, cuda_img=object(),
    )

    assert len(prepared) == 1
    assert len(captured) == 1
    assert captured[0]["person_name"] == "Alice"
    assert captured[0]["person_names"] == ["Alice", "Bob"]


def test_given_invalid_env_when_event_posted_then_payload_falls_back(
    monkeypatch, tmp_path,
):
    # arrange — invalid id must degrade to the default on the wire, not
    # 422 at the server or crash the worker.
    monkeypatch.setenv("DETECT_CAMERA_ID", "NOT VALID!")

    # act
    payload = _open_event_payload(monkeypatch, tmp_path)

    # assert
    assert payload["camera_id"] == "front_door"
