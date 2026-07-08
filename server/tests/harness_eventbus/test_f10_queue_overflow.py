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


def _real_events(limit=70):
    source_events = sorted(
        (normalize(row) for row in load_json_rows()), key=lambda row: (row["ts"], row["id"])
    )
    assert source_events
    events = []
    for i in range(limit):
        event = dict(source_events[i % len(source_events)])
        event["id"] = "{0}-overflow-{1:03d}".format(event["id"], i)
        if i >= len(source_events):
            event["ts"] = source_events[-1]["ts"] + (i - len(source_events) + 1) * 0.001
        events.append(event)
    assert len({event["id"] for event in events}) == limit
    return events


def _count_events(db_path):
    with sqlite3.connect(db_path) as conn:
        return int(conn.execute("SELECT COUNT(*) FROM events").fetchone()[0])


async def _publish_overflow_scenario(event_bus, events):
    stuck_q = event_bus.subscribe()
    drained_q = event_bus.subscribe()
    drained = []
    done = asyncio.Event()

    async def drain():
        while len(drained) < len(events):
            drained.append(await asyncio.wait_for(drained_q.get(), timeout=1))
        done.set()

    drain_task = asyncio.create_task(drain())
    try:
        for event in events:
            await event_bus.publish(event)
            await asyncio.sleep(0)
        await asyncio.wait_for(done.wait(), timeout=2)
        stuck_items = []
        while not stuck_q.empty():
            stuck_items.append(stuck_q.get_nowait())
        still_subscribed = stuck_q in event_bus._subs and drained_q in event_bus._subs
        return stuck_items, drained, still_subscribed
    finally:
        drain_task.cancel()
        event_bus.unsubscribe(stuck_q)
        event_bus.unsubscribe(drained_q)
        await asyncio.gather(drain_task, return_exceptions=True)


def test_given_undrained_subscriber_when_queue_overflows_then_only_that_subscriber_drops_and_db_persists_all(
    tmp_path, monkeypatch,
):
    from app.config import settings
    from app.services import events_db
    from app.services.event_bus import event_bus

    db_path = tmp_path / "events.db"
    monkeypatch.setattr(settings, "events_db_path", db_path)
    events_db.init_db(db_path)
    events = _real_events()

    stuck_items, drained, still_subscribed = asyncio.run(
        _publish_overflow_scenario(event_bus, events)
    )

    assert stuck_items == events[:64]
    assert drained == events
    assert still_subscribed
    assert _count_events(db_path) == len(events)
