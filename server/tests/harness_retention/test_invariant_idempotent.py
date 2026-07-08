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


def _recording_tree(recordings_dir):
    return {
        path.relative_to(recordings_dir).as_posix(): path.stat().st_size
        for path in recordings_dir.rglob("*")
        if path.is_file()
    }


def test_given_evicted_manifest_when_retention_runs_again_then_it_is_idempotent(
    tmp_path, monkeypatch
):
    clips, df_avail_bytes = parse_recordings_manifest(MANIFEST)
    recordings_dir = tmp_path / "recordings"
    build_scratch_recordings(clips, recordings_dir)
    monkeypatch.setattr(settings, "recordings_dir", recordings_dir)
    monkeypatch.setattr(
        recording_service.time,
        "time",
        lambda: max(mtime for _name, _size, mtime in clips) + 60,
    )

    ordered_clips = sorted(clips, key=lambda clip: clip[2])
    target_count = 3 + (df_avail_bytes % 4)
    deficit = (
        sum(size for _name, size, _mtime in ordered_clips[: target_count - 1])
        + 1
    )
    start_free = recording_service.SERVER_MIN_FREE_BYTES - deficit
    model = DiskModel(start_free, clips, recordings_dir)

    first = recording_service.sweep_and_evict(
        retention_days=36500,
        disk_usage=model,
    )
    assert first["swept"] == 0
    assert first["evicted"] == target_count
    assert first["freed_bytes"] == sum(
        size for _name, size, _mtime in ordered_clips[:target_count]
    )
    assert model.free_bytes() >= recording_service.SERVER_MIN_FREE_BYTES

    before_second = _recording_tree(recordings_dir)
    second = recording_service.sweep_and_evict(
        retention_days=36500,
        disk_usage=model,
    )
    after_second = _recording_tree(recordings_dir)

    assert second == {"swept": 0, "evicted": 0, "freed_bytes": 0}
    assert after_second == before_second
