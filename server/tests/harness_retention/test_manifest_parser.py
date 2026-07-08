from pathlib import Path

import pytest

from server.tests.harness_retention.manifest_fixture import parse_recordings_manifest


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


def test_given_real_manifest_when_parsed_then_400_basename_only_mp4_rows_and_positive_df_avail():
    clips, df_avail_bytes = parse_recordings_manifest(MANIFEST)

    assert len(clips) == 400
    assert df_avail_bytes > 0
    assert all(Path(name).name == name for name, _size, _mtime in clips)
    assert all(name.endswith(".mp4") for name, _size, _mtime in clips)
