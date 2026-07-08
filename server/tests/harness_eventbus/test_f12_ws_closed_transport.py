import asyncio
import logging
from types import SimpleNamespace

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


class ClosedSendWebSocket:
    def __init__(self):
        self.headers = {"origin": "http://testserver", "host": "testserver"}
        self.cookies = {"homecam_access": "token"}
        self.client = SimpleNamespace(host="127.0.0.1")
        self.accepted = False
        self.sent = []

    async def accept(self):
        self.accepted = True

    async def close(self, code=1000, reason=None):
        self.closed = (code, reason)

    async def send_json(self, data):
        self.sent.append(data)
        raise RuntimeError('Cannot call "send" once a close message has been sent.')


def _events(limit=2):
    rows = sorted(
        (normalize(row) for row in load_json_rows()),
        key=lambda row: (row["ts"], row["id"]),
    )
    assert len(rows) >= limit
    events = []
    for i, row in enumerate(rows[:limit]):
        event = dict(row)
        event["id"] = "{0}-ws-closed-{1}".format(event["id"], i)
        events.append(event)
    return events


async def _closed_transport_scenario(event_bus, events, ws):
    from app.routes.events import events_ws

    task = asyncio.create_task(events_ws(ws))
    while not event_bus._subs:
        await asyncio.sleep(0)

    await event_bus.publish(events[0])
    await asyncio.wait_for(task, timeout=2)

    assert event_bus._subs == []

    later_q = event_bus.subscribe()
    try:
        await event_bus.publish(events[1])
        later = await asyncio.wait_for(later_q.get(), timeout=1)
    finally:
        event_bus.unsubscribe(later_q)
    return later


def test_given_ws_send_raises_closed_transport_when_event_fans_out_then_ws_logs_and_unsubscribes_without_poisoning_bus(
    tmp_path, monkeypatch, caplog,
):
    from app.config import settings
    from app.routes import events as events_route
    from app.services import events_db
    from app.services.event_bus import event_bus

    db_path = tmp_path / "events.db"
    monkeypatch.setattr(settings, "events_db_path", db_path)
    events_db.init_db(db_path)
    monkeypatch.setattr(events_route.tokens, "decode", lambda token, kind: {"sub": "alice"})
    monkeypatch.setattr(events_route.users_db, "get_user", lambda path, sub: {"username": sub})

    events = _events()
    ws = ClosedSendWebSocket()
    with caplog.at_level(logging.ERROR, logger="app.routes.events"):
        later = asyncio.run(_closed_transport_scenario(event_bus, events, ws))

    assert ws.accepted
    assert ws.sent == [events[0]]
    assert later == events[1]
    assert any("events websocket crashed" in record.getMessage() for record in caplog.records)
