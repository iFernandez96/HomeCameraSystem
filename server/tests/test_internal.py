"""Tests for the host-side internal /api/_internal/event endpoint."""
from __future__ import annotations

import asyncio

import pytest
from fastapi.testclient import TestClient


def _payload(**over):
    base = {
        "label": "person",
        "score": 0.91,
        "boxes": [
            {
                "x": 0.1,
                "y": 0.2,
                "w": 0.3,
                "h": 0.4,
                "label": "person",
                "score": 0.91,
            }
        ],
        "camera_id": "cam1",
    }
    base.update(over)
    return base


def test_internal_event_publishes_to_bus(client: TestClient):
    from app.services.event_bus import event_bus

    before = len(event_bus.recent(1000))
    r = client.post("/api/_internal/event", json=_payload())
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is True
    assert isinstance(body["event_id"], str)
    after = len(event_bus.recent(1000))
    assert after == before + 1


def test_internal_event_appears_in_history(client: TestClient):
    client.post("/api/_internal/event", json=_payload(label="car", score=0.77))
    r = client.get("/api/events?limit=5")
    assert r.status_code == 200
    items = r.json()
    labels = [e["label"] for e in items]
    assert "car" in labels


def test_internal_event_streams_over_websocket(client: TestClient):
    # iter-168: WS now requires Origin matching Host. TestClient base
    # is `http://testserver`, so this header is the same-origin handshake.
    with client.websocket_connect(
        "/api/events/ws", headers={"origin": "http://testserver"}
    ) as ws:
        # The TestClient runs the app on its own loop; an HTTP POST from the
        # same client will publish into the bus and we should receive it on
        # the WS within a few hundred ms.
        client.post("/api/_internal/event", json=_payload(label="person", score=0.88))
        evt = ws.receive_json()
        assert evt["type"] == "detection"
        assert evt["label"] == "person"
        assert evt["score"] == 0.88


def test_internal_event_rejects_missing_boxes(client: TestClient):
    r = client.post("/api/_internal/event", json=_payload(boxes=[]))
    assert r.status_code == 422


def test_internal_event_rejects_extra_box_fields(client: TestClient):
    bad = _payload()
    bad["boxes"][0]["malicious"] = "<script>"
    r = client.post("/api/_internal/event", json=bad)
    assert r.status_code == 422


def test_internal_event_rejects_out_of_range_coords(client: TestClient):
    bad = _payload()
    bad["boxes"][0]["x"] = 1.5
    r = client.post("/api/_internal/event", json=bad)
    assert r.status_code == 422


def test_internal_event_rejects_score_above_1(client: TestClient):
    r = client.post("/api/_internal/event", json=_payload(score=1.2))
    assert r.status_code == 422


# --- iter-193 (iter-169 Minor S3 closure): thumb_url regex --------


def test_internal_event_accepts_canonical_thumb_url(client: TestClient):
    """detect.py emits `/snapshots/thumb_<ts-ms>.jpg`. Round-trip the
    canonical format through the route — must NOT 422."""
    r = client.post(
        "/api/_internal/event",
        json=_payload(thumb_url="/snapshots/thumb_1700000000000.jpg"),
    )
    assert r.status_code == 200, r.text


def test_internal_event_accepts_null_thumb_url(client: TestClient):
    """thumb_url is optional — None must still pass."""
    r = client.post(
        "/api/_internal/event",
        json=_payload(thumb_url=None),
    )
    assert r.status_code == 200


def test_internal_event_rejects_external_thumb_url(client: TestClient):
    """A buggy or malicious worker emitting `https://attacker.lan/...`
    would flow unchallenged into WebSocket events AND Web Push hero
    images (iter-188 `image` field). Strict prefix blocks both."""
    r = client.post(
        "/api/_internal/event",
        json=_payload(thumb_url="https://attacker.lan/track.gif"),
    )
    assert r.status_code == 422


def test_internal_event_rejects_path_traversal_thumb_url(client: TestClient):
    """`/snapshots/../etc/passwd` would technically resolve outside
    the snapshots dir. Regex blocks any non-`thumb_<digits>.jpg`
    name."""
    r = client.post(
        "/api/_internal/event",
        json=_payload(thumb_url="/snapshots/../etc/passwd"),
    )
    assert r.status_code == 422


def test_internal_event_rejects_wrong_extension_thumb_url(client: TestClient):
    """The worker today only emits .jpg. A future iter-201 NVENC
    swap might change to .png or .webp — that change MUST update
    the regex deliberately, not slip through silently."""
    r = client.post(
        "/api/_internal/event",
        json=_payload(thumb_url="/snapshots/thumb_42.gif"),
    )
    assert r.status_code == 422


def test_internal_event_rejects_wrong_prefix_thumb_url(client: TestClient):
    """Only `/snapshots/...` is acceptable — `/static/...` or any
    other path must 422."""
    r = client.post(
        "/api/_internal/event",
        json=_payload(thumb_url="/static/thumb_42.jpg"),
    )
    assert r.status_code == 422


def test_internal_event_rejects_javascript_protocol_thumb_url(client: TestClient):
    """Defense in depth — `javascript:alert(1)` is blocked by the
    leading `/snapshots/` requirement (XSS via `<img src>` doesn't
    work for `javascript:` URLs in modern browsers anyway, but
    blocking it at the wire is still correct)."""
    r = client.post(
        "/api/_internal/event",
        json=_payload(thumb_url="javascript:alert(1)"),
    )
    assert r.status_code == 422


# --- iter-204 (Feature #1 slice 4): clip_url payload field --------


def test_internal_event_accepts_canonical_clip_url(client: TestClient):
    """The iter-201 route format is `/api/events/{id}/clip`. Worker
    will emit this once iter-205 wires the recorder."""
    r = client.post(
        "/api/_internal/event",
        json=_payload(clip_url="/api/events/abc-123/clip"),
    )
    assert r.status_code == 200, r.text


def test_internal_event_accepts_null_clip_url(client: TestClient):
    """Optional. Most events today have no clip → null is canonical."""
    r = client.post(
        "/api/_internal/event",
        json=_payload(clip_url=None),
    )
    assert r.status_code == 200


def test_internal_event_rejects_external_clip_url(client: TestClient):
    """Same defense as iter-193 thumb_url: external URL would flow
    into the event payload + WS subscribers + ClipModal video src,
    loading attacker content. Strict prefix blocks both."""
    r = client.post(
        "/api/_internal/event",
        json=_payload(clip_url="https://attacker.lan/clip.mp4"),
    )
    assert r.status_code == 422


def test_internal_event_rejects_path_traversal_clip_url(client: TestClient):
    r = client.post(
        "/api/_internal/event",
        json=_payload(clip_url="/api/events/../etc/passwd/clip"),
    )
    assert r.status_code == 422


def test_internal_event_rejects_clip_url_for_wrong_route(client: TestClient):
    """Even `/api/events/<id>/snapshot` (a different route) must
    422 — the regex pins the exact `/clip` suffix."""
    r = client.post(
        "/api/_internal/event",
        json=_payload(clip_url="/api/events/abc/snapshot"),
    )
    assert r.status_code == 422


def test_clip_url_round_trips_through_event_payload(client: TestClient):
    """Worker emits clip_url; server propagates it through
    `make_detection_event` → event_bus.publish → /api/events GET.
    Pin the round trip so a future refactor of the make_detection_event
    signature can't drop the field silently."""
    client.post(
        "/api/_internal/event",
        json=_payload(clip_url="/api/events/evt_xyz/clip"),
    )
    events = client.get("/api/events").json()
    # Newest first per existing convention.
    assert events[0]["clip_url"] == "/api/events/evt_xyz/clip"


def test_clip_url_defaults_to_null_when_omitted(client: TestClient):
    """Pre-iter-204 worker payloads (no clip_url field) must still
    produce events; the field defaults to None on the wire."""
    client.post("/api/_internal/event", json=_payload())
    events = client.get("/api/events").json()
    assert events[0]["clip_url"] is None


