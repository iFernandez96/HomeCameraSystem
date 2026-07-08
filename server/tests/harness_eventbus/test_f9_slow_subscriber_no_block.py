import asyncio
import sqlite3
import time

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


def _real_events(limit=80):
    source_events = sorted(
        (normalize(row) for row in load_json_rows()), key=lambda row: (row["ts"], row["id"])
    )
    assert source_events
    events = []
    for i in range(limit):
        event = dict(source_events[i % len(source_events)])
        event["id"] = "{0}-fanout-{1:03d}".format(event["id"], i)
        if i >= len(source_events):
            event["ts"] = source_events[-1]["ts"] + (i - len(source_events) + 1) * 0.001
        events.append(event)
    assert len({event["id"] for event in events}) == limit
    return events


def _count_events(db_path):
    with sqlite3.connect(db_path) as conn:
        return int(conn.execute("SELECT COUNT(*) FROM events").fetchone()[0])


def _p99(values):
    ordered = sorted(values)
    index = max(0, min(len(ordered) - 1, int(len(ordered) * 0.99) - 1))
    return ordered[index]


async def _publish_with_one_stuck_and_one_drained(event_bus, events):
    stuck_q = event_bus.subscribe()
    drained_q = event_bus.subscribe()
    drained = []
    done = asyncio.Event()

    async def drain():
        while len(drained) < len(events):
            drained.append(await asyncio.wait_for(drained_q.get(), timeout=1))
        done.set()

    drain_task = asyncio.create_task(drain())
    latencies = []
    try:
        previous_ts = events[0]["ts"]
        for event in events:
            delay = max(0.0, event["ts"] - previous_ts)
            previous_ts = event["ts"]
            if delay:
                await asyncio.sleep(min(delay / 1000.0, 0.001))
            start = time.perf_counter()
            await event_bus.publish(event)
            latencies.append(time.perf_counter() - start)
            await asyncio.sleep(0)
        await asyncio.wait_for(done.wait(), timeout=2)
        return latencies, drained, stuck_q.qsize()
    finally:
        drain_task.cancel()
        event_bus.unsubscribe(stuck_q)
        event_bus.unsubscribe(drained_q)
        await asyncio.gather(drain_task, return_exceptions=True)


def test_given_stuck_subscriber_when_real_cadence_replayed_then_publish_stays_bounded_and_other_subscriber_gets_all(
    tmp_path, monkeypatch,
):
    from app.config import settings
    from app.services import events_db
    from app.services.event_bus import event_bus

    db_path = tmp_path / "events.db"
    monkeypatch.setattr(settings, "events_db_path", db_path)
    events_db.init_db(db_path)
    events = _real_events()

    latencies, drained, stuck_qsize = asyncio.run(
        _publish_with_one_stuck_and_one_drained(event_bus, events)
    )

    assert _p99(latencies) < 0.100
    assert drained == events
    assert stuck_qsize == 64
    assert _count_events(db_path) == len({event["id"] for event in events})
