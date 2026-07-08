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


def _first_real_event():
    return sorted(
        (normalize(row) for row in load_json_rows()), key=lambda row: (row["ts"], row["id"])
    )[0]


def _count_events(db_path):
    with sqlite3.connect(db_path) as conn:
        return int(conn.execute("SELECT COUNT(*) FROM events").fetchone()[0])


async def _publish_duplicate_and_read_queue(event_bus, event):
    q = event_bus.subscribe()
    try:
        await event_bus.publish(event)
        await event_bus.publish(event)
        return [
            await asyncio.wait_for(q.get(), timeout=1),
            await asyncio.wait_for(q.get(), timeout=1),
        ]
    finally:
        event_bus.unsubscribe(q)


def test_given_same_real_event_published_twice_then_db_dedupes_but_live_queue_gets_both(
    tmp_path, monkeypatch,
):
    from app.config import settings
    from app.services import events_db
    from app.services.event_bus import event_bus

    db_path = tmp_path / "events.db"
    monkeypatch.setattr(settings, "events_db_path", db_path)
    events_db.init_db(db_path)
    event = _first_real_event()

    received = asyncio.run(_publish_duplicate_and_read_queue(event_bus, event))

    assert _count_events(db_path) == 1
    assert received == [event, event]