def test_internal_event_rejects_box_x_plus_w_overflows(client: TestClient):
    """Per-field clamps allow x=0.9 and w=0.5 individually, but their
    sum walks off the right edge. The model_validator must reject."""
    bad = _payload()
    bad["boxes"][0]["x"] = 0.9
    bad["boxes"][0]["w"] = 0.5
    r = client.post("/api/_internal/event", json=bad)
    assert r.status_code == 422


def test_internal_event_rejects_box_y_plus_h_overflows(client: TestClient):
    bad = _payload()
    bad["boxes"][0]["y"] = 0.7
    bad["boxes"][0]["h"] = 0.6
    r = client.post("/api/_internal/event", json=bad)
    assert r.status_code == 422


def test_internal_event_accepts_box_at_frame_edge(client: TestClient):
    """A box exactly at the right/bottom edge (x+w == 1, y+h == 1) is
    legitimate — a person standing at the frame boundary. Must pass."""
    edge = _payload()
    edge["boxes"][0]["x"] = 0.5
    edge["boxes"][0]["w"] = 0.5
    edge["boxes"][0]["y"] = 0.5
    edge["boxes"][0]["h"] = 0.5
    r = client.post("/api/_internal/event", json=edge)
    assert r.status_code == 200, r.text


def test_internal_event_accepts_subpixel_edge_overflow(client: TestClient):
    """detection/detect.py clamps each coord to [0,1] independently.
    For a person at the right edge with the network producing Right
    slightly past frame width, x+w can land at 1 + sub-pixel. The
    validator's 1e-3 tolerance (~1.3 px at 720p; 1 px there is
    1/1280 ≈ 7.8e-4) must accept this."""
    edge = _payload()
    edge["boxes"][0]["x"] = 0.5
    edge["boxes"][0]["w"] = 0.5005  # 0.5 px overflow at 1000-wide frame
    r = client.post("/api/_internal/event", json=edge)
    assert r.status_code == 200, r.text


def test_internal_event_rejects_box_just_over_epsilon(client: TestClient):
    """Boundary on the rejection side: x+w = 1.0015 is past the 1e-3
    tolerance. Pin the inclusive-vs-exclusive semantic so a future
    refactor that bumps eps to 1e-2 (looser) or 1e-4 (tighter) trips
    a clear test diff."""
    over = _payload()
    over["boxes"][0]["x"] = 0.5
    over["boxes"][0]["w"] = 0.5015  # 1.5 px overflow at 1000-wide; over eps
    r = client.post("/api/_internal/event", json=over)
    assert r.status_code == 422


def test_internal_event_caps_box_count(client: TestClient):
    box = {
        "x": 0.1, "y": 0.1, "w": 0.1, "h": 0.1,
        "label": "person", "score": 0.5,
    }
    r = client.post(
        "/api/_internal/event",
        json=_payload(boxes=[box for _ in range(64)]),
    )
    assert r.status_code == 422


def test_internal_event_accepts_box_count_at_cap(client: TestClient):
    """Boundary case: exactly 32 boxes (the `max_length` on
    `DetectionPayload.boxes`) is accepted. Pin so a future refactor
    that flips the bound to `< 32` (off-by-one) trips loudly."""
    box = {
        "x": 0.1, "y": 0.1, "w": 0.1, "h": 0.1,
        "label": "person", "score": 0.5,
    }
    r = client.post(
        "/api/_internal/event",
        json=_payload(boxes=[box for _ in range(32)]),
    )
    assert r.status_code == 200, r.text


async def test_internal_event_succeeds_when_push_fanout_raises(client: TestClient):
    """The push fanout is a fire-and-forget asyncio task — if pywebpush
    blows up partway through, the foreground event publish must still
    succeed (UI on the page should never be blocked by a flaky push
    relay)."""
    import asyncio
    from unittest.mock import AsyncMock, patch

    from app.services.event_bus import event_bus

    history_before = len(event_bus.recent(1000))
    failing = AsyncMock(side_effect=RuntimeError("simulated push backend down"))

    with patch("app.services.push_service.push_service.send_matching", failing):
        r = client.post("/api/_internal/event", json=_payload())
        assert r.status_code == 200
        # Wait briefly for the fire-and-forget task to actually run + log.
        for _ in range(20):
            if failing.called:
                break
            await asyncio.sleep(0.01)
        assert failing.called

    # Foreground publish still happened despite the push exception.
    assert len(event_bus.recent(1000)) == history_before + 1


async def test_push_title_uses_person_name_when_matched(client: TestClient):
    """When the worker emits a `person_name` (face-recognition match),
    the push notification title should use that name — `"Israel
    detected"` reads better on a lock-screen than `"Person detected"`.
    Pin the format so a future refactor doesn't accidentally swap the
    branches."""
    import asyncio
    from unittest.mock import AsyncMock, patch

    captured = AsyncMock(return_value=0)
    with patch("app.services.push_service.push_service.send_matching", captured):
        client.post("/api/_internal/event", json=_payload(person_name="israel"))
        for _ in range(20):
            if captured.called:
                break
            await asyncio.sleep(0.01)
        assert captured.called

    payload = captured.call_args.args[1]
    assert payload["title"] == "Israel detected"
    # Body still uses the label-derived "Front Door · NN%" format.
    assert payload["body"].startswith("Front Door ")


async def test_push_title_falls_back_to_label_when_no_person_name(
    client: TestClient,
):
    """No face match → title built from the label. `payload.label
    .title()` capitalises 'person' → 'Person'."""
    import asyncio
    from unittest.mock import AsyncMock, patch

    captured = AsyncMock(return_value=0)
    with patch("app.services.push_service.push_service.send_matching", captured):
        # _payload() has label="person", no person_name.
        client.post("/api/_internal/event", json=_payload())
        for _ in range(20):
            if captured.called:
                break
            await asyncio.sleep(0.01)
        assert captured.called

    payload = captured.call_args.args[1]
    assert payload["title"] == "Person detected"


async def test_push_title_combines_two_names_with_ampersand_when_multi_person(
    client: TestClient,
):
    """iter-357 multi-person push title: when the worker matched two
    known faces, the lock-screen title fans out as 'Israel & Sheenal
    detected' — preserves the iter-188 name-first scanability without
    hiding the second match behind a generic label."""
    import asyncio
    from unittest.mock import AsyncMock, patch

    captured = AsyncMock(return_value=0)
    with patch("app.services.push_service.push_service.send_matching", captured):
        client.post(
            "/api/_internal/event",
            json=_payload(
                person_name="israel", person_names=["israel", "sheenal"],
            ),
        )
        for _ in range(20):
            if captured.called:
                break
            await asyncio.sleep(0.01)
        assert captured.called

    payload = captured.call_args.args[1]
    assert payload["title"] == "Israel & Sheenal detected"


async def test_push_title_uses_plus_others_when_three_or_more_people(
    client: TestClient,
):
    """iter-357 multi-person push title: 3+ names → 'Israel +2 others
    detected'. Caps the lock-screen title length on Android (~65 chars)
    while still surfacing the most-confident match by name."""
    import asyncio
    from unittest.mock import AsyncMock, patch

    captured = AsyncMock(return_value=0)
    with patch("app.services.push_service.push_service.send_matching", captured):
        client.post(
            "/api/_internal/event",
            json=_payload(
                person_name="israel",
                person_names=["israel", "sheenal", "coco"],
            ),
        )
        for _ in range(20):
            if captured.called:
                break
            await asyncio.sleep(0.01)
        assert captured.called

    payload = captured.call_args.args[1]
    assert payload["title"] == "Israel +2 others detected"


