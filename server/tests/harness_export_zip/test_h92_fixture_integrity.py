import re

import pytest

from server.tests.harness_export_zip.fixtures import (
    CLIPS_DIR,
    EVENTS_DB,
    db_rows_for,
    list_clips,
)


EVENT_ID_RE = re.compile(r"^[0-9a-f]{32}$")

pytestmark = [
    pytest.mark.skipif(
        not CLIPS_DIR.exists(),
        reason="no Jetson clip fixtures - capture .jetson-snapshot/proof_fixtures/clips",
    ),
    pytest.mark.skipif(
        not EVENTS_DB.exists(),
        reason="no Jetson events DB fixture - capture .jetson-snapshot/db/events.sqlite",
    ),
]


def test_given_export_zip_clip_filenames_when_matched_to_events_db_then_every_clip_has_a_row():
    clips = list_clips()
    clip_ids = [event_id for event_id, _, _ in clips]
    rows = db_rows_for(clip_ids)
    row_ids = {row["id"] for row in rows}
    report = {
        "clip_count": len(clips),
        "row_count": len(rows),
        "clip_ids": clip_ids,
        "matched_ids": sorted(row_ids),
        "missing_ids": sorted(set(clip_ids) - row_ids),
        "invalid_ids": sorted(
            event_id for event_id in clip_ids if not EVENT_ID_RE.fullmatch(event_id)
        ),
    }

    assert all(EVENT_ID_RE.fullmatch(event_id) for event_id in clip_ids), report
    assert len(row_ids) == len(clip_ids), report
    assert set(clip_ids) == row_ids, report
