import re

import pytest

from server.tests.harness_snapshots.fixtures import SNAPSHOT_DIR, list_snapshot_files


SNAPSHOT_FILENAME_RE = re.compile(r"^(latest|snap_[0-9]+|thumb_[0-9]+)\.jpg$")


pytestmark = [
    pytest.mark.skipif(
        not SNAPSHOT_DIR.exists(),
        reason="no Jetson snapshot fixtures - capture .jetson-snapshot/proof_fixtures/snapshots",
    ),
]


def test_given_real_snapshot_dir_listing_when_classified_then_every_jpg_has_a_production_filename_shape():
    snapshot_files = list_snapshot_files()

    unexpected_names = [
        snapshot_file.name
        for snapshot_file in snapshot_files
        if not SNAPSHOT_FILENAME_RE.fullmatch(snapshot_file.name)
    ]

    assert not unexpected_names, f"unexpected snapshot jpg filenames: {unexpected_names}"