async def test_push_payload_includes_image_when_thumb_url_set(
    client: TestClient,
):
    """iter-188 (Feature #7): when the worker provides a `thumb_url`,
    the push payload must carry it as `image` so Chrome/Edge/Firefox
    render the detection thumbnail as the notification's hero image.
    Service worker reads `data.image` and forwards to
    `showNotification`."""
    import asyncio
    from unittest.mock import AsyncMock, patch

    captured = AsyncMock(return_value=0)
    with patch("app.services.push_service.push_service.send_matching", captured):
        client.post(
            "/api/_internal/event",
            json=_payload(thumb_url="/snapshots/thumb_42.jpg"),
        )
        for _ in range(20):
            if captured.called:
                break
            await asyncio.sleep(0.01)
        assert captured.called

    payload = captured.call_args.args[1]
    assert payload.get("image") == "/snapshots/thumb_42.jpg"


async def test_push_payload_omits_image_when_thumb_url_absent(
    client: TestClient,
):
    """iter-188 (Feature #7): no thumb_url → no `image` key in the
    push payload (vs `image: null/None`). Absent-key keeps the SW's
    `typeof data.image === 'string'` guard simple and DevTools tidy."""
    import asyncio
    from unittest.mock import AsyncMock, patch

    captured = AsyncMock(return_value=0)
    with patch("app.services.push_service.push_service.send_matching", captured):
        # _payload() default has no thumb_url.
        client.post("/api/_internal/event", json=_payload())
        for _ in range(20):
            if captured.called:
                break
            await asyncio.sleep(0.01)
        assert captured.called

    payload = captured.call_args.args[1]
    assert "image" not in payload, (
        "expected `image` key absent when thumb_url is None; "
        "got payload={!r}".format(payload)
    )


async def test_given_event_posted_when_push_fanout_called_then_payload_carries_event_id_for_per_event_tag(
    client: TestClient,
):
    # iter-276 (widget-usability-auditor C1 server side): the SW push
    # handler uses `data.event_id` as the Notification.tag so detection
    # bursts don't collapse into one notification. Server MUST include
    # the canonical event id in every push payload.
    import asyncio
    from unittest.mock import AsyncMock, patch

    # arrange
    captured = AsyncMock(return_value=0)

    # act
    with patch(
        "app.services.push_service.push_service.send_matching", captured
    ):
        r = client.post("/api/_internal/event", json=_payload())
        for _ in range(20):
            if captured.called:
                break
            await asyncio.sleep(0.01)

    # assert: event_id from the response equals the one in the push
    # payload. Both are server-generated when the worker omits id.
    assert captured.called
    body = r.json()
    expected_id = body["event_id"]
    payload = captured.call_args.args[1]
    assert payload.get("event_id") == expected_id


async def test_given_two_events_posted_within_one_second_when_push_fanout_runs_then_unread_count_is_fetched_only_once(
    client: TestClient,
):
    # iter-288 (security-auditor F1): bursts of detection events
    # MUST NOT spawn one SQLite COUNT per emit. Cache TTL is 1 s;
    # a 2-event burst within that window should hit events_db once.
    #
    # iter-290 (test-integrity-auditor B): pre-iter-290 this test
    # patched `asyncio.to_thread` globally + commented "Other
    # to_thread call sites would inflate the count" — brittle
    # because a future iter adding a thread-shim anywhere in the
    # /api/_internal/event call path would silently break the
    # assertion. Patching `events_db.unread_count` directly is the
    # specific seam the SUT calls, so the assertion measures
    # exactly what it claims (cache hit count).
    import asyncio
    from unittest.mock import AsyncMock, MagicMock, patch

    # arrange
    captured = AsyncMock(return_value=0)
    # `events_db.unread_count` is sync (called via asyncio.to_thread
    # inside _send_push). MagicMock with a return value is the right
    # spy shape — asyncio.to_thread runs it on the thread pool and
    # awaits the result.
    count_spy = MagicMock(return_value=42)

    # act: post two events back-to-back; both should land before
    # the 1-second TTL elapses.
    with patch(
        "app.services.push_service.push_service.send_matching", captured
    ), patch(
        "app.services.events_db.unread_count", count_spy
    ):
        client.post("/api/_internal/event", json=_payload())
        client.post("/api/_internal/event", json=_payload())
        for _ in range(20):
            if captured.call_count >= 2:
                break
            await asyncio.sleep(0.01)

    # assert
    assert captured.call_count == 2
    # iter-288 cache contract: count fetched ONCE despite 2 events.
    # The spy is on the SUT's exact dependency (events_db.unread_count),
    # so the count is precise — no false positives from unrelated
    # `to_thread` calls in the path.
    assert count_spy.call_count == 1


async def test_given_event_posted_when_push_fanout_called_then_payload_carries_unread_count_for_setAppBadge(
    client: TestClient,
):
    # iter-276 (widget-usability-auditor A1): the SW push handler
    # forwards `data.unread_count` to setAppBadge so the home-screen
    # badge updates even when the PWA is closed. Server MUST refresh
    # the unread count from events_db on every fanout and include it.
    import asyncio
    from unittest.mock import AsyncMock, patch

    # arrange
    captured = AsyncMock(return_value=0)

    # act
    with patch(
        "app.services.push_service.push_service.send_matching", captured
    ):
        client.post("/api/_internal/event", json=_payload())
        for _ in range(20):
            if captured.called:
                break
            await asyncio.sleep(0.01)

    # assert: unread_count is an int >= 1 (we just inserted an event,
    # so at least one row is unseen unless a prior test marked all).
    # Lower bound is the right contract — the count is global and
    # other tests in the same session may have inserted events too.
    assert captured.called
    payload = captured.call_args.args[1]
    assert "unread_count" in payload
    assert isinstance(payload["unread_count"], int)
    assert payload["unread_count"] >= 1


async def test_internal_event_does_not_block_on_slow_push(client: TestClient):
    """If push fanout takes a long time (slow Apple/Google relay), the
    foreground POST must return promptly."""
    import asyncio
    import time
    from unittest.mock import AsyncMock, patch

    async def slow_push(_payload):
        await asyncio.sleep(2.0)
        return 0

    slow = AsyncMock(side_effect=slow_push)

    with patch("app.services.push_service.push_service.send_matching", slow):
        t0 = time.monotonic()
        r = client.post("/api/_internal/event", json=_payload())
        elapsed = time.monotonic() - t0
        assert r.status_code == 200
        assert elapsed < 0.5  # should return well before the 2 s push fakes


async def test_background_tasks_set_holds_strong_ref():
    """iter-176: pre-iter-176 the push fanout used a bare
    `asyncio.create_task(_send_push(payload))` and discarded the
    returned Task. CPython issue #44665: the event loop only weakly
    references created tasks, so the GC can collect a still-pending
    task and emit `Task was destroyed but it is pending!` while
    silently dropping the work. iter-176 added a module-level
    `_BACKGROUND_TASKS` set + done_callback.

    This is a direct unit test of the pattern (not a route-integration
    test) — the TestClient runs FastAPI in a separate event loop from
    the test, so cross-loop synchronization (e.g., setting an asyncio
    Event across loops) doesn't reliably wake awaits in the other loop.
    The pattern itself is what we're verifying:

      1. Adding a Task to `_BACKGROUND_TASKS` while pending makes the
         set non-empty.
      2. The `add_done_callback(set.discard)` removes the Task on
         completion.

    Route-level integration is covered by
    `test_internal_event_does_not_block_on_slow_push` and
    `test_internal_event_fans_to_push_subscribers` already.
    """
    import asyncio

    from app.routes._internal import _BACKGROUND_TASKS

    # Snapshot before so we don't false-positive on prior leakage.
    before = set(_BACKGROUND_TASKS)

    started = asyncio.Event()
    release = asyncio.Event()

    async def slow():
        started.set()
        await release.wait()

    task = asyncio.create_task(slow())
    _BACKGROUND_TASKS.add(task)
    task.add_done_callback(_BACKGROUND_TASKS.discard)

    # Wait for the slow coro to start, proving the task is pending.
    await asyncio.wait_for(started.wait(), timeout=1.0)

    # Strong-ref invariant in flight.
    assert task in _BACKGROUND_TASKS, (
        "task missing from _BACKGROUND_TASKS while pending"
    )
    assert len(_BACKGROUND_TASKS) == len(before) + 1

    # Release and let the task complete.
    release.set()
    await task
    # Yield once so the done_callback runs.
    await asyncio.sleep(0)

    # Discarded on completion.
    assert task not in _BACKGROUND_TASKS, (
        "task still in _BACKGROUND_TASKS after completion — "
        "done_callback discard didn't fire."
    )
    assert _BACKGROUND_TASKS == before


