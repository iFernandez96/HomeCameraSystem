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


def test_given_real_manifest_with_untouchable_sentinels_when_sweep_and_evict_runs_then_every_sentinel_survives_byte_for_byte(
    tmp_path, monkeypatch
):
    clips, _df_avail_bytes = parse_recordings_manifest(MANIFEST)
    recordings_dir = tmp_path / "recordings"
    build_scratch_recordings(clips, recordings_dir)
    monkeypatch.setattr(settings, "recordings_dir", recordings_dir)

    sentinel_bytes = {
        Path("notes.txt"): b"operator note\nkeep me\n",
        Path("operator.mov"): b"not a managed mp4",
        Path("_preroll/seg_000.mp4"): b"preroll segment bytes",
        Path("_visits/openvisit/seg_000.mp4"): b"open visit segment bytes",
        Path(".open_visits.json"): b'{"openvisit": true}\n',
        Path("activevisit.mp4.tmp"): b"active ffmpeg output",
    }
    old_mtime = min(mtime for _name, _size, mtime in clips) - 86400
    for relative_path, payload in sentinel_bytes.items():
        path = recordings_dir / relative_path
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(payload)
        os.utime(path, (old_mtime, old_mtime))

    now = max(mtime for _name, _size, mtime in clips) + 60
    cutoff = now - 86400
    expired_names = {name for name, _size, mtime in clips if mtime < cutoff}
    fresh_clips = sorted(
        (clip for clip in clips if clip[0] not in expired_names),
        key=lambda clip: clip[2],
    )
    target_evict_count = min(12, len(fresh_clips))
    assert target_evict_count > 0

    expired_bytes = sum(
        size for name, size, _mtime in clips if name in expired_names
    )
    deficit_after_sweep = (
        sum(size for _name, size, _mtime in fresh_clips[: target_evict_count - 1])
        + 1
    )
    start_free = (
        recording_service.SERVER_MIN_FREE_BYTES
        - expired_bytes
        - deficit_after_sweep
    )

    monkeypatch.setattr(recording_service.time, "time", lambda: now)
    model = DiskModel(start_free, clips, recordings_dir)

    result = recording_service.sweep_and_evict(
        retention_days=1,
        disk_usage=model,
    )

    deleted_names = model.deleted_mp4_names()
    evicted_names = deleted_names - expired_names

    assert result["swept"] == len(expired_names)
    assert result["evicted"] == target_evict_count
    assert len(evicted_names) == target_evict_count
    assert expired_names < deleted_names
    assert {
        path.name for path in recordings_dir.glob("*.mp4")
    } == {name for name, _size, _mtime in fresh_clips[target_evict_count:]}

    for relative_path, payload in sentinel_bytes.items():
        path = recordings_dir / relative_path
        assert path.is_file()
        assert path.stat().st_size == len(payload)
        assert path.read_bytes() == payload
