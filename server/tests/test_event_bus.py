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


async def test_given_subscriber_metadata_when_active_watchers_then_returns_presence(
    bus: EventBus,
):
    # arrange
    q = bus.subscribe(jti="access1", username="alice")

    # act
    watchers = bus.active_watchers()

    # assert
    assert len(watchers) == 1
    assert watchers[0]["jti"] == "access1"
    assert watchers[0]["username"] == "alice"
    assert isinstance(watchers[0]["since"], float)
    bus.unsubscribe(q)
    assert bus.active_watchers() == []


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
    # docs/multicam_contract.md: default camera id matches the
    # registry default (front_door) so a camera-less caller lands
    # on the single configured camera.
    assert evt["camera_id"] == "front_door"
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


# --- logging-plan §5 #6: persist re-logs every 60s under sustained failure ---

async def test_given_sustained_persist_failure_then_relogs_after_window_not_suppressed(
    bus: EventBus, monkeypatch, caplog
):
    """Given the events_db write keeps failing (disk stays full), When
    events are published across a fake clock spanning the 60s gate
    window, Then the warning is NOT fully suppressed after the first
    line — it re-logs once the window elapses. This is the regression
    over the old once-per-process flag that went silent forever."""
    import logging as _logging
    import app.services.events_db as events_db_mod
    import app.log as applog_mod

    # arrange — every insert raises (sustained disk-full).
    def _raise(*_a, **_kw):
        raise OSError("disk full")

    monkeypatch.setattr(events_db_mod, "insert_event", _raise)

    # Fake monotonic clock INJECTED into the gate — NOT patched onto the
    # global `time` module (doing that corrupts asyncio's event-loop
    # clock and breaks every subsequent async test).
    now = {"t": 1000.0}
    bus._persist_fail_gate = applog_mod.RateLimitedLog(60.0, clock=lambda: now["t"])

    # act / assert
    with caplog.at_level(_logging.WARNING, logger="app.services.event_bus"):
        # First failure at t=1000 → logs once.
        await bus.publish(make_detection_event("person", 0.5, []))
        # Still inside the window (t=1030) → suppressed.
        now["t"] = 1030.0
        await bus.publish(make_detection_event("person", 0.5, []))
        # Window elapsed (t=1061) → re-logs.
        now["t"] = 1061.0
        await bus.publish(make_detection_event("person", 0.5, []))

    persist_warns = [
        r for r in caplog.records
        if "event-store write failed" in r.getMessage()
    ]
    # Exactly two lines: t=1000 + t=1061. The t=1030 publish is
    # suppressed (still inside the window) — proving rate-limiting,
    # not full suppression.
    assert len(persist_warns) == 2, (
        "expected 2 re-logs across the 60s window, got "
        "{0}".format(len(persist_warns))
    )


async def test_given_persist_failure_then_warning_names_event_id_and_db_path(
    bus: EventBus, monkeypatch, caplog
):
    """The persist-fail line must carry the dropped event id + db path
    so the operator can correlate a missing event with the write
    failure."""
    import logging as _logging
    import app.services.events_db as events_db_mod
    import app.log as applog_mod
    from app.config import settings

    # arrange
    def _raise(*_a, **_kw):
        raise OSError("disk full")

    monkeypatch.setattr(events_db_mod, "insert_event", _raise)
    bus._persist_fail_gate = applog_mod.RateLimitedLog(60.0)
    evt = make_detection_event("person", 0.5, [])

    # act
    with caplog.at_level(_logging.WARNING, logger="app.services.event_bus"):
        await bus.publish(evt)

    # assert — id + db path present.
    warns = [
        r for r in caplog.records
        if "event-store write failed" in r.getMessage()
    ]
    assert warns
    msg = warns[0].getMessage()
    assert evt["id"] in msg
    assert str(settings.events_db_path) in msg


async def test_slow_event_store_write_does_not_block_event_loop(bus, monkeypatch):
    """A slow SQLite/fsync path runs in a worker thread, not on the loop."""
    import time
    import app.services.events_db as events_db_mod

    def _slow(*_args, **_kwargs):
        time.sleep(0.08)
        return True

    monkeypatch.setattr(events_db_mod, "insert_event", _slow)
    publish = asyncio.create_task(
        bus.publish(make_detection_event("person", 0.5, []))
    )
    ticked = False
    for _ in range(5):
        await asyncio.sleep(0.005)
        ticked = True
        if publish.done():
            break
    assert ticked is True
    assert publish.done() is False
    await publish


async def test_concurrent_event_store_writes_are_serialized(bus, monkeypatch):
    import threading
    import time
    import app.services.events_db as events_db_mod

    active = 0
    peak = 0
    guard = threading.Lock()

    def _tracked(*_args, **_kwargs):
        nonlocal active, peak
        with guard:
            active += 1
            peak = max(peak, active)
        time.sleep(0.02)
        with guard:
            active -= 1
        return True

    monkeypatch.setattr(events_db_mod, "insert_event", _tracked)
    await asyncio.gather(*[
        bus.publish(make_detection_event("person", 0.5, []))
        for _ in range(5)
    ])
    assert peak == 1