# logging-plan (docs/logging_plan.md §2 push/detection): the push-fanout
# done-callback must (a) discard the task from the strong-ref set AND
# (b) retrieve task.exception() so a fanout crash that escaped
# _send_push's own try/except is logged with the event id, not swallowed
# as an unattributed "Task exception was never retrieved" at GC time.


async def test_given_push_task_crashes_when_done_callback_runs_then_exception_logged_with_event_id(
    caplog,
):
    """Given a push-fanout task that raises, When its done-callback
    fires, Then the exception is retrieved + logged at ERROR with the
    event id (and the task is discarded from the strong-ref set).

    logging-plan §2: regression guard so a crash in the background push
    task is never silent.
    """
    # arrange
    import logging

    from app.routes._internal import _BACKGROUND_TASKS, _make_push_done_callback

    async def boom():
        raise RuntimeError("push exploded")

    task = asyncio.create_task(boom())
    _BACKGROUND_TASKS.add(task)
    task.add_done_callback(_make_push_done_callback("evt-boom-1"))

    # act — let the task run + the done-callback fire.
    with caplog.at_level(logging.ERROR, logger="app.routes._internal"):
        with pytest.raises(RuntimeError):
            await task
        await asyncio.sleep(0)  # yield so the done-callback runs

    # assert — discarded from the set; ERROR names the event id.
    assert task not in _BACKGROUND_TASKS
    error_lines = [
        rec.getMessage()
        for rec in caplog.records
        if rec.levelno == logging.ERROR
    ]
    assert any(
        "push fanout task crashed" in m and "evt-boom-1" in m
        for m in error_lines
    ), "expected ERROR naming the crashed event id; got {!r}".format(error_lines)


def test_given_detection_paused_when_event_posted_then_drop_logged_at_debug(
    client: TestClient, caplog,
):
    """Given detection paused, When the worker posts an event, Then the
    route drops it (200) AND logs the drop at DEBUG with the label.

    logging-plan §2: the 'healthy but zero events' footgun — surface WHY
    no events reach the bus when the Detect toggle is off.
    """
    # arrange
    import logging

    from app.services.detection import detection_service

    was_active = detection_service.active
    if detection_service.active:
        client.post("/api/detection/toggle")
    assert detection_service.active is False

    # act
    with caplog.at_level(logging.DEBUG, logger="app.routes._internal"):
        r = client.post("/api/_internal/event", json=_payload())

    # assert
    assert r.status_code == 200
    assert r.json().get("dropped") == "detection paused"
    debug_lines = [
        rec.getMessage()
        for rec in caplog.records
        if rec.levelno == logging.DEBUG
    ]
    assert any(
        "event dropped: detection paused" in m for m in debug_lines
    ), "expected DEBUG noting the paused drop; got {!r}".format(debug_lines)

    # restore for later tests in this module.
    if was_active and not detection_service.active:
        client.post("/api/detection/toggle")


def test_given_heartbeat_with_off_whitelist_field_when_posted_then_drop_logged_once(
    client: TestClient, caplog,
):
    """Given a heartbeat carrying an off-whitelist field, When posted,
    Then the drop is logged once at DEBUG (once-flag) and not on the
    next heartbeat.

    logging-plan §2: metric-coercion drops are silent today; the
    once-flag keeps a misbehaving worker from flooding the 10s hot path.
    """
    # arrange — reset the module once-flag so this test is deterministic.
    import logging

    from app.routes import _internal as _int_mod

    _int_mod._heartbeat_drop_warned = False

    # act — first heartbeat with an unknown field triggers the log.
    with caplog.at_level(logging.DEBUG, logger="app.routes._internal"):
        client.post(
            "/api/_internal/heartbeat",
            json={"fps": 4.0, "not_a_real_metric": 7},
        )
        first = [
            rec.getMessage()
            for rec in caplog.records
            if rec.levelno == logging.DEBUG
            and "heartbeat dropped metric fields" in rec.getMessage()
        ]
        caplog.clear()
        # second heartbeat with the same off-whitelist field is suppressed.
        client.post(
            "/api/_internal/heartbeat",
            json={"fps": 5.0, "not_a_real_metric": 9},
        )
        second = [
            rec.getMessage()
            for rec in caplog.records
            if "heartbeat dropped metric fields" in rec.getMessage()
        ]

    # assert — logged once, suppressed thereafter.
    assert len(first) == 1, "expected one DEBUG drop line; got {!r}".format(first)
    assert "not_a_real_metric" in first[0]
    assert second == [], "drop line not suppressed by once-flag: {!r}".format(second)


def test_heartbeat_marks_worker_alive(client: TestClient):
    from app.services.health import worker_health

    assert worker_health.is_alive() is False
    r = client.post("/api/_internal/heartbeat")
    assert r.status_code == 200
    assert r.json() == {"ok": True}
    assert worker_health.is_alive() is True


def test_heartbeat_with_metrics_records_them(client: TestClient):
    from app.services.health import worker_health

    r = client.post(
        "/api/_internal/heartbeat",
        json={"fps": 4.7, "infer_per_s": 1.2, "gear": "active", "frames": 100},
    )
    assert r.status_code == 200
    assert worker_health.is_alive() is True
    metrics = worker_health.metrics()
    assert metrics == {"fps": 4.7, "infer_per_s": 1.2, "gear": "active", "frames": 100}


def test_heartbeat_passes_uptime_s_through(client: TestClient):
    from app.services.health import worker_health

    client.post(
        "/api/_internal/heartbeat",
        json={"fps": 4.0, "uptime_s": 12345.6},
    )
    metrics = worker_health.metrics()
    assert metrics is not None
    assert metrics["uptime_s"] == 12345.6


def test_heartbeat_passes_mediamtx_restarts_through(client: TestClient):
    from app.services.health import worker_health

    client.post(
        "/api/_internal/heartbeat",
        json={"fps": 4.0, "mediamtx_restarts": 2},
    )
    metrics = worker_health.metrics()
    assert metrics is not None
    assert metrics["mediamtx_restarts"] == 2


def test_heartbeat_passes_infer_ms_p95_through(client: TestClient):
    from app.services.health import worker_health

    client.post(
        "/api/_internal/heartbeat",
        json={"fps": 4.0, "infer_ms_recent": 39.0, "infer_ms_p95": 65.5},
    )
    metrics = worker_health.metrics()
    assert metrics is not None
    assert metrics["infer_ms_p95"] == 65.5


