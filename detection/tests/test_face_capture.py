"""iter-351: pin save_face_capture behavior. Pure file-IO tests; no
PIL / face_recognition dependency. The helper is the load-bearing
piece for the operator's "sort + retrain" workflow.
"""
import os
import sys

import pytest

# Add detection/ to sys.path so `face_recog.capture` import resolves
# (detection/ has no __init__.py per CLAUDE.md sharp edge — modules
# are discovered via PYTHONPATH not package import).
_HERE = os.path.dirname(os.path.abspath(__file__))
_DETECT_DIR = os.path.dirname(_HERE)
if _DETECT_DIR not in sys.path:
    sys.path.insert(0, _DETECT_DIR)

from face_recog.capture import (  # noqa: E402
    _sanitize_name,
    save_face_capture,
)


def test_when_name_has_safe_chars_then_sanitize_lowercases(tmp_path):
    # arrange / act
    out = _sanitize_name("Alice")

    # assert
    assert out == "alice"


def test_when_name_has_unsafe_chars_then_sanitize_replaces_with_underscore():
    # arrange (iter-351: defensive against a future training script
    # that accepts arbitrary input — re-sanitize at write time).

    # act
    out = _sanitize_name("Mary Jane!")

    # assert — space + ! → _, then strip trailing _.
    assert out == "mary_jane"


def test_when_name_is_empty_or_none_then_sanitize_falls_back_to_unknown():
    # arrange / act / assert
    assert _sanitize_name(None) == "__unknown__"
    assert _sanitize_name("") == "__unknown__"
    assert _sanitize_name("!!!") == "__unknown__"


def test_when_save_face_capture_called_then_writes_jpeg_to_named_dir(tmp_path):
    # arrange (iter-351 happy path)
    capture_dir = str(tmp_path / "captures")
    fake_jpeg = b"\xff\xd8\xff\xe0FAKE_JPEG"

    # act
    written = save_face_capture(
        capture_dir=capture_dir,
        name="Alice",
        event_id="evt-001",
        ts_ms=1700000000000,
        jpeg_bytes=fake_jpeg,
    )

    # assert
    assert written is not None
    assert os.path.exists(written)
    with open(written, "rb") as f:
        assert f.read() == fake_jpeg
    # Path under sanitized name dir, sortable filename.
    assert "/alice/" in written
    assert written.endswith("1700000000000_evt-001.jpg")


def test_given_no_match_when_save_face_capture_called_then_writes_to_unknown_dir(
    tmp_path,
):
    # arrange — recognizer returns None for unknown faces.
    capture_dir = str(tmp_path / "captures")

    # act
    written = save_face_capture(
        capture_dir=capture_dir,
        name=None,
        event_id="evt-002",
        ts_ms=1700000060000,
        jpeg_bytes=b"\xff\xd8\xff\xe0unknown",
    )

    # assert
    assert written is not None
    assert "/__unknown__/" in written


def test_given_empty_jpeg_bytes_when_save_called_then_returns_none_no_file(
    tmp_path,
):
    # arrange — empty payload should noop, not write a 0-byte file.
    capture_dir = str(tmp_path / "captures")

    # act
    written = save_face_capture(
        capture_dir=capture_dir,
        name="alice",
        event_id="evt-003",
        ts_ms=1700000000000,
        jpeg_bytes=b"",
    )

    # assert
    assert written is None
    assert not (tmp_path / "captures" / "alice").exists()


def test_when_capture_dir_missing_then_save_face_capture_creates_it(tmp_path):
    # arrange — fresh tmp_path; capture_dir doesn't exist yet.
    capture_dir = str(tmp_path / "fresh_captures")

    # act
    written = save_face_capture(
        capture_dir=capture_dir,
        name="bob",
        event_id="evt-mkdir",
        ts_ms=1700000000000,
        jpeg_bytes=b"\xff\xd8\xff\xe0bytes",
    )

    # assert
    assert written is not None
    assert os.path.exists(os.path.join(capture_dir, "bob"))


