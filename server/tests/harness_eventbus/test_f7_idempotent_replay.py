import asyncio
import sqlite3

import pytest

from server.tests.harness_eventbus.fixtures import (
    EVENTS_DB,
    EVENTS_JSON,
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


def _sorted_events(rows):
    return sorted((normalize(row) for row in rows), key=lambda row: (row["ts"], row["id"]))


def _read_scratch_rows(db_path):
    with sqlite3.connect(db_path) as conn:
        conn.row_factory = sqlite3.Row
        rows = conn.execute("SELECT * FROM events").fetchall()
    return _sorted_events(rows)


def _count_events(db_path):
    with sqlite3.connect(db_path) as conn:
        return int(conn.execute("SELECT COUNT(*) FROM events").fetchone()[0])


def test_given_real_stream_when_replayed_twice_then_second_pass_leaves_rows_and_bytes_unchanged(
    tmp_path, monkeypatch,
):
    from app.config import settings
    from app.services import events_db
    from app.services.event_bus import event_bus

    db_path = tmp_path / "events.db"
    monkeypatch.setattr(settings, "events_db_path", db_path)
    events_db.init_db(db_path)

    fixture_events = _sorted_events(load_json_rows())
    for event in fixture_events:
        asyncio.run(event_bus.publish(event))

    expected_count = len(fixture_events)
    assert _count_events(db_path) == expected_count
    assert _read_scratch_rows(db_path) == fixture_events
    first_bytes = db_path.read_bytes()

    for event in fixture_events:
        asyncio.run(event_bus.publish(event))

    assert _count_events(db_path) == expected_count
    assert db_path.read_bytes() == first_bytes
    assert _read_scratch_rows(db_path) == fixture_events
