import pytest

from server.tests.harness_eventbus.fixtures import (
    EVENTS_DB,
    EVENTS_JSON,
    load_db_rows_by_id,
    load_json_rows,
    normalize,
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


def test_given_events_tonight_json_when_matched_to_sqlite_then_every_row_normalizes_equal():
    db_rows_by_id = load_db_rows_by_id()
    failures = []

    for json_row in load_json_rows():
        event_id = json_row["id"]
        db_row = db_rows_by_id.get(event_id)
        if db_row is None:
            failures.append(f"{event_id}: missing in events.sqlite")
            continue

        json_event = normalize(json_row)
        db_event = normalize(db_row)
        if db_event != json_event:
            failures.append(
                f"{event_id}: normalized mismatch json={json_event!r} db={db_event!r}"
            )

    assert not failures, "event fixture parity failures:\n" + "\n".join(failures)
