from pathlib import Path

import pytest

from server.tests.harness_snapshots.fixtures import (
    EVENTS_DB,
    SNAPSHOT_DIR,
    db_thumb_urls,
    list_snapshot_files,
)


pytestmark = [
    pytest.mark.skipif(
        not SNAPSHOT_DIR.exists(),
        reason="no Jetson snapshot fixtures - capture .jetson-snapshot/proof_fixtures/snapshots",
    ),
    pytest.mark.skipif(
        not EVENTS_DB.exists(),
        reason="no Jetson events DB fixture - capture .jetson-snapshot/db/events.sqlite",
    ),
]


def test_given_real_db_thumb_urls_and_fixture_files_when_intersected_on_filename_then_overlap_is_nonempty():
    db_thumb_filenames = {Path(thumb_url).name for thumb_url in db_thumb_urls()}
    fixture_filenames = {snapshot_file.name for snapshot_file in list_snapshot_files()}

    overlap = db_thumb_filenames & fixture_filenames

    assert len(overlap) >= 1, f"overlap_count={len(overlap)}"
