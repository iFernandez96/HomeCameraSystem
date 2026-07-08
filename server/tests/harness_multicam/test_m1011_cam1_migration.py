import sqlite3

import pytest

from app.services import events_db
from server.tests.harness_multicam.fixtures import (
    EVENTS_DB,
    camera_counts,
    copy_events_db,
    sample_front_door_ids,
)


pytestmark = pytest.mark.skipif(
    not EVENTS_DB.exists(),
    reason="no Jetson events DB fixture - capture .jetson-snapshot/db/events.sqlite",
)


def test_given_sample_rows_reset_to_legacy_cam1_when_init_db_then_all_normalize_to_front_door(
    tmp_path,
):
    scratch_db = copy_events_db(tmp_path)
    event_ids = sample_front_door_ids(scratch_db)
    assert event_ids, "fixture must contain front_door rows to reset"

    placeholders = ",".join("?" for _ in event_ids)
    with sqlite3.connect(scratch_db) as conn:
        conn.execute(
            f"UPDATE events SET camera_id = 'cam1' WHERE id IN ({placeholders})",
            event_ids,
        )
        conn.commit()

    assert camera_counts(scratch_db).get("cam1", 0) == len(event_ids)

    events_db.init_db(scratch_db)

    counts = camera_counts(scratch_db)
    assert counts.get("cam1", 0) == 0
    assert set(counts) == {"front_door"}
