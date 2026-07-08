import pytest

from server.tests.harness_eventbus.fixtures import (
    EVENTS_DB,
    EVENTS_JSON,
    load_db_rows,
    load_json_rows,
)


pytestmark = [
    pytest.mark.skipif(
        not EVENTS_JSON.exists(),
        reason="no continuous capture events fixture - capture .jetson-snapshot/continuous_capture_fixtures/events_tonight.json",
    ),
    pytest.mark.skipif(
        not EVENTS_DB.exists(),
        reason="no Jetson events DB fixture - capture .jetson-snapshot/db/events.sqlite",
    ),
]


def test_given_eventbus_fixture_sources_when_loaded_then_counts_are_nonzero():
    json_rows = load_json_rows()
    db_rows = load_db_rows()

    assert EVENTS_JSON.exists()
    assert EVENTS_DB.exists()
    assert len(json_rows) > 0
    assert len(db_rows) > 0