def test_given_p95_in_heartbeat_when_status_polled_then_field_round_trips(
    client: TestClient,
):
    """iter-356.62 (camera-algorithm-auditor pre-YOLO win 2): pin
    that `infer_ms_p95` survives the full wire path
    heartbeat → WorkerHealth → /api/status.worker_metrics.

    Distinct from the WorkerHealth-only sibling above: this hits the
    user-facing `/api/status` endpoint so any silent strip in the
    status route or response model fails here. Single dedicated pin
    so a regression bisects to ONE assertion, not the
    every-field round-trip test."""
    # arrange — heartbeat with p95 = 123.4 (the spec's exemplar value).
    payload = {"fps": 4.0, "infer_ms_recent": 50.0, "infer_ms_p95": 123.4}

    # act — post the heartbeat, then ask /api/status what it sees.
    r = client.post("/api/_internal/heartbeat", json=payload)
    assert r.status_code == 200
    body = client.get("/api/status").json()

    # assert — field present AND value preserved end-to-end. Neither
    # the whitelist nor the status route nor any response coercion
    # is allowed to drop it.
    assert body["worker_alive"] is True
    metrics = body["worker_metrics"]
    assert metrics is not None
    assert "infer_ms_p95" in metrics, (
        "infer_ms_p95 missing from /api/status.worker_metrics — wire dropped it"
    )
    assert metrics["infer_ms_p95"] == 123.4


def test_heartbeat_passes_infer_ms_recent_through(client: TestClient):
    from app.services.health import worker_health

    client.post(
        "/api/_internal/heartbeat",
        json={"fps": 4.0, "infer_ms_recent": 47.3},
    )
    metrics = worker_health.metrics()
    assert metrics is not None
    assert metrics["infer_ms_recent"] == 47.3


def test_heartbeat_passes_dropped_frames_through(client: TestClient):
    from app.services.health import worker_health

    client.post(
        "/api/_internal/heartbeat",
        json={"fps": 4.0, "frames": 1000, "dropped": 7},
    )
    metrics = worker_health.metrics()
    assert metrics is not None
    assert metrics["dropped"] == 7
    assert metrics["frames"] == 1000


def test_heartbeat_passes_face_recog_names_through(client: TestClient):
    from app.services.health import worker_health

    client.post(
        "/api/_internal/heartbeat",
        json={"fps": 1.0, "face_recog_names": ["israel", "sheenal"]},
    )
    metrics = worker_health.metrics()
    assert metrics is not None
    assert metrics["face_recog_names"] == ["israel", "sheenal"]


def test_heartbeat_drops_wrong_type_for_numeric_field(client: TestClient):
    """A buggy worker that serialises `fps` as a string instead of a
    number must not poison the worker_metrics snapshot. The bad
    field gets dropped per-field, not the whole heartbeat."""
    from app.services.health import worker_health

    client.post(
        "/api/_internal/heartbeat",
        json={"fps": "garbage", "gear": "active", "frames": 100},
    )
    metrics = worker_health.metrics()
    assert metrics is not None
    # Bad fps dropped, valid fields kept.
    assert "fps" not in metrics
    assert metrics["gear"] == "active"
    assert metrics["frames"] == 100


def test_heartbeat_drops_wrong_type_for_gear(client: TestClient):
    from app.services.health import worker_health

    client.post(
        "/api/_internal/heartbeat",
        json={"fps": 4.0, "gear": 42},  # gear should be string
    )
    metrics = worker_health.metrics()
    assert metrics is not None
    assert metrics["fps"] == 4.0
    assert "gear" not in metrics


def test_heartbeat_drops_empty_gear(client: TestClient):
    """An empty or whitespace-only `gear` string would render as a
    blank worker-pill in the UI. Drop per-field; sibling fields kept."""
    from app.services.health import worker_health

    client.post(
        "/api/_internal/heartbeat",
        json={"fps": 4.0, "gear": "", "frames": 10},
    )
    metrics = worker_health.metrics()
    assert metrics is not None
    assert "gear" not in metrics
    assert metrics["fps"] == 4.0
    assert metrics["frames"] == 10

    client.post(
        "/api/_internal/heartbeat",
        json={"fps": 4.0, "gear": "   ", "frames": 11},
    )
    metrics = worker_health.metrics()
    assert metrics is not None
    assert "gear" not in metrics


def test_heartbeat_drops_oversized_gear(client: TestClient):
    """A buggy worker emitting a huge `gear` string would inflate
    every `/api/status` response. Cap at 32 chars per the iter-117
    constant."""
    from app.services.health import worker_health

    client.post(
        "/api/_internal/heartbeat",
        json={"fps": 4.0, "gear": "x" * 64},
    )
    metrics = worker_health.metrics()
    assert metrics is not None
    assert "gear" not in metrics
    assert metrics["fps"] == 4.0


def test_heartbeat_strips_whitespace_around_gear(client: TestClient):
    """A worker that emits `gear=' active '` (rare, but defensive) gets
    the leading/trailing space normalised so the UI's `=== 'active'`
    comparisons still match."""
    from app.services.health import worker_health

    client.post(
        "/api/_internal/heartbeat",
        json={"fps": 4.0, "gear": "  active  "},
    )
    metrics = worker_health.metrics()
    assert metrics is not None
    assert metrics["gear"] == "active"


def test_heartbeat_drops_non_str_face_recog_names(client: TestClient):
    from app.services.health import worker_health

    client.post(
        "/api/_internal/heartbeat",
        json={"face_recog_names": ["israel", 42, "sheenal"]},
    )
    metrics = worker_health.metrics()
    # All-or-nothing for the list — if any element isn't a string, the
    # whole field is dropped (mixed types would confuse the UI's chip
    # rendering).
    assert metrics is None or "face_recog_names" not in metrics


def test_heartbeat_drops_oversized_face_recog_names_list(client: TestClient):
    """A buggy/malicious worker pumping 1000 names into the heartbeat
    would inflate every `/api/status` response. iter-118 caps the list
    at 50 entries — past that, drop the whole field per-iter-78
    all-or-nothing semantics."""
    from app.services.health import worker_health

    huge = [f"name_{i}" for i in range(60)]
    client.post(
        "/api/_internal/heartbeat",
        json={"fps": 1.0, "face_recog_names": huge},
    )
    metrics = worker_health.metrics()
    assert metrics is not None
    assert "face_recog_names" not in metrics
    assert metrics["fps"] == 1.0


def test_heartbeat_drops_face_recog_names_with_oversized_entry(client: TestClient):
    """A single 1MB name in the list would slip past the iter-78
    `isinstance(x, str)` check. Cap each entry at 64 chars
    (matching iter-112 CLASS_NAME_MAX)."""
    from app.services.health import worker_health

    client.post(
        "/api/_internal/heartbeat",
        json={"fps": 1.0, "face_recog_names": ["israel", "x" * 100]},
    )
    metrics = worker_health.metrics()
    assert metrics is not None
    assert "face_recog_names" not in metrics
    assert metrics["fps"] == 1.0


def test_heartbeat_drops_face_recog_names_with_empty_entry(client: TestClient):
    """An empty-string name would render as a chip with no text in
    the UI. Drop the field if any entry is empty."""
    from app.services.health import worker_health

    client.post(
        "/api/_internal/heartbeat",
        json={"fps": 1.0, "face_recog_names": ["israel", "", "sheenal"]},
    )
    metrics = worker_health.metrics()
    assert metrics is not None
    assert "face_recog_names" not in metrics


def test_heartbeat_accepts_face_recog_names_at_max_size(client: TestClient):
    """Boundary case: exactly 50 names (the cap) is legal."""
    from app.services.health import worker_health

    names = [f"n_{i:03d}" for i in range(50)]
    client.post(
        "/api/_internal/heartbeat",
        json={"face_recog_names": names},
    )
    metrics = worker_health.metrics()
    assert metrics is not None
    assert metrics["face_recog_names"] == names


def test_heartbeat_accepts_face_recog_name_exactly_at_char_cap(client: TestClient):
    """Boundary case: a name of exactly 64 chars (`_FACE_RECOG_NAME_LEN_MAX`)
    is accepted. A future refactor that flips the `>` to `>=` would
    reject this and trip the test."""
    from app.services.health import worker_health

    client.post(
        "/api/_internal/heartbeat",
        json={"face_recog_names": ["x" * 64]},
    )
    metrics = worker_health.metrics()
    assert metrics is not None
    assert metrics["face_recog_names"] == ["x" * 64]


