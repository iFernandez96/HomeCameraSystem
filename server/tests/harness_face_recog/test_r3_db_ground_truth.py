import pytest

from server.tests.harness_face_recog.fixtures import (
    EVENTS_DB,
    PERSONS_DIR,
    count_named_person_name_rows,
    count_person_events,
)


pytestmark = [
    pytest.mark.skipif(
        not PERSONS_DIR.exists(),
        reason="no Jetson person crop fixtures - capture .jetson-snapshot/proof_fixtures/persons",
    ),
    pytest.mark.skipif(
        not EVENTS_DB.exists(),
        reason="no Jetson events DB fixture - capture .jetson-snapshot/db/events.sqlite",
    ),
]


def test_given_current_snapshot_when_counting_person_events_then_count_is_pinned():
    # Floor, not equality: the snapshot refreshes while production keeps
    # detecting (2454 verified 2026-07-08 pre-refetch, 2480 post). A shrink
    # below the last verified floor means data loss or a truncated fetch.
    assert count_person_events() >= 2454


def test_given_current_snapshot_when_counting_named_person_rows_then_capture_only_reality_is_pinned():
    # This pins production's capture-only reality: recognition has not fired live.
    # A future refreshed snapshot with names must update this pin deliberately.
    assert count_named_person_name_rows() == 0
