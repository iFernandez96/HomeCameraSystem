"""Unit tests for the iter-306 timelapse builder service.

iter-314 (security-auditor E1+B1, defense-in-depth): pinning the
two-tier path-traversal guard in `_resolve_clip_path`.

Pre-iter-314 the function parsed `event_id` out of the DB-stored
`clip_url` string and built a path with no validation — the `.mp4`
suffix on the candidate filename was the accidental traversal
guard. A worker-compromise threat actor (4) could write a malformed
`clip_url` like `/api/events/../../etc/passwd/clip` to events_db
via the worker-authenticated `/api/_internal/event` endpoint; the
candidate path became `recordings_dir/"../../etc/passwd.mp4"`.
The `.mp4` suffix meant `.exists()` returned False on the current
filesystem, so the bug was latent — but a future iter that
changed the filename pattern would open the traversal.

iter-314 added:
1. `_VALID_EVENT_ID = re.compile(r"^[A-Za-z0-9_-]+$")` — rejects
   shell metas, slashes, dots, NUL.
2. `candidate.resolve().relative_to(recordings_dir.resolve())` —
   even a regex-clean path can't escape via symlinks.

These tests pin both tiers.
"""
from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import patch

import pytest


def _import_timelapse():
    """Lazy import so test discovery doesn't blow up if the worker
    Jetson SDK imports change. Returns the module."""
    from app.services import timelapse
    return timelapse


def test_when_event_id_is_clean_then_resolve_clip_path_returns_existing_file(
    tmp_path, monkeypatch,
):
    """Happy path: regex passes, file exists, candidate inside
    recordings_dir → returns the resolved path."""
    # arrange
    timelapse = _import_timelapse()
    from app.config import settings as _settings
    rec_dir = tmp_path / "recordings"
    rec_dir.mkdir()
    event_id = "abc123def456"
    (rec_dir / f"{event_id}.mp4").write_bytes(b"fake-mp4")
    monkeypatch.setattr(_settings, "recordings_dir", rec_dir)
    clip_url = f"/api/events/{event_id}/clip"

    # act
    result = timelapse._resolve_clip_path(clip_url)

    # assert
    assert result is not None
    assert result.name == f"{event_id}.mp4"
    assert result.parent == rec_dir.resolve()


def test_when_event_id_is_missing_then_resolve_clip_path_returns_none(
    tmp_path, monkeypatch,
):
    # arrange
    timelapse = _import_timelapse()
    from app.config import settings as _settings
    rec_dir = tmp_path / "recordings"
    rec_dir.mkdir()
    monkeypatch.setattr(_settings, "recordings_dir", rec_dir)
    # No file written — the regex passes, the resolve check passes,
    # but .exists() returns False.

    # act
    result = timelapse._resolve_clip_path("/api/events/no_such_id/clip")

    # assert
    assert result is None


def test_when_clip_url_is_falsy_then_resolve_clip_path_returns_none():
    # arrange
    timelapse = _import_timelapse()

    # act + assert
    assert timelapse._resolve_clip_path(None) is None
    assert timelapse._resolve_clip_path("") is None


def test_when_clip_url_path_shape_wrong_then_resolve_clip_path_returns_none():
    # arrange
    timelapse = _import_timelapse()

    # act + assert
    assert timelapse._resolve_clip_path("/notapi/events/abc/clip") is None
    assert timelapse._resolve_clip_path("/api/notevents/abc/clip") is None
    assert timelapse._resolve_clip_path("/api/events/abc/notclip") is None
    assert timelapse._resolve_clip_path("/api/events") is None  # too short


def test_when_event_id_contains_traversal_chars_then_resolve_clip_path_returns_none(
    tmp_path, monkeypatch,
):
    """iter-314 tier 1: regex rejects shell metas. Each malformed
    id should fail the `_VALID_EVENT_ID.match` check and return
    None BEFORE any filesystem I/O."""
    # arrange
    timelapse = _import_timelapse()
    from app.config import settings as _settings
    rec_dir = tmp_path / "recordings"
    rec_dir.mkdir()
    monkeypatch.setattr(_settings, "recordings_dir", rec_dir)
    bad_ids = [
        "..",
        "../etc/passwd",
        "../..",
        "abc/def",
        "abc.def",
        "abc def",
        "abc;rm -rf /",
        "abc\x00null",
        "abc\nnewline",
    ]
    # Reset the iter-308 traversal-list with one entry per malformed id.
    for bad_id in bad_ids:
        clip_url = f"/api/events/{bad_id}/clip"

        # act
        result = timelapse._resolve_clip_path(clip_url)

        # assert
        assert result is None, (
            f"iter-314 regex tier should reject bad event_id {bad_id!r} "
            f"but got {result!r}"
        )


def test_when_event_id_clean_but_file_is_a_symlink_outside_dir_then_returns_none(
    tmp_path, monkeypatch,
):
    """iter-314 tier 2: even a regex-clean event_id can't escape
    via a symlink. Tests the `resolve().relative_to()` check."""
    # arrange
    timelapse = _import_timelapse()
    from app.config import settings as _settings
    rec_dir = tmp_path / "recordings"
    rec_dir.mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "secret.mp4").write_bytes(b"sensitive")
    # Create a symlink INSIDE recordings_dir pointing OUTSIDE.
    (rec_dir / "evilsymlink.mp4").symlink_to(outside / "secret.mp4")
    monkeypatch.setattr(_settings, "recordings_dir", rec_dir)
    clip_url = "/api/events/evilsymlink/clip"

    # act
    result = timelapse._resolve_clip_path(clip_url)

    # assert — even though `evilsymlink` matches the regex AND the
    # candidate path EXISTS, the resolve+relative_to check rejects
    # it because the resolved target is outside recordings_dir.
    assert result is None


def test_when_resolve_raises_oserror_then_resolve_clip_path_returns_none(
    tmp_path, monkeypatch,
):
    """Defensive: if Path.resolve() raises (broken symlink, EIO, etc.)
    we don't propagate — return None and skip this clip."""
    # arrange
    timelapse = _import_timelapse()
    from app.config import settings as _settings
    rec_dir = tmp_path / "recordings"
    rec_dir.mkdir()
    monkeypatch.setattr(_settings, "recordings_dir", rec_dir)

    # act — patch Path.resolve to raise OSError on the candidate.
    real_resolve = Path.resolve

    def fake_resolve(self, *a, **k):
        if str(self).endswith("abc.mp4"):
            raise OSError("simulated EIO")
        return real_resolve(self, *a, **k)

    with patch.object(Path, "resolve", fake_resolve):
        result = timelapse._resolve_clip_path("/api/events/abc/clip")

    # assert
    assert result is None