def test_given_dir_at_cap_when_save_face_capture_called_then_oldest_evicted(
    tmp_path,
):
    # arrange — pre-fill alice/ with cap+1 entries via the helper.
    # Then sleep just enough for mtime to differ (filesystem mtime
    # resolution is ~1 ns on ext4 but to be safe we use explicit
    # os.utime to set distinct mtimes).
    capture_dir = str(tmp_path / "captures")
    cap = 3
    # Pre-write 3 entries with distinct mtimes (1, 2, 3).
    alice_dir = os.path.join(capture_dir, "alice")
    os.makedirs(alice_dir)
    paths = []
    for i in range(1, cap + 1):
        p = os.path.join(alice_dir, "{}_evt-pre{}.jpg".format(i * 1000, i))
        with open(p, "wb") as f:
            f.write(b"old")
        os.utime(p, (i, i))
        paths.append(p)

    # act — write one more, should trigger eviction of the oldest.
    written = save_face_capture(
        capture_dir=capture_dir,
        name="alice",
        event_id="evt-new",
        ts_ms=999_999_999_999,
        jpeg_bytes=b"new",
        max_per_dir=cap,
    )

    # assert — new file present, oldest pre-write (mtime=1) gone,
    # total still <= cap.
    assert written is not None
    assert os.path.exists(written)
    assert not os.path.exists(paths[0])  # oldest evicted
    remaining = [
        e for e in os.listdir(alice_dir) if e.endswith(".jpg")
    ]
    assert len(remaining) == cap


def test_when_save_called_with_confidence_then_sidecar_json_is_written(tmp_path):
    # arrange (iter-355a sidecar plumbing)
    import json
    capture_dir = str(tmp_path / "captures")

    # act
    written = save_face_capture(
        capture_dir=capture_dir,
        name="alice",
        event_id="evt-123",
        ts_ms=1700000000000,
        jpeg_bytes=b"\xff\xd8\xff\xe0bytes",
        confidence=0.73,
        predicted_name="alice",
    )

    # assert
    assert written is not None
    sidecar_path = written[:-4] + ".json"
    assert os.path.exists(sidecar_path)
    with open(sidecar_path) as f:
        meta = json.load(f)
    assert meta == {
        "predicted_name": "alice",
        "confidence": 0.73,
        "event_id": "evt-123",
        "ts_ms": 1700000000000,
    }


def test_given_no_confidence_when_save_called_then_sidecar_has_nulls(tmp_path):
    # arrange — dormant-recognizer state OR bootstrap upload.
    import json
    capture_dir = str(tmp_path / "captures")

    # act
    written = save_face_capture(
        capture_dir=capture_dir,
        name="__unknown__",
        event_id="evt-456",
        ts_ms=1700000060000,
        jpeg_bytes=b"\xff\xd8\xff\xe0bytes",
    )

    # assert
    sidecar_path = written[:-4] + ".json"
    with open(sidecar_path) as f:
        meta = json.load(f)
    # No predicted_name passed → falls back to the bucket name. None
    # confidence stays None.
    assert meta["predicted_name"] == "__unknown__"
    assert meta["confidence"] is None
    assert meta["event_id"] == "evt-456"


def test_given_dir_at_cap_when_save_called_then_sidecar_also_evicted(tmp_path):
    # arrange — pre-fill alice/ with 3 jpeg+json pairs, then write
    # one more with cap=3. Oldest jpeg AND its sidecar should be gone.
    import json
    capture_dir = str(tmp_path / "captures")
    cap = 3
    alice_dir = os.path.join(capture_dir, "alice")
    os.makedirs(alice_dir)
    sidecar_paths = []
    for i in range(1, cap + 1):
        p = os.path.join(alice_dir, "{}_evt-pre{}.jpg".format(i * 1000, i))
        with open(p, "wb") as f:
            f.write(b"old")
        os.utime(p, (i, i))
        sidecar = p[:-4] + ".json"
        with open(sidecar, "w") as f:
            json.dump({"predicted_name": "alice"}, f)
        os.utime(sidecar, (i, i))
        sidecar_paths.append(sidecar)

    # act
    save_face_capture(
        capture_dir=capture_dir,
        name="alice",
        event_id="evt-new",
        ts_ms=999_999_999_999,
        jpeg_bytes=b"new",
        max_per_dir=cap,
        confidence=0.9,
    )

    # assert — oldest sidecar gone too.
    assert not os.path.exists(sidecar_paths[0])


def test_given_event_id_with_unsafe_chars_when_save_called_then_sanitized(
    tmp_path,
):
    # arrange — defensive: event_id should already be safe per the
    # iter-? recording_service regex, but the recognizer doesn't
    # import that module so we re-sanitize here.
    capture_dir = str(tmp_path / "captures")

    # act
    written = save_face_capture(
        capture_dir=capture_dir,
        name="alice",
        event_id="../../etc/passwd",
        ts_ms=1700000000000,
        jpeg_bytes=b"\xff\xd8\xff\xe0bytes",
    )

    # assert — file written under alice/, NO traversal up the tree.
    assert written is not None
    # Resolve to confirm no escape.
    abs_target = os.path.abspath(written)
    abs_capture = os.path.abspath(capture_dir)
    assert abs_target.startswith(abs_capture + os.sep)
    # Filename has no slashes / dots-as-separator; safe chars only.
    filename = os.path.basename(written)
    assert "/" not in filename
    assert "passwd" in filename  # the literal chars survive as letters
