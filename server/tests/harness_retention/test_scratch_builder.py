from pathlib import Path

import pytest

from server.tests.harness_retention.manifest_fixture import (
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


def test_given_real_manifest_when_scratch_built_then_sizes_and_mtimes_match_without_copying_payloads(tmp_path):
    clips, _df_avail_bytes = parse_recordings_manifest(MANIFEST)
    recordings_dir = tmp_path / "recordings"

    build_scratch_recordings(clips, recordings_dir)

    total_logical_bytes = 0
    total_allocated_bytes = 0
    for name, size_bytes, mtime_epoch in clips:
        stat = (recordings_dir / name).stat()
        total_logical_bytes += stat.st_size
        total_allocated_bytes += stat.st_blocks * 512

        assert stat.st_size == size_bytes
        assert stat.st_mtime == mtime_epoch

    assert total_logical_bytes == sum(size_bytes for _name, size_bytes, _mtime in clips)
    assert total_allocated_bytes < 10 * 1024 * 1024
