"""iter-201 (Feature #1 slice 1): recording_service tests.

Service is pure file-ops; tests use tmp_path + monkeypatch
`settings.recordings_dir`. No ffmpeg, no async — purely the
storage/retention surface.
"""
from __future__ import annotations

import time

import pytest

from app.services import recording_service
from app.config import settings


@pytest.fixture
def rec_dir(tmp_path, monkeypatch):
    """Per-test recordings dir; gets created on demand."""
    p = tmp_path / "recordings"
    monkeypatch.setattr(settings, "recordings_dir", p)
    yield p


# --- clip_path / clip_exists / delete_clip ---


def test_clip_path_resolves_to_event_id_dot_mp4(rec_dir):
    assert recording_service.clip_path("evt-123") == rec_dir / "evt-123.mp4"


def test_clip_path_rejects_path_traversal(rec_dir):
    """Defense-in-depth: even if the route regex were bypassed, the
    service refuses any non-bare event_id."""
    with pytest.raises(ValueError):
        recording_service.clip_path("../etc/passwd")
    with pytest.raises(ValueError):
        recording_service.clip_path("foo/bar")
    with pytest.raises(ValueError):
        recording_service.clip_path("foo bar")
    with pytest.raises(ValueError):
        recording_service.clip_path("")


def test_clip_path_accepts_canonical_event_id(rec_dir):
    """Charset is `[A-Za-z0-9_-]+` — alphanumeric + underscore +
    dash. Matches the existing event_bus id format and the route's
    Path pattern."""
    assert recording_service.clip_path("abc123") is not None
    assert recording_service.clip_path("a_b-c") is not None
    assert recording_service.clip_path("X" * 64) is not None


def test_clip_exists_false_for_missing_file(rec_dir):
    assert recording_service.clip_exists("evt-missing") is False


def test_clip_exists_true_after_write(rec_dir):
    rec_dir.mkdir()
    (rec_dir / "evt-001.mp4").write_bytes(b"fake mp4")
    assert recording_service.clip_exists("evt-001") is True


def test_clip_exists_false_for_invalid_id(rec_dir):
    """Invalid id → False (don't raise; clip_path catches it)."""
    assert recording_service.clip_exists("../etc/passwd") is False


def test_delete_clip_removes_existing(rec_dir):
    rec_dir.mkdir()
    p = rec_dir / "evt-002.mp4"
    p.write_bytes(b"fake mp4")
    assert recording_service.delete_clip("evt-002") is True
    assert not p.exists()


def test_delete_clip_returns_false_for_missing(rec_dir):
    """No error on missing — best-effort cleanup."""
    assert recording_service.delete_clip("evt-ghost") is False


def test_delete_clip_returns_false_for_invalid_id(rec_dir):
    assert recording_service.delete_clip("../etc/passwd") is False


# --- sweep_old_clips ---


def test_sweep_returns_zero_when_dir_missing(rec_dir):
    assert recording_service.sweep_old_clips(7) == 0


def test_sweep_deletes_old_clips_keeps_fresh(rec_dir):
    """Files older than retention_days * 86400 seconds are deleted;
    fresh files are kept."""
    rec_dir.mkdir()
    old = rec_dir / "old.mp4"
    fresh = rec_dir / "fresh.mp4"
    old.write_bytes(b"old")
    fresh.write_bytes(b"fresh")

    # Backdate `old` by 30 days; `fresh` left at current mtime.
    cutoff_age_s = 30 * 86400
    import os as _os
    _os.utime(old, (time.time() - cutoff_age_s, time.time() - cutoff_age_s))

    deleted = recording_service.sweep_old_clips(retention_days=7)
    assert deleted == 1
    assert not old.exists()
    assert fresh.exists()


def test_sweep_skips_non_mp4_files(rec_dir):
    """Operator might keep ad-hoc test clips or partial ffmpeg
    work-files that share the dir; only `.mp4` is sweepable."""
    rec_dir.mkdir()
    log_file = rec_dir / "ffmpeg.log"
    log_file.write_bytes(b"x")
    import os as _os
    _os.utime(log_file, (time.time() - 30 * 86400, time.time() - 30 * 86400))

    deleted = recording_service.sweep_old_clips(retention_days=7)
    assert deleted == 0
    assert log_file.exists()


def test_sweep_with_zero_retention_skips(rec_dir):
    """`retention_days <= 0` is a misconfiguration; refuse to delete
    everything. Operator clears the dir manually if they actually
    want that."""
    rec_dir.mkdir()
    p = rec_dir / "evt.mp4"
    p.write_bytes(b"x")
    import os as _os
    _os.utime(p, (time.time() - 1000 * 86400, time.time() - 1000 * 86400))

    assert recording_service.sweep_old_clips(retention_days=0) == 0
    assert recording_service.sweep_old_clips(retention_days=-5) == 0
    assert p.exists()


def test_sweep_with_default_retention_uses_settings(rec_dir, monkeypatch):
    """No arg → reads `settings.recordings_retention_days`."""
    monkeypatch.setattr(settings, "recordings_retention_days", 7)
    rec_dir.mkdir()
    old = rec_dir / "old.mp4"
    old.write_bytes(b"x")
    import os as _os
    _os.utime(old, (time.time() - 30 * 86400, time.time() - 30 * 86400))

    assert recording_service.sweep_old_clips() == 1
