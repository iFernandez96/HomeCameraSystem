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
    save_person_capture,
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
    # iter-356.62 (slice 1): sidecar bumped to schema_version=2 with
    # always-present `kind`. v1 keys (predicted_name, confidence,
    # event_id, ts_ms) still pinned for back-compat readers.
    assert meta["predicted_name"] == "alice"
    assert meta["confidence"] == 0.73
    assert meta["event_id"] == "evt-123"
    assert meta["ts_ms"] == 1700000000000
    assert meta["schema_version"] == 2
    assert meta["kind"] == "face"


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


# --- iter-356.62 (slice 1): sidecar v2 + person crop save ------------------


def _read_sidecar(jpeg_path):
    """Helper: load the JSON sidecar that lives next to a written jpeg."""
    import json
    sidecar_path = jpeg_path[:-4] + ".json"
    with open(sidecar_path) as f:
        return json.load(f)


def test_when_save_face_capture_then_sidecar_schema_version_is_2(tmp_path):
    # arrange
    capture_dir = str(tmp_path / "captures")

    # act
    written = save_face_capture(
        capture_dir=capture_dir,
        name="alice",
        event_id="evt-v2",
        ts_ms=1700000000000,
        jpeg_bytes=b"\xff\xd8\xff\xe0bytes",
        confidence=0.5,
    )

    # assert
    meta = _read_sidecar(written)
    assert meta["schema_version"] == 2
    assert meta["kind"] == "face"


def test_given_meta_when_save_face_capture_then_sidecar_includes_source_resolution(
    tmp_path,
):
    # arrange
    capture_dir = str(tmp_path / "captures")
    capture_meta = {
        "source": {"w": 1280, "h": 720, "camera_id": "cam1"},
    }

    # act
    written = save_face_capture(
        capture_dir=capture_dir,
        name="alice",
        event_id="evt-src",
        ts_ms=1700000000000,
        jpeg_bytes=b"\xff\xd8\xff\xe0bytes",
        confidence=0.8,
        meta=capture_meta,
    )

    # assert
    meta = _read_sidecar(written)
    assert meta["source"] == {"w": 1280, "h": 720, "camera_id": "cam1"}


def test_given_meta_when_save_face_capture_then_sidecar_includes_model_version(
    tmp_path,
):
    # arrange
    capture_dir = str(tmp_path / "captures")
    capture_meta = {
        "model": {
            "name": "ssd-mobilenet-v2",
            "version": "trt-fp16",
            "floor": 0.05,
        },
    }

    # act
    written = save_face_capture(
        capture_dir=capture_dir,
        name="alice",
        event_id="evt-model",
        ts_ms=1700000000000,
        jpeg_bytes=b"\xff\xd8\xff\xe0bytes",
        meta=capture_meta,
    )

    # assert
    meta = _read_sidecar(written)
    assert meta["model"]["version"] == "trt-fp16"
    assert meta["model"]["name"] == "ssd-mobilenet-v2"
    assert meta["model"]["floor"] == 0.05


def test_given_meta_when_save_face_capture_then_sidecar_includes_detection_bbox_pixels_and_norm(
    tmp_path,
):
    # arrange
    capture_dir = str(tmp_path / "captures")
    capture_meta = {
        "detection": {
            "label": "person",
            "score": 0.92,
            "bbox_pixels": [10, 20, 110, 220],
            "bbox_norm": [0.01, 0.02, 0.11, 0.22],
        },
    }

    # act
    written = save_face_capture(
        capture_dir=capture_dir,
        name="alice",
        event_id="evt-det",
        ts_ms=1700000000000,
        jpeg_bytes=b"\xff\xd8\xff\xe0bytes",
        meta=capture_meta,
    )

    # assert
    meta = _read_sidecar(written)
    assert meta["detection"]["bbox_pixels"] == [10, 20, 110, 220]
    assert meta["detection"]["bbox_norm"] == [0.01, 0.02, 0.11, 0.22]
    assert meta["detection"]["score"] == 0.92


def test_given_meta_overwrite_attempt_when_save_then_pinned_keys_unchanged(
    tmp_path,
):
    # arrange — caller maliciously (or sloppily) tries to override the
    # bookkeeping primitives the review UI relies on.
    capture_dir = str(tmp_path / "captures")
    evil_meta = {
        "event_id": "evil",
        "schema_version": 99,
        "kind": "spoof",
        "predicted_name": "spoofed",
        "ts_ms": 0,
        "confidence": 9.9,
    }

    # act
    written = save_face_capture(
        capture_dir=capture_dir,
        name="alice",
        event_id="evt-real",
        ts_ms=1700000000000,
        jpeg_bytes=b"\xff\xd8\xff\xe0bytes",
        confidence=0.42,
        meta=evil_meta,
    )

    # assert — pinned keys reflect the function args, NOT the meta dict.
    meta = _read_sidecar(written)
    assert meta["event_id"] == "evt-real"
    assert meta["schema_version"] == 2
    assert meta["kind"] == "face"
    assert meta["ts_ms"] == 1700000000000
    assert meta["confidence"] == 0.42
    # predicted_name falls back to name when not explicitly passed.
    assert meta["predicted_name"] == "alice"


def test_when_save_person_capture_called_then_writes_under_person_root(
    tmp_path,
):
    # arrange — separate roots so a misrouted write is detectable.
    face_dir = str(tmp_path / "face_captures")
    person_dir = str(tmp_path / "person_captures")

    # act
    written = save_person_capture(
        capture_dir=person_dir,
        name="alice",
        event_id="evt-person",
        ts_ms=1700000000000,
        jpeg_bytes=b"\xff\xd8\xff\xe0bytes",
    )

    # assert — file under person root, NOT face root.
    assert written is not None
    assert os.path.exists(written)
    abs_written = os.path.abspath(written)
    assert abs_written.startswith(os.path.abspath(person_dir) + os.sep)
    assert not abs_written.startswith(os.path.abspath(face_dir) + os.sep)


def test_given_person_dir_at_cap_when_save_called_then_oldest_evicted(
    tmp_path,
):
    # arrange — pre-fill alice/ under the person root with cap entries
    # at distinct mtimes; LRU should drop the oldest on the next write.
    person_dir = str(tmp_path / "person_captures")
    cap = 3
    alice_dir = os.path.join(person_dir, "alice")
    os.makedirs(alice_dir)
    paths = []
    for i in range(1, cap + 1):
        p = os.path.join(alice_dir, "{}_evt-pre{}.jpg".format(i * 1000, i))
        with open(p, "wb") as f:
            f.write(b"old")
        os.utime(p, (i, i))
        paths.append(p)

    # act
    written = save_person_capture(
        capture_dir=person_dir,
        name="alice",
        event_id="evt-new",
        ts_ms=999_999_999_999,
        jpeg_bytes=b"new",
        max_per_dir=cap,
    )

    # assert
    assert written is not None
    assert os.path.exists(written)
    assert not os.path.exists(paths[0])
    remaining = [e for e in os.listdir(alice_dir) if e.endswith(".jpg")]
    assert len(remaining) == cap


def test_given_save_person_capture_then_sidecar_kind_is_person(tmp_path):
    # arrange
    person_dir = str(tmp_path / "person_captures")

    # act
    written = save_person_capture(
        capture_dir=person_dir,
        name="alice",
        event_id="evt-p-kind",
        ts_ms=1700000000000,
        jpeg_bytes=b"\xff\xd8\xff\xe0bytes",
    )

    # assert
    meta = _read_sidecar(written)
    assert meta["kind"] == "person"
    assert meta["schema_version"] == 2
