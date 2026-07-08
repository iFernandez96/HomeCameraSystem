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


class _OrderedClip:
    def __init__(self, path, deletion_order):
        self._path = path
        self._deletion_order = deletion_order

    @property
    def name(self):
        return self._path.name

    def stat(self):
        return self._path.stat()

    def unlink(self):
        self._deletion_order.append(self._path.name)
        return self._path.unlink()


def test_given_real_manifest_below_byte_floor_when_sweep_and_evict_runs_then_oldest_fresh_prefix_is_deleted_in_mtime_order(
    tmp_path, monkeypatch
):
    clips, df_avail_bytes = parse_recordings_manifest(MANIFEST)
    recordings_dir = tmp_path / "recordings"
    build_scratch_recordings(clips, recordings_dir)
    monkeypatch.setattr(settings, "recordings_dir", recordings_dir)

    ordered_clips = sorted(clips, key=lambda clip: clip[2])
    candidate_counts = [
        count
        for count in range(3, min(10, len(ordered_clips)) + 1)
        if sum(size for _name, size, _mtime in ordered_clips[: count - 1])
        < recording_service.SERVER_MIN_FREE_BYTES
    ]
    target_count = candidate_counts[df_avail_bytes % len(candidate_counts)]
    deficit = sum(
        size for _name, size, _mtime in ordered_clips[: target_count - 1]
    ) + 1
    start_free = recording_service.SERVER_MIN_FREE_BYTES - deficit

    expected_prefix = []
    cumulative = 0
    for name, size, _mtime in ordered_clips:
        expected_prefix.append((name, size))
        cumulative += size
        if cumulative >= deficit:
            break
    expected_names = [name for name, _size in expected_prefix]

    monkeypatch.setattr(
        recording_service.time,
        "time",
        lambda: max(mtime for _name, _size, mtime in clips) + 60,
    )
    model = DiskModel(start_free, clips, recordings_dir)
    deletion_order = []

    def list_clips(rec_dir):
        return [
            (mtime, _OrderedClip(path, deletion_order))
            for mtime, path in recording_service._list_clips_by_mtime(rec_dir)
        ]

    result = recording_service.sweep_and_evict(
        retention_days=36500,
        disk_usage=model,
        list_clips=list_clips,
    )

    deleted_names = model.deleted_mp4_names()

    assert start_free < recording_service.SERVER_MIN_FREE_BYTES
    assert result["swept"] == 0
    assert model.free_bytes() >= recording_service.SERVER_MIN_FREE_BYTES
    assert deleted_names == set(expected_names)
    assert result["evicted"] == len(expected_names)
    assert result["freed_bytes"] == sum(size for _name, size in expected_prefix)
    assert deletion_order == expected_names
    assert deletion_order != sorted(expected_names)
    assert deletion_order != [
        name for name, _size in sorted(expected_prefix, key=lambda item: item[1])
    ]