def test_heartbeat_rejects_face_recog_name_one_over_char_cap(client: TestClient):
    """Boundary case: 65 chars (one over `_FACE_RECOG_NAME_LEN_MAX`)
    drops the whole face_recog_names field per the iter-118 strict-
    cap rule. Sibling fields still land per iter-78 partial-heartbeat
    semantics."""
    from app.services.health import worker_health

    client.post(
        "/api/_internal/heartbeat",
        json={"fps": 1.0, "face_recog_names": ["x" * 65]},
    )
    metrics = worker_health.metrics()
    assert metrics is not None
    assert metrics["fps"] == 1.0
    assert "face_recog_names" not in metrics


def test_heartbeat_rejects_nan_for_numeric_fields(client: TestClient):
    """A buggy worker that divides by zero in the metrics computation
    could produce NaN. Python's json.loads accepts `NaN` by default,
    and `isinstance(NaN, float)` is True — so NaN would slip through
    `_coerce_metric` if we only checked types. The browser's
    JSON.parse would then choke on the `/api/status` response. Drop
    NaN per-field rather than poisoning the snapshot."""
    from app.services.health import worker_health

    r = client.post(
        "/api/_internal/heartbeat",
        content=b'{"fps": NaN, "gear": "active", "frames": 100}',
        headers={"Content-Type": "application/json"},
    )
    assert r.status_code == 200
    metrics = worker_health.metrics()
    assert metrics is not None
    assert "fps" not in metrics
    assert metrics["gear"] == "active"
    assert metrics["frames"] == 100


def test_heartbeat_rejects_pos_inf_for_numeric_fields(client: TestClient):
    from app.services.health import worker_health

    r = client.post(
        "/api/_internal/heartbeat",
        content=b'{"fps": Infinity, "gear": "active"}',
        headers={"Content-Type": "application/json"},
    )
    assert r.status_code == 200
    metrics = worker_health.metrics()
    assert metrics is not None
    assert "fps" not in metrics
    assert metrics["gear"] == "active"


def test_heartbeat_rejects_neg_inf_for_numeric_fields(client: TestClient):
    from app.services.health import worker_health

    r = client.post(
        "/api/_internal/heartbeat",
        content=b'{"infer_ms_recent": -Infinity, "fps": 4.0}',
        headers={"Content-Type": "application/json"},
    )
    assert r.status_code == 200
    metrics = worker_health.metrics()
    assert metrics is not None
    assert "infer_ms_recent" not in metrics
    assert metrics["fps"] == 4.0


def test_heartbeat_excludes_bool_from_numeric_fields(client: TestClient):
    """Python's `isinstance(True, int)` is True — easy to accidentally
    accept booleans as numeric. The coercer explicitly excludes them."""
    from app.services.health import worker_health

    client.post(
        "/api/_internal/heartbeat",
        json={"fps": True, "frames": False, "gear": "active"},
    )
    metrics = worker_health.metrics()
    assert metrics is not None
    assert "fps" not in metrics
    assert "frames" not in metrics
    assert metrics["gear"] == "active"


def test_heartbeat_metrics_drop_unknown_fields(client: TestClient):
    from app.services.health import worker_health

    client.post(
        "/api/_internal/heartbeat",
        json={"fps": 4.0, "malicious": "<script>", "secret": 42},
    )
    metrics = worker_health.metrics()
    assert metrics is not None
    assert "malicious" not in metrics
    assert "secret" not in metrics
    assert metrics["fps"] == 4.0


def test_heartbeat_with_all_bad_types_preserves_prior_metrics(client: TestClient):
    """If every metric in a heartbeat fails type coercion (iter-78),
    the resulting `picked` dict is empty and `WorkerHealth` should
    only bump the timestamp — existing metrics remain. Pin the
    property so the partial-heartbeat semantics don't accidentally
    regress to "wipe everything on any malformed heartbeat."
    """
    from app.services.health import worker_health

    # First, a clean heartbeat that populates the metrics snapshot.
    client.post(
        "/api/_internal/heartbeat",
        json={"fps": 5.0, "gear": "active", "frames": 100},
    )
    assert worker_health.metrics() == {"fps": 5.0, "gear": "active", "frames": 100}

    # Now an all-bad-types heartbeat: every field has the wrong type
    # for its key (iter-78's coercer drops them all). The handler
    # should still bump the alive timestamp but leave prior metrics
    # intact rather than overwriting with an empty dict.
    r = client.post(
        "/api/_internal/heartbeat",
        json={"fps": "string", "gear": 99, "frames": [1, 2, 3]},
    )
    assert r.status_code == 200
    assert worker_health.metrics() == {"fps": 5.0, "gear": "active", "frames": 100}


def test_heartbeat_with_empty_body_still_works(client: TestClient):
    from app.services.health import worker_health

    r = client.post("/api/_internal/heartbeat", content=b"")
    assert r.status_code == 200
    assert worker_health.is_alive() is True


def test_heartbeat_with_malformed_json_still_works(client: TestClient):
    from app.services.health import worker_health

    r = client.post(
        "/api/_internal/heartbeat",
        content=b"not valid json {",
        headers={"Content-Type": "application/json"},
    )
    assert r.status_code == 200
    assert worker_health.is_alive() is True


def test_worker_snapshot_keys_match_whitelist():
    """Cross-check the producer/consumer contract: every key the worker
    emits via `Metrics.snapshot()` must be in the server's whitelist
    (so it isn't silently stripped), and every whitelist field must
    correspond to something the worker actually emits (so we don't
    accumulate dead allowlist entries the UI mistakenly reads).

    This catches the failure mode that the per-field heartbeat tests
    and the iter-56 round-trip integration test both miss: a metric
    added on only one side of the wire. Pinning the symmetric
    relationship here makes a future drift fail loudly with the
    diff.
    """
    import sys
    from pathlib import Path

    # `detection/` lives one level up from `server/` in the repo. Add
    # it to sys.path just for this test so we can import the worker's
    # Metrics module without dragging in `jetson_inference` / detect.py.
    detection_dir = Path(__file__).resolve().parent.parent.parent / "detection"
    sys.path.insert(0, str(detection_dir))
    try:
        from metrics import Metrics  # type: ignore[import-not-found]
    finally:
        sys.path.remove(str(detection_dir))

    from app.routes._internal import _ALLOWED_METRIC_FIELDS

    snapshot_keys = set(Metrics().snapshot().keys())
    whitelist = set(_ALLOWED_METRIC_FIELDS)

    assert snapshot_keys == whitelist, (
        "worker Metrics.snapshot() keys diverge from server whitelist:\n"
        f"  worker emits but server strips: {snapshot_keys - whitelist}\n"
        f"  server allows but worker omits: {whitelist - snapshot_keys}"
    )


