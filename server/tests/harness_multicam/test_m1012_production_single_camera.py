import pytest

from app.services import events_db
from server.tests.harness_multicam.fixtures import EVENTS_DB, camera_counts


pytestmark = pytest.mark.skipif(
    not EVENTS_DB.exists(),
    reason="no Jetson events DB fixture - capture .jetson-snapshot/db/events.sqlite",
)


def test_given_captured_events_db_when_read_readonly_then_front_door_matches_unfiltered_totals():
    counts = camera_counts(EVENTS_DB)
    total = events_db.count_events(EVENTS_DB)

    assert total > 0
    assert counts.get("cam1", 0) == 0
    assert counts == {"front_door": total}

    unfiltered_events = events_db.search(EVENTS_DB, limit=total + 1)
    front_door_events = events_db.search(
        EVENTS_DB, camera_id="front_door", limit=total + 1
    )
    assert len(unfiltered_events) == total
    assert len(front_door_events) == total

    unfiltered_counts = events_db.count_by_day(EVENTS_DB)
    front_door_counts = events_db.count_by_day(
        EVENTS_DB, camera_id="front_door"
    )
    assert front_door_counts == unfiltered_counts
    assert sum(unfiltered_counts.values()) == total
