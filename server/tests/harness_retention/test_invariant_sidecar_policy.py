"""
Time sweep removes expired .tracks.json sidecars, while byte eviction leaves a fresh evicted clip's sidecar for a later time sweep.
"""
import os
from pathlib import Path

import pytest

from app.config import settings
from app.services import recording_service
from server.tests.harness_retention.manifest_fixture import (
    DiskModel,
    build_scratch_recordings,
    parse_recordings_manifest,
)


MANIFEST = (
    Path(__file__).resolve().parents[3]
    / ".jetson-snapshot"
    / "proof_fixtures"
    / "recordings_manifest.txt"
)

pytestmark = pytest.mark.skipif(
    not MANIFEST.exists(),
    reason="no Jetson recordings manifest - capture .jetson-snapshot/proof_fixtures/recordings_manifest.txt",
)


def _sidecar_suffix():
    probe = recording_service.tracks_path("probe")
    return probe.name[len("probe") :]


def _write_sidecar(recordings_dir, clip_name, mtime):
    path = recordings_dir / (Path(clip_name).stem + _sidecar_suffix())
    path.write_text('{"samples": []}\n')
    os.utime(path, (mtime, mtime))
    return path


def test_given_real_manifest_with_tracks_sidecars_when_retention_runs_then_sweep_removes_old_sidecar_but_byte_eviction_leaves_fresh_sidecar(
    tmp_path, monkeypatch
):
    clips, _df_avail_bytes = parse_recordings_manifest(MANIFEST)
    recordings_dir = tmp_path / "recordings"
    build_scratch_recordings(clips, recordings_dir)
    monkeypatch.setattr(settings, "recordings_dir", recordings_dir)

    now = max(mtime for _name, _size, mtime in clips) + 60
    cutoff = now - (7 * 86400)
    expired_clips = sorted(
        (clip for clip in clips if clip[2] < cutoff),
        key=lambda clip: clip[2],
    )
    fresh_clips = sorted(
        (clip for clip in clips if clip[2] >= cutoff),
        key=lambda clip: clip[2],
    )
    assert expired_clips
    assert len(fresh_clips) >= 2

    old_expired = expired_clips[0]
    fresh_evicted = fresh_clips[0]
    fresh_survivor = fresh_clips[1]
    old_sidecar = _write_sidecar(recordings_dir, old_expired[0], old_expired[2])
    evicted_sidecar = _write_sidecar(
        recordings_dir, fresh_evicted[0], fresh_evicted[2]
    )
    survivor_sidecar = _write_sidecar(
        recordings_dir, fresh_survivor[0], fresh_survivor[2]
    )

    expired_bytes = sum(
        size
        for name, size, _mtime in clips
        if (recordings_dir / name).stat().st_mtime < cutoff
    )
    start_free = recording_service.SERVER_MIN_FREE_BYTES - expired_bytes - 1

    monkeypatch.setattr(recording_service.time, "time", lambda: now)
    model = DiskModel(start_free, clips, recordings_dir)

    result = recording_service.sweep_and_evict(
        retention_days=7,
        disk_usage=model,
    )

    assert result["swept"] > 0
    assert result["evicted"] == 1
    assert not (recordings_dir / old_expired[0]).exists()
    assert not old_sidecar.exists()
    assert not (recordings_dir / fresh_evicted[0]).exists()
    assert evicted_sidecar.is_file()
    assert (recordings_dir / fresh_survivor[0]).is_file()
    assert survivor_sidecar.is_file()
