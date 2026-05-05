"""iter-356.62 slice 3 (privacy controls): tests for the face/person
capture TTL sweeper. Mirrors `test_recording_service.py` shape.
"""
from __future__ import annotations

import os
import time
from pathlib import Path

import pytest

from app.config import settings
from app.services import face_capture_sweeper


@pytest.fixture
def isolated_capture_dirs(tmp_path, monkeypatch):
    """Per-test isolated face_captures_dir + person_captures_dir."""
    face_root = tmp_path / "face_captures"
    person_root = tmp_path / "person_captures"
    face_root.mkdir()
    person_root.mkdir()
    monkeypatch.setattr(settings, "face_captures_dir", face_root)
    monkeypatch.setattr(settings, "person_captures_dir", person_root)
    return face_root, person_root


def _make_capture(directory: Path, basename: str, age_days: float) -> tuple[Path, Path]:
    """Drop a JPEG + JSON sidecar with mtime = now - age_days*86400."""
    directory.mkdir(parents=True, exist_ok=True)
    jpg = directory / "{}.jpg".format(basename)
    sidecar = directory / "{}.json".format(basename)
    jpg.write_bytes(b"\xff\xd8\xff\xd9")  # tiny valid JPEG marker
    sidecar.write_text("{}")
    mtime = time.time() - age_days * 86400
    os.utime(str(jpg), (mtime, mtime))
    os.utime(str(sidecar), (mtime, mtime))
    return jpg, sidecar


def test_when_retention_days_zero_or_negative_then_sweep_skipped(
    isolated_capture_dirs,
):
    # arrange
    face_root, _ = isolated_capture_dirs
    jpg, sidecar = _make_capture(face_root / "alice", "1700000000_evt", age_days=999)

    # act
    deleted_zero = face_capture_sweeper.sweep_old_face_captures(retention_days=0)
    deleted_neg = face_capture_sweeper.sweep_old_face_captures(retention_days=-5)

    # assert
    assert deleted_zero == 0
    assert deleted_neg == 0
    assert jpg.exists()
    assert sidecar.exists()


def test_given_old_files_when_sweep_then_deleted_with_sidecars(
    isolated_capture_dirs,
):
    # arrange
    face_root, _ = isolated_capture_dirs
    jpg, sidecar = _make_capture(face_root / "alice", "1700000000_evt", age_days=60)

    # act
    deleted = face_capture_sweeper.sweep_old_face_captures(retention_days=30)

    # assert
    assert deleted == 1
    assert not jpg.exists()
    assert not sidecar.exists()


def test_given_recent_files_when_sweep_then_kept(isolated_capture_dirs):
    # arrange
    face_root, _ = isolated_capture_dirs
    jpg, sidecar = _make_capture(face_root / "alice", "1700000000_evt", age_days=5)

    # act
    deleted = face_capture_sweeper.sweep_old_face_captures(retention_days=30)

    # assert
    assert deleted == 0
    assert jpg.exists()
    assert sidecar.exists()


def test_given_oserror_on_one_file_when_sweep_then_others_still_processed(
    isolated_capture_dirs, monkeypatch,
):
    # arrange
    face_root, _ = isolated_capture_dirs
    bad_jpg, _ = _make_capture(face_root / "alice", "1700000000_bad", age_days=60)
    good_jpg, _ = _make_capture(face_root / "alice", "1700000001_good", age_days=60)
    real_remove = os.remove

    def flaky_remove(path):
        if str(path) == str(bad_jpg):
            raise OSError("permission denied (simulated)")
        return real_remove(path)

    monkeypatch.setattr(face_capture_sweeper.os, "remove", flaky_remove)

    # act
    deleted = face_capture_sweeper.sweep_old_face_captures(retention_days=30)

    # assert
    assert deleted == 1  # the good file
    assert bad_jpg.exists()
    assert not good_jpg.exists()


def test_given_person_captures_dir_with_old_files_when_sweep_then_also_swept(
    isolated_capture_dirs,
):
    # arrange
    face_root, person_root = isolated_capture_dirs
    face_jpg, _ = _make_capture(face_root / "alice", "1700000000_evt", age_days=60)
    person_jpg, _ = _make_capture(person_root / "alice", "1700000001_evt", age_days=60)

    # act
    deleted = face_capture_sweeper.sweep_old_face_captures(retention_days=30)

    # assert
    assert deleted == 2
    assert not face_jpg.exists()
    assert not person_jpg.exists()


def test_given_no_retention_arg_when_sweep_then_uses_detection_config(
    isolated_capture_dirs,
):
    # arrange
    from app.services.detection_config import detection_config
    detection_config.update(face_capture_retention_days=10)
    face_root, _ = isolated_capture_dirs
    old_jpg, _ = _make_capture(face_root / "alice", "1700000000_old", age_days=20)
    new_jpg, _ = _make_capture(face_root / "alice", "1700000001_new", age_days=5)

    # act
    deleted = face_capture_sweeper.sweep_old_face_captures()

    # assert
    assert deleted == 1
    assert not old_jpg.exists()
    assert new_jpg.exists()
