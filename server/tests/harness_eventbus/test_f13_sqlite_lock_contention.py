import asyncio
import logging
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


def _events(limit=3):
    rows = sorted(
        (normalize(row) for row in load_json_rows()),
        key=lambda row: (row["ts"], row["id"]),
    )
    assert len(rows) >= limit
    events = []
    for i, row in enumerate(rows[:limit]):
        event = dict(row)
        event["id"] = "{0}-locked-{1}".format(event["id"], i)
        events.append(event)
    return events


def _count_events(db_path):
    with sqlite3.connect(db_path) as conn:
        return int(conn.execute("SELECT COUNT(*) FROM events").fetchone()[0])


async def _publish_while_locked(event_bus, events):
    q = event_bus.subscribe()
    received = []
    try:
        for event in events:
            await event_bus.publish(event)
            received.append(await asyncio.wait_for(q.get(), timeout=1))
    finally:
        event_bus.unsubscribe(q)
    return received


def test_given_sqlite_write_lock_when_events_publish_then_current_fail_open_behavior_is_pinned(
    tmp_path, monkeypatch, caplog,
):
    from app.config import settings
    from app.log import RateLimitedLog
    from app.services import events_db
    from app.services.event_bus import event_bus

    db_path = tmp_path / "events.db"
    monkeypatch.setattr(settings, "events_db_path", db_path)
    events_db.init_db(db_path)
    event_bus._persist_fail_gate = RateLimitedLog(60.0)

    real_connect = events_db.sqlite3.connect

    def short_timeout_connect(path, *args, **kwargs):
        # Product gap to consider later: events_db has no explicit busy_timeout,
        # so lock contention waits on sqlite3's default before failing open.
        kwargs.setdefault("timeout", 0.05)
        return real_connect(path, *args, **kwargs)

    lock_conn = real_connect(db_path)
    try:
        lock_conn.execute("BEGIN IMMEDIATE")
        lock_conn.execute(
            "INSERT INTO events (id, ts, camera_id, label, score, boxes_json) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            ("lock-holder", 1.0, "front_door", "person", 0.1, "[]"),
        )
        monkeypatch.setattr(events_db.sqlite3, "connect", short_timeout_connect)

        events = _events()
        with caplog.at_level(logging.WARNING, logger="app.services.event_bus"):
            received = asyncio.run(_publish_while_locked(event_bus, events))
    finally:
        lock_conn.rollback()
        lock_conn.close()

    warnings = [
        record
        for record in caplog.records
        if "event-store write failed" in record.getMessage()
    ]
    assert received == events
    assert _count_events(db_path) == 0
    assert len(warnings) == 1


def test_given_sqlite_lock_released_when_later_event_publishes_then_persistence_recovers(
    tmp_path, monkeypatch,
):
    from app.config import settings
    from app.services import events_db
    from app.services.event_bus import event_bus

    db_path = tmp_path / "events.db"
    monkeypatch.setattr(settings, "events_db_path", db_path)
    events_db.init_db(db_path)

    event = _events(limit=1)[0]
    asyncio.run(event_bus.publish(event))

    assert _count_events(db_path) == 1
