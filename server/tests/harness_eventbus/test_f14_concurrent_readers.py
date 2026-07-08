import asyncio
import sqlite3
import threading

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


def _read_rows(db_path):
    with sqlite3.connect(db_path) as conn:
        conn.row_factory = sqlite3.Row
        rows = conn.execute("SELECT * FROM events").fetchall()
    return _sorted_events(rows)


def _publish_with_concurrent_readers(event_bus, events_db, db_path, events):
    errors = []
    stop = threading.Event()

    def reader_loop():
        while not stop.is_set():
            try:
                events_db.recent(db_path, 25)
                events_db.search(db_path, limit=25)
                events_db.count_by_day(db_path)
            except Exception as exc:
                errors.append(exc)
                stop.set()

    readers = [
        threading.Thread(target=reader_loop, daemon=True)
        for _ in range(3)
    ]
    for thread in readers:
        thread.start()
    try:
        for event in events:
            asyncio.run(event_bus.publish(event))
    finally:
        stop.set()
        for thread in readers:
            thread.join(timeout=2)

    alive = [thread.name for thread in readers if thread.is_alive()]
    return errors, alive


def test_given_real_stream_replay_when_recent_search_and_count_by_day_read_concurrently_then_no_reader_errors_and_rows_match(
    tmp_path, monkeypatch,
):
    from app.config import settings
    from app.services import events_db
    from app.services.event_bus import event_bus

    db_path = tmp_path / "events.db"
    monkeypatch.setattr(settings, "events_db_path", db_path)
    real_connect = events_db.sqlite3.connect

    def short_timeout_connect(path, *args, **kwargs):
        kwargs.setdefault("timeout", 0.2)
        return real_connect(path, *args, **kwargs)

    monkeypatch.setattr(events_db.sqlite3, "connect", short_timeout_connect)
    events_db.init_db(db_path)
    events = _sorted_events(load_json_rows())
    assert len(events) >= 10

    errors, alive = _publish_with_concurrent_readers(event_bus, events_db, db_path, events)

    assert errors == []
    assert alive == []
    assert _read_rows(db_path) == events
