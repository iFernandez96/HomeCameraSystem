"""Direct unit tests for the in-process EventBus."""
import asyncio

import pytest

from app.services.event_bus import EventBus, make_detection_event


@pytest.fixture
def bus() -> EventBus:
    # iter-218 (Feature #6 slice 3): EventBus has no constructor
    # args anymore — history lives in SQLite via events_db, isolated
    # per-test by `_isolate_events_db` in conftest.
    return EventBus()


async def test_subscribe_receives_published_event(bus: EventBus):
    q = bus.subscribe()
    await bus.publish({"type": "detection", "id": "x"})
    evt = await asyncio.wait_for(q.get(), timeout=1)
    assert evt["id"] == "x"


async def test_multiple_subscribers_each_receive(bus: EventBus):
    q1 = bus.subscribe()
    q2 = bus.subscribe()
    await bus.publish({"v": 1})
    e1 = await asyncio.wait_for(q1.get(), timeout=1)
    e2 = await asyncio.wait_for(q2.get(), timeout=1)
    assert e1 == {"v": 1}
    assert e2 == {"v": 1}


async def test_recent_returns_published_events_newest_first(bus: EventBus):
    """iter-218: recent() reads from events_db now. Use full
    DetectionEventDict shape so insert_event accepts the rows. The
    underlying schema/index/cursor behavior is exercised in
    test_events_db.py — this just pins that the bus's recent() is a
    correct passthrough."""
    import time as _time
    base = _time.time()
    ids = []
    for i in range(5):
        evt = make_detection_event(label="person", score=0.5, boxes=[])
        evt["ts"] = base + i  # ascending so newest = last published
        ids.append(evt["id"])
        await bus.publish(evt)
    items = bus.recent(3)
    assert len(items) == 3
    # Newest first — last 3 published, in reverse order of publish.
    assert [it["id"] for it in items] == [ids[4], ids[3], ids[2]]


async def test_recent_returns_empty_list_when_persist_fails(
    bus: EventBus, monkeypatch
):
    """iter-218: when events_db.recent() raises (corrupt DB,
    permissions), bus.recent() falls back to an empty list rather
    than propagating the exception. The /api/events route stays a
    200 with [] instead of a 500."""
    import app.services.events_db as events_db_mod

    def _raise(*_a, **_kw):
        raise OSError("disk gone")

    monkeypatch.setattr(events_db_mod, "recent", _raise)
    items = bus.recent(10)
    assert items == []


async def test_unsubscribe_stops_delivery(bus: EventBus):
    q = bus.subscribe()
    bus.unsubscribe(q)
    await bus.publish({"a": 1})
    assert q.empty()


async def test_unsubscribe_unknown_queue_does_not_raise(bus: EventBus):
    foreign: asyncio.Queue = asyncio.Queue()
    # Should be a no-op, never raise.
    bus.unsubscribe(foreign)


async def test_full_subscriber_queue_drops_event_for_slow_consumer(bus: EventBus):
    q = bus.subscribe()
    # Subscriber queue is bounded (maxsize=64); push beyond capacity.
    for i in range(80):
        await bus.publish({"i": i})
    # Should not block; the bus drops to the slow consumer rather than wait.
    assert q.qsize() <= 64


async def test_reset_is_noop_but_keeps_subscribers(bus: EventBus):
    """iter-218: reset() is now a no-op (deque dropped; history is
    in events_db, isolated per-test by `_isolate_events_db` in
    conftest). The conftest hook still calls it for API stability;
    pin that calling reset() doesn't detach existing subscribers
    (would silently break any test that subscribed before reset)."""
    q = bus.subscribe()
    bus.reset()
    # Subscriber should still receive new events.
    await bus.publish({"id": "c"})
    evt = await asyncio.wait_for(q.get(), timeout=1)
    assert evt["id"] == "c"


