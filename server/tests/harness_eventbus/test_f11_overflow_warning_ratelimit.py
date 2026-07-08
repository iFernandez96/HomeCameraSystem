import asyncio
import logging

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


def _real_events(limit=134):
    source_events = sorted(
        (normalize(row) for row in load_json_rows()), key=lambda row: (row["ts"], row["id"])
    )
    assert source_events
    events = []
    for i in range(limit):
        event = dict(source_events[i % len(source_events)])
        event["id"] = "{0}-warn-{1:03d}".format(event["id"], i)
        if i >= len(source_events):
            event["ts"] = source_events[-1]["ts"] + (i - len(source_events) + 1) * 0.001
        events.append(event)
    assert len({event["id"] for event in events}) == limit
    return events


def _overflow_warnings(records):
    return [record for record in records if "subscriber queue full" in record.getMessage()]


async def _fill_queue(event_bus, q, events):
    for event in events[: q.maxsize - q.qsize()]:
        await event_bus.publish(event)
    assert q.qsize() == q.maxsize


async def _warning_reset_scenario(event_bus, events, caplog):
    q = event_bus.subscribe()
    try:
        await _fill_queue(event_bus, q, events)

        with caplog.at_level(logging.WARNING, logger="app.services.event_bus"):
            for event in events[64:69]:
                await event_bus.publish(event)
        first_window_count = len(_overflow_warnings(caplog.records))

        while not q.empty():
            q.get_nowait()
        await event_bus.publish(events[69])

        caplog.clear()
        await _fill_queue(event_bus, q, events[70:133])
        with caplog.at_level(logging.WARNING, logger="app.services.event_bus"):
            await event_bus.publish(events[133])
        second_window_count = len(_overflow_warnings(caplog.records))

        return first_window_count, second_window_count
    finally:
        event_bus.unsubscribe(q)


def test_given_sustained_overflow_when_queue_stays_full_then_warning_logs_once_until_successful_put_resets(
    tmp_path, monkeypatch, caplog,
):
    from app.config import settings
    from app.services import events_db
    from app.services.event_bus import event_bus

    db_path = tmp_path / "events.db"
    monkeypatch.setattr(settings, "events_db_path", db_path)
    events_db.init_db(db_path)

    first_window_count, second_window_count = asyncio.run(
        _warning_reset_scenario(event_bus, _real_events(), caplog)
    )

    assert first_window_count == 1
    assert second_window_count == 1