def test_every_whitelisted_metric_round_trips_to_status(client: TestClient):
    """End-to-end pin: every field in `_ALLOWED_METRIC_FIELDS` should
    flow heartbeat → WorkerHealth → /api/status.worker_metrics. Catches
    the failure mode where a new metric is added on the worker side
    and the whitelist is updated, but `WorkerHealth.metrics()` or some
    intermediate code path silently strips it before the UI sees it.

    The payload values are arbitrary but each type matches the
    domain: numeric counters use ints, latencies/timings use floats,
    `gear` is a string, `face_recog_names` is a list."""
    from app.routes._internal import _ALLOWED_METRIC_FIELDS

    payload = {
        "fps": 4.5,
        "infer_per_s": 1.2,
        "gear": "active",
        "frames": 100,
        "inferences": 27,
        "emitted": 3,
        "dropped": 1,
        "infer_ms_recent": 42.3,
        "infer_ms_p95": 51.0,
        "mediamtx_restarts": 2,
        "thumb_ms_recent": 18.7,
        "uptime_s": 600.0,
        "face_recog_names": ["israel", "sheenal"],
        # iter-302: stream-stale signal + nvargus escalation count.
        "last_frame_ts": 1700000000.0,
        "argus_restarts": 0,
        # logging-plan §1.2: failure-rate counters.
        "clips_dropped_capacity": 0,
        "clip_start_failures": 0,
        "face_recog_failures": 0,
        "event_post_failures": 0,
        "thumb_save_failures": 0,
    }
    # If this assertion fires, _ALLOWED_METRIC_FIELDS has grown a key
    # the test doesn't know about — add it to `payload` above.
    assert set(payload.keys()) == set(_ALLOWED_METRIC_FIELDS), (
        "test fixture is out of sync with whitelist: "
        f"missing={set(_ALLOWED_METRIC_FIELDS) - set(payload.keys())} "
        f"extra={set(payload.keys()) - set(_ALLOWED_METRIC_FIELDS)}"
    )
    r = client.post("/api/_internal/heartbeat", json=payload)
    assert r.status_code == 200

    body = client.get("/api/status").json()
    assert body["worker_alive"] is True
    metrics = body["worker_metrics"]
    assert metrics is not None
    for key, expected in payload.items():
        assert key in metrics, f"{key} missing from /api/status.worker_metrics"
        assert metrics[key] == expected, (
            f"{key}: expected {expected!r}, got {metrics[key]!r}"
        )


def test_status_hides_metrics_when_worker_dies(client: TestClient, monkeypatch):
    """`worker_metrics` must not show stale data once the alive window
    expires — otherwise the UI would report a dead worker as 'detect 5/s'."""
    from app.services.health import worker_health

    client.post("/api/_internal/heartbeat", json={"gear": "active", "fps": 4.0})
    body = client.get("/api/status").json()
    assert body["worker_alive"] is True
    assert body["worker_metrics"]["gear"] == "active"

    # Force the alive window to expire by backdating the heartbeat.
    monkeypatch.setattr(worker_health, "alive_window_s", 0.001)
    body = client.get("/api/status").json()
    assert body["worker_alive"] is False
    assert body["worker_metrics"] is None


def test_event_post_also_acts_as_heartbeat(client: TestClient):
    from app.services.health import worker_health

    assert worker_health.is_alive() is False
    r = client.post("/api/_internal/event", json=_payload())
    assert r.status_code == 200
    assert worker_health.is_alive() is True


def test_status_reports_worker_alive_after_heartbeat(client: TestClient):
    s = client.get("/api/status").json()
    assert s["worker_alive"] is False
    assert s["worker_last_seen_s"] is None
    client.post("/api/_internal/heartbeat")
    s2 = client.get("/api/status").json()
    assert s2["worker_alive"] is True
    assert isinstance(s2["worker_last_seen_s"], (int, float))
    assert s2["worker_last_seen_s"] >= 0.0


def test_internal_event_accepts_person_name(client: TestClient):
    r = client.post(
        "/api/_internal/event",
        json=_payload(person_name="Israel"),
    )
    assert r.status_code == 200, r.text
    # Stored event should propagate the matched name through the bus.
    items = client.get("/api/events?limit=5").json()
    assert items[0]["person_name"] == "Israel"


def test_internal_event_omits_person_name_when_unset(client: TestClient):
    client.post("/api/_internal/event", json=_payload())
    items = client.get("/api/events?limit=5").json()
    assert items[0]["person_name"] is None


def test_internal_event_rejects_blank_person_name(client: TestClient):
    r = client.post("/api/_internal/event", json=_payload(person_name=""))
    assert r.status_code == 422


def test_given_worker_supplies_id_when_event_published_then_event_uses_that_id(
    client: TestClient,
):
    # arrange — iter-247 lets the worker generate the uuid locally so
    # the recorder filename and the server-side event id match.
    supplied = "abc123def456"
    payload = _payload()
    payload["id"] = supplied

    # act
    r = client.post("/api/_internal/event", json=payload)

    # assert
    assert r.status_code == 200
    events = client.get("/api/events?limit=1").json()
    assert len(events) == 1
    assert events[0]["id"] == supplied


def test_when_worker_omits_id_then_server_generates_uuid(client: TestClient):
    # arrange — legacy/simulator path: payload without id.
    payload = _payload()
    payload.pop("id", None)

    # act
    r = client.post("/api/_internal/event", json=payload)

    # assert
    assert r.status_code == 200
    events = client.get("/api/events?limit=1").json()
    assert len(events) == 1
    # uuid hex is 32 lowercase chars 0-9a-f.
    assert len(events[0]["id"]) == 32
    assert all(c in "0123456789abcdef" for c in events[0]["id"])


def test_when_worker_supplies_invalid_id_then_422(client: TestClient):
    # arrange — strict charset matches the route regex on
    # `/api/events/{event_id}/clip` so a malicious id can never
    # produce a clip URL that escapes it.
    payload = _payload()
    payload["id"] = "../etc/passwd"

    # act
    r = client.post("/api/_internal/event", json=payload)

    # assert
    assert r.status_code == 422


def test_when_worker_polls_internal_detection_config_then_returns_canonical_shape(
    client: TestClient,
):
    # arrange
    # detection_config has a stable on-disk default — no setup needed.

    # act
    r = client.get("/api/_internal/detection/config")

    # assert
    assert r.status_code == 200
    body = r.json()
    # Shape mirrors asdict(DetectionConfig.get()) — must include every
    # field the user-facing /api/detection/config returns since worker
    # code reads `threshold` / `cooldown_s` / `enabled` directly off
    # this payload (iter-244).
    assert "threshold" in body
    assert "cooldown_s" in body
    assert "enabled" in body


def test_when_anonymous_client_polls_internal_detection_config_then_carve_out_returns_200(
    client_anon: TestClient,
):
    # arrange
    # client_anon carries no auth cookie; iter-184 gate would 401 on the
    # user-facing /api/detection/config. The /api/_internal/* carve-out
    # must keep this open for the worker (iter-244 fix-forward).

    # act
    r = client_anon.get("/api/_internal/detection/config")

    # assert
    assert r.status_code == 200


def test_given_user_patches_config_when_worker_polls_internal_then_new_threshold_observed(
    client: TestClient,
):
    # arrange
    new_threshold = 0.42

    # act
    patch_resp = client.patch(
        "/api/detection/config", json={"threshold": new_threshold}
    )
    poll_resp = client.get("/api/_internal/detection/config")

    # assert
    assert patch_resp.status_code == 200, "PATCH on user-facing route should succeed"
    assert poll_resp.status_code == 200
    assert poll_resp.json()["threshold"] == new_threshold


def test_internal_event_dropped_when_detection_paused(client: TestClient):
    """The /api/detection/toggle UI control gates whether worker events
    surface to clients. When paused, the route still returns 200 but the
    event is not published or pushed."""
    from app.services.detection import detection_service
    from app.services.event_bus import event_bus

    # Toggle off (default starts on).
    initial_active = detection_service.active
    if initial_active:
        client.post("/api/detection/toggle")
    assert detection_service.active is False

    history_before = len(event_bus.recent(1000))
    r = client.post("/api/_internal/event", json=_payload())
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert "dropped" in body
    assert len(event_bus.recent(1000)) == history_before

    # Restore for any later tests in this module.
    if initial_active:
        client.post("/api/detection/toggle")


# ─── iter-357 multi-person face-recognition payload tests ────────────────


def test_given_legacy_single_person_name_only_when_event_posted_then_accepted_and_person_names_is_none(
    client: TestClient,
):
    """Backward compat sentinel: a worker that emits ONLY the iter-22
    `person_name` field (no `person_names`) must continue to round-trip
    cleanly. The new `person_names` column reads back as None — old
    clients reading only `person_name` see no shape change."""
    # arrange
    payload = _payload(person_name="alice")

    # act
    r = client.post("/api/_internal/event", json=payload)

    # assert
    assert r.status_code == 200, r.text
    history = client.get("/api/events?limit=1").json()
    assert history[0]["person_name"] == "alice"
    # Field IS present in the wire shape (for clients that already
    # support it) but is null on legacy events.
    assert history[0].get("person_names") is None