async def test_publish_logs_warning_when_subscriber_queue_full(bus: EventBus, caplog):
    """A stalled WebSocket consumer would silently lose events — the
    iter-114 log line makes the stall observable in the journal. We
    publish past the queue's maxsize (64) and assert exactly one
    warning fires (rate-limited per-subscriber), not 65."""
    import logging as _logging

    q = bus.subscribe()
    # Fill the queue to capacity without draining — same shape as a WS
    # consumer that hung mid-handshake.
    for i in range(q.maxsize):
        await bus.publish({"id": f"fill-{i}"})
    assert q.qsize() == q.maxsize

    # Now publish into the full queue. Multiple drops in a row — only
    # the FIRST should log; subsequent are throttled.
    with caplog.at_level(_logging.WARNING, logger="app.services.event_bus"):
        for i in range(5):
            await bus.publish({"id": f"overflow-{i}"})

    overflow_warnings = [
        r for r in caplog.records
        if "subscriber queue full" in r.getMessage()
    ]
    assert len(overflow_warnings) == 1, (
        f"expected exactly one rate-limited warning, got {len(overflow_warnings)}"
    )


async def test_publish_overflow_warning_resets_after_drain(bus: EventBus, caplog):
    """Once the consumer drains and a put_nowait succeeds again, the
    'warned' flag clears so a future re-stall produces a fresh log line.
    Otherwise an intermittent consumer would only ever log once for
    the lifetime of the bus."""
    import logging as _logging

    q = bus.subscribe()
    for i in range(q.maxsize):
        await bus.publish({"id": f"a-{i}"})

    with caplog.at_level(_logging.WARNING, logger="app.services.event_bus"):
        # First overflow logs once.
        await bus.publish({"id": "drop-1"})
    n_first = sum(1 for r in caplog.records if "subscriber queue full" in r.getMessage())
    assert n_first == 1

    # Consumer catches up.
    while not q.empty():
        q.get_nowait()

    caplog.clear()
    # Refill + overflow again — the warned flag should have reset on
    # the first successful put after the drain, so a new warning fires.
    for i in range(q.maxsize):
        await bus.publish({"id": f"b-{i}"})
    with caplog.at_level(_logging.WARNING, logger="app.services.event_bus"):
        await bus.publish({"id": "drop-2"})
    n_second = sum(1 for r in caplog.records if "subscriber queue full" in r.getMessage())
    assert n_second == 1


def test_make_detection_event_default_fields():
    evt = make_detection_event(
        "person", 0.9, [{"x": 0, "y": 0, "w": 0.1, "h": 0.1, "label": "p", "score": 0.9}]
    )
    assert evt["v"] == 1
    assert evt["type"] == "detection"
    assert evt["label"] == "person"
    assert evt["score"] == 0.9
    assert evt["camera_id"] == "cam1"
    assert evt["thumb_url"] is None
    assert isinstance(evt["id"], str) and len(evt["id"]) >= 16
    assert isinstance(evt["ts"], float)
    assert evt["ts"] > 0
    assert isinstance(evt["boxes"], list)


def test_make_detection_event_explicit_overrides():
    evt = make_detection_event(
        "car", 0.5, [], camera_id="cam-front", thumb_url="/snap.jpg"
    )
    assert evt["camera_id"] == "cam-front"
    assert evt["thumb_url"] == "/snap.jpg"


# iter-263 (security-auditor F1): subscriber cap to defend against
# authed-DoS. Once the cap is hit, subscribe() raises
# SubscriberCapReached and the WS handler closes with code 1013.

async def test_when_subscriber_cap_reached_then_subscribe_raises_subscriber_cap_reached(bus):
    # arrange — fill to MAX_SUBSCRIBERS.
    from app.services.event_bus import SubscriberCapReached
    queues = [bus.subscribe() for _ in range(bus.MAX_SUBSCRIBERS)]

    # act / assert
    try:
        bus.subscribe()
        raised = False
    except SubscriberCapReached:
        raised = True
    assert raised, "expected SubscriberCapReached on overflow"
    # cleanup so other tests aren't affected by leftover queues.
    for q in queues:
        bus.unsubscribe(q)


async def test_given_subscriber_unsubscribed_then_a_new_subscribe_succeeds(bus):
    # arrange — fill, then drop one.
    from app.services.event_bus import SubscriberCapReached
    queues = [bus.subscribe() for _ in range(bus.MAX_SUBSCRIBERS)]
    bus.unsubscribe(queues[0])

    # act / assert — capacity restored.
    new_q = bus.subscribe()
    assert new_q is not None
    bus.unsubscribe(new_q)
    for q in queues[1:]:
        bus.unsubscribe(q)
    # silence unused-import lint
    _ = SubscriberCapReached