def test_given_multi_person_names_only_when_event_posted_then_legacy_field_derived_from_first(
    client: TestClient,
):
    """Server-side normalization invariant: when the worker emits ONLY
    `person_names` (without setting `person_name`), the route fills
    `person_name = person_names[0]` so the iter-216 SQLite indexed
    column + every search-by-name code path keeps working."""
    # arrange
    payload = _payload(person_names=["israel", "sheenal"])

    # act
    r = client.post("/api/_internal/event", json=payload)

    # assert
    assert r.status_code == 200, r.text
    items = client.get("/api/events?limit=1").json()
    assert items[0]["person_name"] == "israel"
    assert items[0]["person_names"] == ["israel", "sheenal"]


def test_given_multi_person_payload_when_event_posted_then_round_trips_through_db(
    client: TestClient,
):
    """The iter-357 person_names_json column round-trips a multi-person
    list through INSERT + SELECT cleanly — proves the schema migration
    + JSON encode/decode + _row_to_event path are wired end to end."""
    # arrange
    names = ["alice", "bob", "charlie"]
    payload = _payload(person_name="alice", person_names=names)

    # act
    post = client.post("/api/_internal/event", json=payload)
    history = client.get("/api/events?limit=1")

    # assert
    assert post.status_code == 200, post.text
    assert history.status_code == 200
    items = history.json()
    assert items[0]["person_names"] == names


def test_given_payload_with_person_name_mismatching_first_of_person_names_when_posted_then_rejected_422(
    client: TestClient,
):
    """The Pydantic model_validator rejects payloads where the legacy
    `person_name` doesn't match `person_names[0]`. Silently picking
    one would mask a worker bug — 422 is the right loudness."""
    # arrange — worker bug: legacy field disagrees with list head.
    payload = _payload(person_name="alice", person_names=["bob", "alice"])

    # act
    r = client.post("/api/_internal/event", json=payload)

    # assert
    assert r.status_code == 422, r.text


def test_given_person_names_with_empty_string_entry_when_posted_then_rejected_422(
    client: TestClient,
):
    """Per-item bound: each entry in person_names must be 1..64 chars
    non-empty. Pydantic's `max_length=16` only caps the LIST; the
    model_validator enforces per-item bounds so a malformed worker
    can't inject zero-length names that render as a blank chip."""
    # arrange
    payload = _payload(person_names=["alice", ""])

    # act
    r = client.post("/api/_internal/event", json=payload)

    # assert
    assert r.status_code == 422, r.text


def test_given_person_names_with_too_long_entry_when_posted_then_rejected_422(
    client: TestClient,
):
    # arrange — 65-char name exceeds the per-entry 64-char bound.
    long_name = "a" * 65
    payload = _payload(person_names=[long_name])

    # act
    r = client.post("/api/_internal/event", json=payload)

    # assert
    assert r.status_code == 422, r.text


def test_given_person_names_list_over_cap_when_posted_then_rejected_422(
    client: TestClient,
):
    """List-level bound: 16 entries max. A worker that ignores its own
    HOMECAM_MAX_PERSONS_FACE_RECOG cap (or a malicious payload over a
    forged loopback) can't pump arbitrary lists into the bus."""
    # arrange — 17 entries (cap + 1).
    too_many = ["p{}".format(i) for i in range(17)]
    payload = _payload(person_names=too_many)

    # act
    r = client.post("/api/_internal/event", json=payload)

    # assert
    assert r.status_code == 422, r.text


def test_given_multi_person_event_when_published_then_websocket_carries_person_names(
    client: TestClient,
):
    """The new field flows over the WebSocket too — clients listening
    to `/api/events/ws` see person_names on the live event payload, not
    just on the REST history endpoint."""
    # arrange — iter-168 origin-gate requires the same-origin
    # `Origin: http://testserver` header on WS upgrades.
    same_origin = {"origin": "http://testserver"}
    with client.websocket_connect("/api/events/ws", headers=same_origin) as ws:
        payload = _payload(
            person_name="alice", person_names=["alice", "bob"],
        )
        post = client.post("/api/_internal/event", json=payload)
        assert post.status_code == 200, post.text

        # act — receive the broadcast.
        evt = ws.receive_json()

    # assert
    assert evt["person_name"] == "alice"
    assert evt["person_names"] == ["alice", "bob"]


def test_given_event_with_no_face_match_when_posted_then_both_fields_absent_or_null(
    client: TestClient,
):
    """The iter-22 / iter-357 dormant case: worker had no match. Both
    fields end up null (or absent) in the stored event — the UI
    `recognizedNames` helper returns [] and renders the generic label
    branch."""
    # arrange — no person fields set.
    payload = _payload()

    # act
    r = client.post("/api/_internal/event", json=payload)

    # assert
    assert r.status_code == 200, r.text
    items = client.get("/api/events?limit=1").json()
    assert items[0].get("person_name") in (None, "")
    assert items[0].get("person_names") is None


# --- client_log sink (logging-plan §1.3) -----------------------------------


def test_given_anon_client_when_posting_client_log_then_accepted_unauthenticated(
    client_anon: TestClient,
):
    """The PWA ships device-side error/warn logs to this sink. It lives
    under the unauthenticated `_internal` router so it works on the
    anon login screen (CLAUDE.md pin: `_internal` is never auth-gated)."""
    # arrange
    body = {"level": "error", "event": "webrtc:whep-failed", "fields": {"status": 503}}

    # act
    r = client_anon.post("/api/_internal/client_log", json=body)

    # assert
    assert r.status_code == 200, r.text
    assert r.json() == {"ok": True}


def test_given_unknown_field_when_posting_client_log_then_422_forbid_extra(
    client_anon: TestClient,
):
    """`extra='forbid'` so a buggy/malicious client can't smuggle
    arbitrary top-level keys into the journal."""
    # arrange — `endpoint` is not a declared field.
    body = {"level": "warn", "event": "x", "endpoint": "https://evil.example"}

    # act
    r = client_anon.post("/api/_internal/client_log", json=body)

    # assert
    assert r.status_code == 422, r.text


def test_given_bad_level_when_posting_client_log_then_422(client_anon: TestClient):
    """Level is regex-pinned to error|warn|info|debug."""
    # arrange
    body = {"level": "fatal", "event": "x"}

    # act
    r = client_anon.post("/api/_internal/client_log", json=body)

    # assert
    assert r.status_code == 422, r.text


def test_given_burst_over_cap_when_posting_client_log_then_excess_dropped(
    client_anon: TestClient,
):
    """App-level rate cap (NOT middleware) bounds journal/SD-card writes
    so a looping client can't flood. Past the cap the route returns
    `{ok: False, dropped: 'rate'}` instead of logging."""
    # arrange — reset the module-global bucket so the count is deterministic.
    from app.routes import _internal

    _internal._client_log_bucket["ts"] = 0.0
    _internal._client_log_bucket["count"] = 0
    body = {"level": "info", "event": "spam"}

    # act — fire one past the per-window cap.
    accepted = 0
    dropped = 0
    for _ in range(_internal._CLIENT_LOG_MAX_PER_WINDOW + 5):
        resp = client_anon.post("/api/_internal/client_log", json=body).json()
        if resp.get("ok"):
            accepted += 1
        elif resp.get("dropped") == "rate":
            dropped += 1

    # assert — exactly the cap is accepted, the rest are shed.
    assert accepted == _internal._CLIENT_LOG_MAX_PER_WINDOW
    assert dropped == 5

    # cleanup — leave the bucket clear for any later test in this process.
    _internal._client_log_bucket["ts"] = 0.0
    _internal._client_log_bucket["count"] = 0
