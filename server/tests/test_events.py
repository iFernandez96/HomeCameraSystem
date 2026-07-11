import json

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

# iter-168: TestClient's default base_url is `http://testserver`, so a
# same-origin handshake passes Origin matching the request's Host.
# Production callers (the PWA) get this for free — the browser sends
# Origin matching the served origin.
_SAME_ORIGIN_HEADERS = {"origin": "http://testserver"}


def _assert_ws_closes_with_1008(
    client: TestClient, headers: dict[str, str] | None = None
) -> None:
    with client.websocket_connect("/api/events/ws", headers=headers or {}) as ws:
        with pytest.raises(WebSocketDisconnect) as exc:
            ws.receive_text()
    assert exc.value.code == 1008


def test_get_events_returns_list(client: TestClient):
    r = client.get("/api/events")
    assert r.status_code == 200
    assert isinstance(r.json(), list)


def test_get_events_respects_limit(client: TestClient):
    r = client.get("/api/events?limit=10")
    assert r.status_code == 200
    body = r.json()
    assert isinstance(body, list)
    assert len(body) <= 10


def test_given_clip_lifecycle_when_listing_events_then_video_status_is_truthful(
    client: TestClient,
):
    # arrange
    from app.config import settings

    recording_id = "evt-recording"
    available_id = "evt-available"
    unknown_id = "evt-unknown"
    assert _post_event(client, id=recording_id).status_code == 200
    assert _post_event(client, id=available_id).status_code == 200
    assert _post_event(client, id=unknown_id).status_code == 200
    (settings.recordings_dir / ".clip_state.json").write_text(json.dumps({
        "v": 1,
        "events": {
            recording_id: {"state": "recording"},
            # This stale state cannot prove the missing MP4 is playable.
            unknown_id: {"state": "available"},
        },
    }))
    (settings.recordings_dir / "{}.mp4".format(available_id)).write_bytes(
        b"published"
    )

    # act
    items = client.get("/api/events?limit=10").json()
    by_id = {item["id"]: item for item in items}

    # assert
    assert by_id[recording_id]["video_status"] == "recording"
    assert by_id[available_id]["video_status"] == "available"
    assert by_id[unknown_id]["video_status"] == "unknown"


def test_given_failed_clip_when_searching_events_then_video_status_is_in_page(
    client: TestClient,
):
    # arrange
    from app.config import settings

    event_id = "evt-failed"
    assert _post_event(client, id=event_id).status_code == 200
    (settings.recordings_dir / ".clip_state.json").write_text(json.dumps({
        "v": 1,
        "events": {event_id: {"state": "failed"}},
    }))

    # act
    body = client.get("/api/events/search?limit=10").json()

    # assert
    assert body["items"][0]["id"] == event_id
    assert body["items"][0]["video_status"] == "failed"


def test_get_events_rejects_zero_limit(client: TestClient):
    r = client.get("/api/events?limit=0")
    assert r.status_code == 422


def test_get_events_rejects_excessive_limit(client: TestClient):
    r = client.get("/api/events?limit=10000")
    assert r.status_code == 422


def test_websocket_accepts_same_origin_connection(client: TestClient):
    """iter-233 (test-integrity calibration finding): pre-iter-233 this
    test was just `with client.websocket_connect(...): pass` — relied on
    the context manager raising on failure. That made the test pass even
    if the server were ever changed to silently accept-then-immediately-
    close. Now we publish a real event server-side and verify the WS
    consumer receives it — proves the connection is open AND bidirectional
    AND the iter-168 origin gate let it through."""
    with client.websocket_connect(
        "/api/events/ws", headers=_SAME_ORIGIN_HEADERS
    ) as ws:
        _post_event(client, label="person")
        evt = ws.receive_json()
        assert evt["type"] == "detection"
        assert evt["label"] == "person"


def test_websocket_rejects_missing_origin_header(client: TestClient):
    """iter-168: a WS handshake with NO Origin is suspicious — browsers
    always send Origin on WS upgrades, and this endpoint has no non-
    browser consumer (the worker uses REST `/api/_internal/*`, not the
    WS). Reject with close code 1008 (Policy Violation)."""
    _assert_ws_closes_with_1008(client)


def test_websocket_rejects_cross_origin(client: TestClient):
    """iter-168: a malicious LAN page at `http://attacker.lan/` would
    carry `Origin: http://attacker.lan` while the server's Host is
    `testserver`. Same-origin check rejects with 1008. Pre-iter-168
    this test would have been a successful WS upgrade and the
    attacker-page would have streamed every detection event in real
    time, including `person_name` matches."""
    _assert_ws_closes_with_1008(
        client, headers={"origin": "http://attacker.lan"}
    )


def test_websocket_rejects_origin_with_matching_path_but_different_host(
    client: TestClient,
):
    """iter-168 corner case: a clever attacker might set Origin to
    `http://testserver.attacker.lan` hoping a startswith check would
    pass. Pin that we use full netloc equality, not prefix match."""
    _assert_ws_closes_with_1008(
        client, headers={"origin": "http://testserver.attacker.lan"}
    )


def _post_event(client: TestClient, **over):
    """Helper — POST a minimal valid detection event."""
    body = {
        "label": over.pop("label", "person"),
        "score": over.pop("score", 0.9),
        "boxes": over.pop("boxes", [
            {"x": 0.1, "y": 0.2, "w": 0.3, "h": 0.4,
             "label": "person", "score": 0.9},
        ]),
        "camera_id": over.pop("camera_id", "cam1"),
        **over,
    }
    return client.post("/api/_internal/event", json=body)


def test_get_events_returns_newest_first(client: TestClient):
    """The route is read in reverse-history order so the most recent
    detection sits at index 0 — the Events page renders that way and
    the contract has been load-bearing since iter-7."""
    _post_event(client, label="car")
    _post_event(client, label="person")
    _post_event(client, label="dog")
    items = client.get("/api/events").json()
    labels = [e["label"] for e in items]
    # The three we just posted should be the newest, in reverse order.
    assert labels[:3] == ["dog", "person", "car"]


def test_history_unbounded_after_sqlite_swap(client: TestClient):
    """iter-218 (Feature #6 slice 3): the deque + maxlen=200 cap is
    GONE. /api/events now reads from SQLite, which holds every event
    until an operator-side retention sweeper (slice 5, optional)
    prunes them. After 250 posts we should see all 250 (capped only
    by the route's `limit=1000` Pydantic bound)."""
    for i in range(250):
        _post_event(client, label="person", score=0.5 + (i % 50) / 100)

    items = client.get("/api/events?limit=1000").json()
    # Per-test events_db is isolated by `_isolate_events_db` so prior
    # tests' events don't leak in. Only the 250 we just posted appear.
    assert len(items) == 250


def test_websocket_rejects_anonymous_handshake(client_anon: TestClient):
    """iter-185 (Auth Plan Phase 6): the WS handshake now requires
    a valid `homecam_access` cookie. Anonymous clients close with
    1008 reason='auth required' — same code as the iter-168 origin gate
    so the client's iter-182 no-auto-retry treatment applies cleanly."""
    _assert_ws_closes_with_1008(client_anon, headers=_SAME_ORIGIN_HEADERS)


def test_websocket_rejects_invalid_access_cookie(client_anon: TestClient):
    """Cookie present but garbage — auth gate fires, close 1008."""
    client_anon.cookies.set(
        "homecam_access", "not-a-real-jwt", domain="testserver", path="/api"
    )
    _assert_ws_closes_with_1008(client_anon, headers=_SAME_ORIGIN_HEADERS)


def test_websocket_rejects_refresh_token_in_access_slot(client_anon: TestClient):
    """Kind mismatch — a refresh token presented as the access cookie
    must be rejected even though its signature is valid (the iter-181
    `tokens.decode(token, kind='access')` enforces the kind claim)."""
    from app.auth import passwords, tokens, users_db
    from app.config import settings
    users_db.init_db(settings.users_db_path)
    try:
        users_db.create_user(
            settings.users_db_path,
            "kindtest",
            passwords.hash_password("p"),
            role="admin",
        )
    except Exception:
        pass
    refresh_token = tokens.issue("kindtest", "refresh")
    client_anon.cookies.set(
        "homecam_access", refresh_token, domain="testserver", path="/api"
    )
    _assert_ws_closes_with_1008(client_anon, headers=_SAME_ORIGIN_HEADERS)


def test_websocket_rejects_token_for_deleted_user(client_anon: TestClient):
    """Token signed by current secret, but the user was deleted
    while the access token was still TTL-valid. Auth gate must NOT
    revive the session — close 1008."""
    import sqlite3
    from app.auth import passwords, tokens, users_db
    from app.config import settings
    users_db.init_db(settings.users_db_path)
    try:
        users_db.create_user(
            settings.users_db_path,
            "ghost",
            passwords.hash_password("p"),
            role="admin",
        )
    except Exception:
        pass
    access_token = tokens.issue("ghost", "access")
    client_anon.cookies.set(
        "homecam_access", access_token, domain="testserver", path="/api"
    )
    with sqlite3.connect(settings.users_db_path) as conn:
        conn.execute("DELETE FROM users WHERE username = ?", ("ghost",))
        conn.commit()
    _assert_ws_closes_with_1008(client_anon, headers=_SAME_ORIGIN_HEADERS)


def test_multiple_subscribers_each_receive_an_event(client: TestClient):
    """An event published to the bus should fan out to every connected
    subscriber. Pin this so a future refactor of EventBus.publish
    doesn't accidentally short-circuit the loop after the first
    successful put_nowait."""
    with client.websocket_connect(
        "/api/events/ws", headers=_SAME_ORIGIN_HEADERS
    ) as ws_a, client.websocket_connect(
        "/api/events/ws", headers=_SAME_ORIGIN_HEADERS
    ) as ws_b:
        client.post(
            "/api/_internal/event",
            json={
                "label": "person",
                "score": 0.77,
                "boxes": [{"x": 0, "y": 0, "w": 0.5, "h": 0.5,
                           "label": "person", "score": 0.77}],
                "camera_id": "cam1",
            },
        )
        evt_a = ws_a.receive_json()
        evt_b = ws_b.receive_json()
        # Same event ID delivered to both — the bus published once,
        # fanned out independently.
        assert evt_a["id"] == evt_b["id"]
        assert evt_a["label"] == "person"


# iter-217 (Feature #6 slice 2): EventBus.publish() write-through to
# the SQLite events store. Both paths fire on publish; deque (in-memory
# WS fanout memo) + events_db (persistent history). A failure on
# either side must NOT break the other.

import asyncio  # noqa: E402
from sqlite3 import OperationalError as _sqlite3_OperationalError  # noqa: E402


def test_publish_writes_to_both_deque_and_events_db():
    """iter-217 acceptance: a single publish lands in both stores."""
    from app.config import settings
    from app.services import events_db
    from app.services.event_bus import event_bus, make_detection_event

    e = make_detection_event(
        label="person", score=0.91, boxes=[], camera_id="cam1"
    )
    asyncio.run(event_bus.publish(e))

    # Deque-side check: existing recent() reads from the in-memory deque.
    items = event_bus.recent(limit=10)
    assert any(item["id"] == e["id"] for item in items)

    # SQLite-side check: events_db.recent() returns the same row.
    db_items = events_db.recent(settings.events_db_path, limit=10)
    assert any(item["id"] == e["id"] for item in db_items)


def test_publish_persists_all_event_fields():
    """iter-217: round-trip through events_db preserves the full
    DetectionEventDict shape (id, ts, camera_id, label, score, boxes,
    person_name, thumb_url, clip_url, v, type)."""
    from app.config import settings
    from app.services import events_db
    from app.services.event_bus import event_bus, make_detection_event

    boxes = [{"x": 0.1, "y": 0.2, "w": 0.3, "h": 0.4, "label": "person", "score": 0.91}]
    e = make_detection_event(
        label="person",
        score=0.91,
        boxes=boxes,
        camera_id="cam1",
        thumb_url="/snapshots/thumb_1.jpg",
        person_name="alice",
        clip_url="/api/events/abc/clip",
    )
    asyncio.run(event_bus.publish(e))

    db_items = events_db.recent(settings.events_db_path, limit=10)
    matches = [item for item in db_items if item["id"] == e["id"]]
    assert len(matches) == 1
    got = matches[0]
    assert got["camera_id"] == "cam1"
    assert got["thumb_url"] == "/snapshots/thumb_1.jpg"
    assert got["person_name"] == "alice"
    assert got["clip_url"] == "/api/events/abc/clip"
    assert got["boxes"] == boxes
    assert got["v"] == 1
    assert got["type"] == "detection"


def test_publish_does_not_raise_when_events_db_insert_fails(monkeypatch):
    """iter-217 + iter-218 graceful degradation: a SQLite hiccup must
    NOT break the WS fanout. The publish path catches the exception,
    logs once, and proceeds. After iter-218 the deque is gone so
    the failed event is NOT recoverable from history — but the live
    WS subscriber still sees it.
    """
    import app.services.events_db as events_db_mod
    from app.services.event_bus import event_bus, make_detection_event

    def _raise(*_args, **_kwargs):
        raise _sqlite3_OperationalError("disk I/O error simulated")

    # Patch the function the lazy import inside publish() resolves to.
    monkeypatch.setattr(events_db_mod, "insert_event", _raise)

    e = make_detection_event(label="person", score=0.5, boxes=[])
    # Subscribe BEFORE publishing so we can verify the live fanout
    # path was unaffected by the persistence failure.
    q = event_bus.subscribe()
    try:
        # Must NOT raise.
        asyncio.run(event_bus.publish(e))
        # Live subscriber still received the event — fanout path
        # is what matters; persistence is best-effort.
        delivered = q.get_nowait()
        assert delivered["id"] == e["id"]
    finally:
        event_bus.unsubscribe(q)


def test_lifespan_initializes_events_db(client: TestClient):
    """The TestClient context manager runs the lifespan startup,
    which calls events_db.init_db on settings.events_db_path. That
    path is monkeypatched per-test by `_isolate_events_db`. The
    file should exist after lifespan startup."""
    from app.config import settings

    # `_isolate_events_db` already init_db's the file in its setup;
    # this test pins that the LIFESPAN path also reaches init_db
    # (so a fresh deploy on a Jetson with a missing file gets the
    # schema created at startup).
    assert settings.events_db_path.exists()


# iter-219 (Feature #6 slice 4): /api/events/search route. Cursor-
# paginated, filters AND-combined. Auth-gated (any role can read);
# all unknown query params validated by Pydantic Query bounds.

def test_search_returns_items_and_next_cursor(client: TestClient):
    """Happy path: post some events, search returns them + a
    next_cursor when the page is full."""
    for _ in range(3):
        _post_event(client, label="person")
    r = client.get("/api/events/search?limit=2")
    assert r.status_code == 200
    body = r.json()
    assert "items" in body
    assert "next_cursor" in body
    assert len(body["items"]) == 2
    # Page is full → next_cursor set.
    assert body["next_cursor"] is not None


def test_search_next_cursor_null_on_last_page(client: TestClient):
    """When the result count is below `limit`, next_cursor is null
    so the client knows pagination is done."""
    _post_event(client, label="person")
    r = client.get("/api/events/search?limit=10")
    body = r.json()
    assert len(body["items"]) == 1
    assert body["next_cursor"] is None


def test_search_filters_by_camera_id(client: TestClient):
    _post_event(client, camera_id="cam1", label="person")
    _post_event(client, camera_id="cam2", label="person")
    _post_event(client, camera_id="cam1", label="dog")
    r = client.get("/api/events/search?camera_id=cam1")
    items = r.json()["items"]
    assert len(items) == 2
    assert all(e["camera_id"] == "cam1" for e in items)


def test_search_filters_by_label(client: TestClient):
    _post_event(client, label="person")
    _post_event(client, label="car")
    _post_event(client, label="person")
    r = client.get("/api/events/search?label=car")
    items = r.json()["items"]
    assert len(items) == 1
    assert items[0]["label"] == "car"


def test_search_paginates_with_before_ts_cursor(client: TestClient):
    """End-to-end cursor pagination: page 1 → take next_cursor →
    fetch page 2 → no overlap, no missed events."""
    for _ in range(5):
        _post_event(client, label="person")
    page1 = client.get("/api/events/search?limit=2").json()
    assert len(page1["items"]) == 2
    cursor = page1["next_cursor"]
    assert cursor is not None
    page2 = client.get(f"/api/events/search?limit=2&before_ts={cursor}").json()
    assert len(page2["items"]) == 2
    page1_ids = {e["id"] for e in page1["items"]}
    page2_ids = {e["id"] for e in page2["items"]}
    assert page1_ids.isdisjoint(page2_ids)


def test_search_rejects_invalid_limit(client: TestClient):
    """Pydantic Query bounds: limit ≥ 1 and ≤ 1000."""
    assert client.get("/api/events/search?limit=0").status_code == 422
    assert client.get("/api/events/search?limit=10000").status_code == 422


def test_search_rejects_negative_timestamps(client: TestClient):
    """ts fields are unix-epoch; negative is meaningless and a
    sign of a malformed query. ge=0 in the Query bound."""
    assert client.get("/api/events/search?since_ts=-1").status_code == 422
    assert client.get("/api/events/search?until_ts=-1").status_code == 422
    assert client.get("/api/events/search?before_ts=-1").status_code == 422


def test_search_anon_returns_401(client_anon: TestClient):
    """Same auth gate as /api/events — events_db data isn't sensitive
    enough to NOT show, but it's not public either. Bare /api/events/
    search without a session cookie must 401."""
    r = client_anon.get("/api/events/search")
    assert r.status_code == 401


def test_search_returns_newest_first(client: TestClient):
    """Same ordering contract as /api/events — newest at index 0."""
    _post_event(client, label="dog")
    _post_event(client, label="person")
    _post_event(client, label="car")
    r = client.get("/api/events/search").json()
    labels = [e["label"] for e in r["items"]]
    # Newest 3 are the ones we posted in reverse order.
    assert labels[:3] == ["car", "person", "dog"]


# iter-222 (Feature #6 slice 7b-server): /api/events/count_by_day
# route. Same auth gate + filter set as /api/events/search.

def test_count_by_day_returns_counts_dict(client: TestClient):
    for _ in range(3):
        _post_event(client, label="person")
    r = client.get("/api/events/count_by_day")
    assert r.status_code == 200
    body = r.json()
    assert "counts" in body
    # All three events fired now → one local-day bucket with count 3.
    assert sum(body["counts"].values()) == 3


def test_count_by_day_filters_by_camera_id(client: TestClient):
    _post_event(client, camera_id="cam1", label="person")
    _post_event(client, camera_id="cam2", label="person")
    r = client.get("/api/events/count_by_day?camera_id=cam1")
    body = r.json()
    assert sum(body["counts"].values()) == 1


def test_count_by_day_filters_by_label(client: TestClient):
    _post_event(client, label="person")
    _post_event(client, label="car")
    _post_event(client, label="person")
    r = client.get("/api/events/count_by_day?label=car")
    body = r.json()
    assert sum(body["counts"].values()) == 1


def test_count_by_day_anon_returns_401(client_anon: TestClient):
    r = client_anon.get("/api/events/count_by_day")
    assert r.status_code == 401


def test_count_by_day_rejects_negative_timestamps(client: TestClient):
    """ge=0 Query bound — 422 on negative."""
    assert client.get("/api/events/count_by_day?since_ts=-1").status_code == 422
    assert client.get("/api/events/count_by_day?until_ts=-1").status_code == 422


def test_count_by_day_returns_empty_dict_when_no_events(client: TestClient):
    """Per-test events_db isolation means no events at start; the
    route must return `{counts: {}}`, not 404 or 500."""
    r = client.get("/api/events/count_by_day")
    assert r.status_code == 200
    assert r.json() == {"counts": {}}


# iter-227 (Feature #6 polish): face_unrecognized query param.
# Closes the iter-221 `__unknown__` chip server-side gap.

def test_search_face_unrecognized_true_returns_only_unrecognized(client: TestClient):
    _post_event(client, label="person", person_name="alice")
    _post_event(client, label="person")  # no person_name → null
    _post_event(client, label="person", person_name="bob")
    r = client.get("/api/events/search?face_unrecognized=true")
    items = r.json()["items"]
    assert len(items) == 1
    assert items[0]["person_name"] is None


def test_search_face_unrecognized_false_returns_only_recognized(client: TestClient):
    _post_event(client, label="person", person_name="alice")
    _post_event(client, label="person")
    _post_event(client, label="person", person_name="bob")
    r = client.get("/api/events/search?face_unrecognized=false")
    items = r.json()["items"]
    assert len(items) == 2
    assert all(e["person_name"] is not None for e in items)


def test_search_face_unrecognized_rejects_non_bool(client: TestClient):
    """Pydantic Query coerces 'true'/'false'/'1'/'0' to bool but
    rejects garbage with 422."""
    r = client.get("/api/events/search?face_unrecognized=maybe")
    assert r.status_code == 422


def test_count_by_day_face_unrecognized_filters(client: TestClient):
    _post_event(client, label="person", person_name="alice")
    _post_event(client, label="person")
    r = client.get("/api/events/count_by_day?face_unrecognized=true")
    body = r.json()
    assert sum(body["counts"].values()) == 1


def test_count_by_day_face_unrecognized_anon_returns_401(client_anon: TestClient):
    """The face_unrecognized param doesn't bypass the auth gate."""
    r = client_anon.get("/api/events/count_by_day?face_unrecognized=true")
    assert r.status_code == 401


# iter-240 (Feature #6 polish, iter-235 §5 perf lever): ETag/304 on
# /api/events/count_by_day. Saves JSON parse on the heatmap
# visibility-resume refetch when counts haven't changed.

def test_count_by_day_returns_etag_header(client: TestClient):
    """200 response must include an ETag header."""
    r = client.get("/api/events/count_by_day")
    assert r.status_code == 200
    etag = r.headers.get("etag")
    assert etag is not None
    # Quoted strong validator per RFC 7232.
    assert etag.startswith('"') and etag.endswith('"')


def test_count_by_day_matching_if_none_match_returns_304(client: TestClient):
    """Round-trip: GET → grab ETag → re-GET with If-None-Match → 304."""
    r1 = client.get("/api/events/count_by_day")
    etag = r1.headers["etag"]
    r2 = client.get("/api/events/count_by_day", headers={"If-None-Match": etag})
    assert r2.status_code == 304
    # 304 responses must not carry a body per RFC 7232 §4.1; FastAPI's
    # Response(status_code=304) returns empty content. Echo ETag for
    # client cache-update.
    assert r2.headers.get("etag") == etag
    assert r2.content == b""


def test_count_by_day_mismatching_if_none_match_returns_200(client: TestClient):
    """Stale cached ETag → server returns 200 + fresh ETag (don't
    short-circuit on bogus client-supplied ETags)."""
    r = client.get(
        "/api/events/count_by_day",
        headers={"If-None-Match": '"not-a-real-etag"'},
    )
    assert r.status_code == 200
    assert r.headers.get("etag") is not None
    assert r.headers["etag"] != '"not-a-real-etag"'


def test_count_by_day_etag_changes_when_event_inserted(client: TestClient):
    """A new event invalidates the previous ETag — proves the cache
    revalidation actually catches changes (not just static hash)."""
    r1 = client.get("/api/events/count_by_day")
    etag1 = r1.headers["etag"]
    _post_event(client, label="person")
    r2 = client.get("/api/events/count_by_day")
    etag2 = r2.headers["etag"]
    assert etag1 != etag2


def test_count_by_day_etag_consistent_for_unchanged_state(client: TestClient):
    """Same filters + same events → same ETag across calls (the
    cache invariant)."""
    _post_event(client, label="person")
    r1 = client.get("/api/events/count_by_day")
    r2 = client.get("/api/events/count_by_day")
    assert r1.headers["etag"] == r2.headers["etag"]


def test_count_by_day_etag_differs_per_filter(client: TestClient):
    """Different filter params → different response → different
    ETag. Browser cache keys URLs separately so this is correct
    behavior."""
    _post_event(client, label="person", camera_id="cam1")
    _post_event(client, label="person", camera_id="cam2")
    r_all = client.get("/api/events/count_by_day")
    r_cam1 = client.get("/api/events/count_by_day?camera_id=cam1")
    assert r_all.headers["etag"] != r_cam1.headers["etag"]


# iter-248 — unread count + mark-seen for the home-screen badge.

def test_when_no_events_then_unread_count_returns_zero(client: TestClient):
    # arrange — fresh fixture, no events.

    # act
    r = client.get("/api/events/unread_count")

    # assert
    assert r.status_code == 200
    assert r.json() == {"count": 0}


def test_when_three_events_inserted_then_unread_count_returns_three(client: TestClient):
    # arrange
    _post_event(client, label="person")
    _post_event(client, label="car")
    _post_event(client, label="dog")

    # act
    r = client.get("/api/events/unread_count")

    # assert
    assert r.json() == {"count": 3}


def test_when_event_marked_seen_then_unread_count_decreases(client: TestClient):
    # arrange
    _post_event(client, label="person", id="abc123")
    _post_event(client, label="car", id="def456")

    # act
    seen = client.post("/api/events/abc123/seen")
    count = client.get("/api/events/unread_count").json()

    # assert
    assert seen.status_code == 200
    assert seen.json() == {"flipped": True}
    assert count == {"count": 1}


def test_when_event_already_seen_then_mark_seen_returns_flipped_false(
    client: TestClient,
):
    # arrange
    _post_event(client, label="person", id="abc123")
    client.post("/api/events/abc123/seen")

    # act
    second = client.post("/api/events/abc123/seen")

    # assert
    assert second.json() == {"flipped": False}


def test_when_seen_all_called_then_unread_count_drops_to_zero(client: TestClient):
    # arrange
    _post_event(client, label="person")
    _post_event(client, label="car")
    _post_event(client, label="dog")

    # act
    bulk = client.post("/api/events/seen_all")
    count = client.get("/api/events/unread_count").json()

    # assert
    assert bulk.status_code == 200
    assert bulk.json() == {"flipped": 3}
    assert count == {"count": 0}


def test_when_event_id_contains_path_traversal_then_seen_route_422(
    client: TestClient,
):
    # arrange — same charset defense as the iter-201 clip route.
    bad_ids = ["..", "../etc/passwd", "abc/def", "abc def", "abc.def"]

    # act / assert
    for bad in bad_ids:
        r = client.post(f"/api/events/{bad}/seen")
        # FastAPI parses the path; rejection can surface as 404
        # (route not matched), 405 (path collapsed onto a different
        # route's verb), or 422 (regex check). The contract is "not
        # 200" — the route must never accept a malformed id.
        assert r.status_code != 200, (bad, r.status_code)
        assert r.status_code in (404, 405, 422), (bad, r.status_code)


def test_given_anon_client_when_unread_count_called_then_401(client_anon: TestClient):
    # arrange — no cookie.

    # act
    r = client_anon.get("/api/events/unread_count")

    # assert — auth-gated like all of /api/events
    assert r.status_code == 401


# iter-299 (manual event delete): owner-only DELETE single + bulk-
# by-day. Default `client` fixture seeds an `admin` role which
# passes `require_role("owner")` via the iter-197 carve-out.

def test_when_delete_event_called_with_existing_id_then_returns_deleted_true(client):
    # arrange — insert one event via the worker carve-out so we have
    # an id to address.
    from app.config import settings as _settings
    from app.services import events_db
    from app.services.event_bus import make_detection_event
    e = make_detection_event(label="person", score=0.9, boxes=[])
    events_db.insert_event(_settings.events_db_path, e)

    # act
    r = client.delete(f"/api/events/{e['id']}")

    # assert
    assert r.status_code == 200
    assert r.json() == {"deleted": True}


def test_when_delete_event_called_with_unknown_id_then_returns_deleted_false(client):
    # arrange — note: id pattern is [A-Za-z0-9_-]+ so we can use
    # a valid-shaped id that doesn't exist.

    # act
    r = client.delete("/api/events/no_such_id_42")

    # assert — soft 200 + flag (not 404) so the iter-184 auth-error
    # toast UX doesn't fire on a stale row.
    assert r.status_code == 200
    assert r.json() == {"deleted": False}


def test_when_delete_event_called_with_malformed_id_then_returns_422(client):
    # arrange — id pattern rejects path-traversal-y characters.

    # act
    r = client.delete("/api/events/contains spaces!")

    # assert
    assert r.status_code == 422


def test_when_delete_events_by_day_called_then_only_target_day_removed(client):
    # arrange — seed 3 events: 2 on Apr 30, 1 on May 1.
    import time as _time
    from app.config import settings as _settings
    from app.services import events_db
    from app.services.event_bus import make_detection_event
    apr_base = _time.mktime((2026, 4, 30, 12, 0, 0, 0, 0, -1))
    may_base = _time.mktime((2026, 5, 1, 12, 0, 0, 0, 0, -1))
    for ts in (apr_base, apr_base + 60, may_base):
        e = make_detection_event(label="person", score=0.9, boxes=[])
        e["ts"] = ts
        events_db.insert_event(_settings.events_db_path, e)

    # act
    r = client.delete("/api/events?day=2026-04-30")

    # assert
    assert r.status_code == 200
    assert r.json() == {"deleted": 2}


def test_when_delete_event_then_clip_file_is_unlinked(client, tmp_path, monkeypatch):
    """2026-07-09: the delete route must unlink the clip, not just the DB row.
    Before this fix every manual delete orphaned its `.mp4` on disk."""
    # arrange — event row + its clip file on disk under a tmp recordings dir.
    from app.config import settings as _settings
    from app.services import events_db, recording_service
    from app.services.event_bus import make_detection_event
    rec_dir = tmp_path / "recordings"
    rec_dir.mkdir()
    monkeypatch.setattr(_settings, "recordings_dir", rec_dir)
    e = make_detection_event(label="person", score=0.9, boxes=[])
    events_db.insert_event(_settings.events_db_path, e)
    clip = recording_service.clip_path(e["id"])
    clip.write_bytes(b"fake mp4 bytes")
    assert clip.is_file()

    # act
    r = client.delete(f"/api/events/{e['id']}")

    # assert — row deleted AND the clip is gone (no orphan).
    assert r.status_code == 200
    assert r.json() == {"deleted": True}
    assert not clip.exists()


def test_when_delete_events_by_day_then_target_clips_unlinked_others_kept(
    client, tmp_path, monkeypatch
):
    # arrange — 2 clips on the target day + 1 on another day, all on disk.
    import time as _time
    from app.config import settings as _settings
    from app.services import events_db, recording_service
    from app.services.event_bus import make_detection_event
    rec_dir = tmp_path / "recordings"
    rec_dir.mkdir()
    monkeypatch.setattr(_settings, "recordings_dir", rec_dir)
    apr_base = _time.mktime((2026, 4, 30, 12, 0, 0, 0, 0, -1))
    target_clips = []
    for ts in (apr_base, apr_base + 60):
        e = make_detection_event(label="person", score=0.9, boxes=[])
        e["ts"] = ts
        events_db.insert_event(_settings.events_db_path, e)
        clip = recording_service.clip_path(e["id"])
        clip.write_bytes(b"fake mp4")
        target_clips.append(clip)
    survivor = make_detection_event(label="person", score=0.9, boxes=[])
    survivor["ts"] = _time.mktime((2026, 5, 1, 12, 0, 0, 0, 0, -1))
    events_db.insert_event(_settings.events_db_path, survivor)
    survivor_clip = recording_service.clip_path(survivor["id"])
    survivor_clip.write_bytes(b"fake mp4")

    # act
    r = client.delete("/api/events?day=2026-04-30")

    # assert — both target-day clips unlinked; the other day's clip survives.
    assert r.status_code == 200
    assert r.json() == {"deleted": 2}
    assert all(not c.exists() for c in target_clips)
    assert survivor_clip.is_file()


def test_when_delete_events_by_day_called_with_malformed_date_then_returns_422(client):
    # arrange

    # act
    r = client.delete("/api/events?day=today")

    # assert — Pydantic Query pattern enforces YYYY-MM-DD shape.
    assert r.status_code == 422


def test_when_anonymous_user_calls_delete_event_then_401(client_anon):
    # arrange

    # act
    r = client_anon.delete("/api/events/abc123")

    # assert
    assert r.status_code == 401


def test_when_anonymous_user_calls_delete_events_by_day_then_401(client_anon):
    # arrange

    # act
    r = client_anon.delete("/api/events?day=2026-04-30")

    # assert
    assert r.status_code == 401


# iter-326 (missing-feature #5): GET /api/people aggregation route
# for the new /people page.

def test_when_no_recognized_events_then_people_route_returns_empty_items(client):
    # arrange — no seeded events; events_db is fresh per-test via
    # _isolate_events_db autouse fixture (iter-217).

    # act
    r = client.get("/api/people")

    # assert (iter-328 R2: response also carries `total` counter
    # so the client can render "Showing N of M" — empty case has
    # both items=[] and total=0).
    assert r.status_code == 200
    assert r.json() == {"items": [], "total": 0}


def test_when_events_with_persons_seeded_then_people_route_returns_aggregated(client):
    # arrange
    from app.config import settings as _settings
    from app.services import events_db
    from app.services.event_bus import make_detection_event
    base = 1700000000.0
    for ts, name in [
        (base, "alice"),
        (base + 60, "alice"),
        (base + 30, "bob"),
    ]:
        e = make_detection_event(label="person", score=0.9, boxes=[])
        e["ts"] = ts
        e["person_name"] = name
        events_db.insert_event(_settings.events_db_path, e)

    # act
    r = client.get("/api/people")

    # assert (iter-328 R2: total field added — equals distinct
    # person_name count, here 2 since alice + bob; same as
    # len(items) when no truncation by limit).
    body = r.json()
    assert r.status_code == 200
    items = body["items"]
    assert len(items) == 2
    assert body["total"] == 2
    # Most-recently-seen first (alice has base+60).
    assert items[0]["name"] == "alice"
    assert items[0]["count"] == 2
    assert items[1]["name"] == "bob"
    assert items[1]["count"] == 1


def test_when_anonymous_calls_people_route_then_401(client_anon):
    # arrange — client_anon fixture yields a TestClient WITHOUT
    # the auth-cookie seed the default `client` fixture provides
    # (iter-184 carve-out for tests pinning anonymous behavior).

    # act
    r = client_anon.get("/api/people")

    # assert
    assert r.status_code == 401


def test_when_people_route_returns_then_etag_header_is_present(client):
    # arrange (iter-327 R3: ETag/304 caching mirrors iter-240
    # count_by_day pattern). Fresh DB yields {"items": []};
    # ETag header must echo regardless of whether the body has
    # rows. md5 hash of canonical JSON, surrounded by quotes per
    # RFC 7232 §2.3.
    import re

    # act
    r = client.get("/api/people")

    # assert
    assert r.status_code == 200
    etag = r.headers.get("ETag")
    assert etag is not None
    # iter-327 follow-up (test-integrity-auditor: avoid the brittle
    # `len(etag) == 34` form — a future md5 → sha256 swap would
    # fail with a confusing "34 != 66" instead of a meaningful
    # algorithm-mismatch message). Pin the regex; intent is visible.
    assert re.fullmatch(r'"[0-9a-f]{32}"', etag), (
        f"Expected MD5 ETag (32 hex chars in quotes), got {etag!r}"
    )


def test_given_matching_if_none_match_when_people_route_called_then_returns_304(client):
    # arrange — first call captures the ETag.
    initial = client.get("/api/people")
    etag = initial.headers["ETag"]

    # act — second call with matching If-None-Match.
    second = client.get("/api/people", headers={"If-None-Match": etag})

    # assert — 304 with no body, ETag still echoed.
    assert second.status_code == 304
    assert second.headers["ETag"] == etag
    assert second.content == b""


def test_given_etag_when_underlying_data_changes_then_etag_rotates(client):
    # arrange — capture the empty-DB ETag.
    from app.config import settings as _settings
    from app.services import events_db
    from app.services.event_bus import make_detection_event
    initial = client.get("/api/people")
    empty_etag = initial.headers["ETag"]
    # Insert a recognized event — people_summary now returns one row.
    e = make_detection_event(label="person", score=0.9, boxes=[])
    e["ts"] = 1700000000.0
    e["person_name"] = "alice"
    events_db.insert_event(_settings.events_db_path, e)

    # act
    after = client.get("/api/people")

    # assert — body changed, so ETag MUST be different.
    assert after.status_code == 200
    assert after.headers["ETag"] != empty_etag


def test_given_stale_if_none_match_when_data_changed_then_returns_200_with_fresh_body(client):
    # arrange — record stale ETag from empty state.
    from app.config import settings as _settings
    from app.services import events_db
    from app.services.event_bus import make_detection_event
    stale_etag = client.get("/api/people").headers["ETag"]
    e = make_detection_event(label="person", score=0.9, boxes=[])
    e["ts"] = 1700000000.0
    e["person_name"] = "bob"
    events_db.insert_event(_settings.events_db_path, e)

    # act — pass the stale empty-state ETag against the post-insert state.
    r = client.get("/api/people", headers={"If-None-Match": stale_etag})

    # assert — full 200 with fresh body, not 304.
    assert r.status_code == 200
    body = r.json()
    assert len(body["items"]) == 1
    assert body["items"][0]["name"] == "bob"


def test_given_more_people_than_limit_when_route_called_then_items_capped_but_total_reflects_full_count(client):
    # arrange (iter-328 R2: pin the limit/total contract). Seed
    # 5 distinct people, then ask for limit=2 — the response MUST
    # carry exactly 2 items (most-recent first) AND total=5 so the
    # client knows it's seeing a truncated view.
    from app.config import settings as _settings
    from app.services import events_db
    from app.services.event_bus import make_detection_event
    base = 1700000000.0
    for i, name in enumerate(["alice", "bob", "carol", "dave", "eve"]):
        e = make_detection_event(label="person", score=0.9, boxes=[])
        e["ts"] = base + i * 60  # eve newest, alice oldest
        e["person_name"] = name
        events_db.insert_event(_settings.events_db_path, e)

    # act
    r = client.get("/api/people?limit=2")

    # assert
    assert r.status_code == 200
    body = r.json()
    assert len(body["items"]) == 2
    assert body["total"] == 5
    # Sorted last_seen DESC: eve (newest) then dave.
    assert [it["name"] for it in body["items"]] == ["eve", "dave"]


def test_when_limit_query_param_out_of_range_then_422(client):
    # arrange (iter-328 R2: route bounds 1..500 via Pydantic).

    # act
    too_low = client.get("/api/people?limit=0")
    too_high = client.get("/api/people?limit=501")
    not_int = client.get("/api/people?limit=abc")

    # assert
    assert too_low.status_code == 422
    assert too_high.status_code == 422
    assert not_int.status_code == 422


def test_given_limit_default_when_route_called_then_returns_at_most_100_items(client):
    # arrange (iter-328 R2: default limit is 100 — defensive cap
    # so an operator with 200 enrolled people doesn't ship the
    # full list on every nav-back to /people).
    from app.config import settings as _settings
    from app.services import events_db
    from app.services.event_bus import make_detection_event
    base = 1700000000.0
    for i in range(150):
        e = make_detection_event(label="person", score=0.9, boxes=[])
        e["ts"] = base + i
        e["person_name"] = f"person_{i:03d}"
        events_db.insert_event(_settings.events_db_path, e)

    # act — no limit param → default 100.
    r = client.get("/api/people")

    # assert
    body = r.json()
    assert len(body["items"]) == 100
    assert body["total"] == 150


# iter-logging (docs/logging_plan.md §2 "Detection / events" + §5 #7/#8):
# the WS auth gate must log every rejection branch at WARNING (it was
# silent today while the origin gate logged — an asymmetry that hid all
# WS auth rejections), and a DB read failure in /events/search must
# re-raise but log the operation + filter params. Both tests assert NO
# token / cookie bytes leak into the captured log.

import logging as _logging


def _mint_access_cookie(client_anon: TestClient, username: str) -> str:
    """arrange helper: seed a user + set a valid access cookie, returning
    the raw token (so a negative test can assert it never appears in the
    log)."""
    from app.auth import passwords, tokens, users_db
    from app.config import settings

    users_db.init_db(settings.users_db_path)
    try:
        users_db.create_user(
            settings.users_db_path,
            username,
            passwords.hash_password("p"),
            role="admin",
        )
    except Exception:
        pass
    token = tokens.issue(username, "access")
    client_anon.cookies.set(
        "homecam_access", token, domain="testserver", path="/api"
    )
    return token


def test_given_no_cookie_when_ws_handshake_then_auth_rejection_logged_at_warning(
    client_anon: TestClient, caplog
):
    """Given an authenticated origin but no access cookie, When the WS
    handshake runs, Then the no-cookie auth branch logs a WARNING."""
    # arrange — same-origin so the origin gate passes; no cookie set.
    with caplog.at_level(_logging.WARNING, logger="app.routes.events"):
        # act
        with client_anon.websocket_connect(
            "/api/events/ws", headers=_SAME_ORIGIN_HEADERS
        ) as ws:
            with pytest.raises(WebSocketDisconnect) as exc:
                ws.receive_text()

    # assert
    assert exc.value.code == 1008
    warnings = [r.getMessage() for r in caplog.records
                if r.levelno == _logging.WARNING]
    assert any("auth rejected" in m and "no cookie" in m for m in warnings)


def test_given_garbage_cookie_when_ws_handshake_then_invalid_token_branch_logged(
    client_anon: TestClient, caplog
):
    """Given a present-but-garbage access cookie, When the WS handshake
    decodes it, Then the invalid-token branch logs a WARNING and the
    cookie bytes never appear in the log."""
    # arrange — attach the cookie via the Cookie HEADER (the httpx jar's
    # .set(domain/path) does not reach the WS handshake in this TestClient).
    garbage = "not-a-real-jwt-deadbeef"
    headers = dict(_SAME_ORIGIN_HEADERS)
    headers["Cookie"] = "homecam_access=" + garbage

    with caplog.at_level(_logging.WARNING, logger="app.routes.events"):
        # act
        with client_anon.websocket_connect(
            "/api/events/ws", headers=headers
        ) as ws:
            with pytest.raises(WebSocketDisconnect) as exc:
                ws.receive_text()

    # assert
    assert exc.value.code == 1008
    msgs = [r.getMessage() for r in caplog.records]
    assert any("auth rejected" in m and "invalid" in m for m in msgs)
    # guardrail §4: NEVER log the cookie / token bytes.
    assert all(garbage not in m for m in msgs)


def test_given_empty_sub_token_when_ws_handshake_then_malformed_sub_branch_logged(
    client_anon: TestClient, caplog
):
    """Given a signature-valid access token whose `sub` claim is empty,
    When the WS handshake validates the claim, Then the malformed-sub
    branch logs a WARNING."""
    # arrange — mint a token with an empty sub: it decodes (valid sig +
    # kind) but fails the `isinstance(sub, str) and sub` check.
    from app.auth import tokens

    bad_sub_token = tokens.issue("", "access")
    headers = dict(_SAME_ORIGIN_HEADERS)
    headers["Cookie"] = "homecam_access=" + bad_sub_token

    with caplog.at_level(_logging.WARNING, logger="app.routes.events"):
        # act
        with client_anon.websocket_connect(
            "/api/events/ws", headers=headers
        ) as ws:
            with pytest.raises(WebSocketDisconnect) as exc:
                ws.receive_text()

    # assert
    assert exc.value.code == 1008
    msgs = [r.getMessage() for r in caplog.records]
    assert any("auth rejected" in m and "malformed sub" in m for m in msgs)
    assert all(bad_sub_token not in m for m in msgs)


def test_given_deleted_user_token_when_ws_handshake_then_user_row_gone_logged(
    client_anon: TestClient, caplog
):
    """Given a TTL-valid token whose user row was deleted, When the WS
    handshake looks the user up, Then the user-row-gone branch logs a
    WARNING and the token bytes never appear in the log."""
    # arrange
    import sqlite3
    from app.config import settings

    token = _mint_access_cookie(client_anon, "ghostlog")
    with sqlite3.connect(settings.users_db_path) as conn:
        conn.execute("DELETE FROM users WHERE username = ?", ("ghostlog",))
        conn.commit()
    headers = dict(_SAME_ORIGIN_HEADERS)
    headers["Cookie"] = "homecam_access=" + token

    with caplog.at_level(_logging.WARNING, logger="app.routes.events"):
        # act
        with client_anon.websocket_connect(
            "/api/events/ws", headers=headers
        ) as ws:
            with pytest.raises(WebSocketDisconnect) as exc:
                ws.receive_text()

    # assert
    assert exc.value.code == 1008
    msgs = [r.getMessage() for r in caplog.records]
    assert any("auth rejected" in m and "user row gone" in m for m in msgs)
    # the sub username is safe (already in the DB), but the token bytes
    # must never leak.
    assert all(token not in m for m in msgs)


def test_given_db_read_fails_when_search_called_then_reraises_and_logs_op_and_params(
    client, monkeypatch, caplog
):
    """Given the sqlite search helper raises, When /api/events/search is
    called, Then the route still 500s AND logs the operation + every
    filter param at exception level (with no token bytes)."""
    # arrange — patch events_db.search to raise a DB-style error.
    from app.services import events_db

    def _boom(*args, **kwargs):
        raise RuntimeError("database is locked")

    monkeypatch.setattr(events_db, "search", _boom)

    # A non-raising client so the 500 RESPONSE is observable (the default
    # TestClient re-raises server exceptions into the test instead). Carry
    # the authed cookies from the `client` fixture so the route's auth gate
    # passes and we reach the search handler.
    from starlette.testclient import TestClient as _TestClient
    from app.main import app as _app

    non_raising = _TestClient(_app, raise_server_exceptions=False)
    non_raising.cookies.update(client.cookies)

    with caplog.at_level(_logging.ERROR, logger="app.routes.events"):
        # act — a distinctive camera_id so we can assert it surfaced.
        r = non_raising.get(
            "/api/events/search?camera_id=cam_sentinel_42&label=person"
        )

    # assert — behaviour unchanged: the route still 500s.
    assert r.status_code == 500
    records = [
        r for r in caplog.records
        if r.levelno >= _logging.ERROR and "events_db.search failed" in r.getMessage()
    ]
    assert records, "search DB failure must log at ERROR/EXCEPTION"
    msg = records[0].getMessage()
    # operation + identifying filter params present.
    assert "cam_sentinel_42" in msg
    assert "person" in msg
    # the stack was captured (log.exception).
    assert records[0].exc_info is not None
    # guardrail §4: no cookie header value should appear in the log.
    assert "homecam_access" not in msg


# --- docs/multicam_contract.md (2026-07-07): camera dimension --------


def test_given_event_when_listed_then_row_includes_camera_id(
    client: TestClient,
):
    # arrange
    _post_event(client, camera_id="back_yard", label="person")

    # act
    items = client.get("/api/events?limit=1").json()

    # assert
    assert items[0]["camera_id"] == "back_yard"


def test_daily_digest_summarizes_labels_and_recognition(client: TestClient):
    import time

    day = time.strftime("%Y-%m-%d", time.localtime())
    _post_event(client, label="person", person_name="israel")
    _post_event(client, label="person")
    _post_event(client, label="cat")

    response = client.get("/api/events/digest?day={}".format(day))
    assert response.status_code == 200
    assert response.json() == {
        "day": day,
        "total": 3,
        "by_label": {"cat": 1, "person": 2},
        "unknown_people": 1,
        "known_people": ["israel"],
    }


def test_owner_can_protect_and_unprotect_event(client: TestClient):
    response = _post_event(client, camera_id="front_door", label="person")
    event_id = response.json()["event_id"]

    protected = client.put(
        "/api/events/{}/protection".format(event_id),
        json={"protected": True},
    )
    assert protected.status_code == 200
    assert protected.json() == {"protected": True}
    assert client.get("/api/events?limit=1").json()[0]["protected"] is True

    unprotected = client.put(
        "/api/events/{}/protection".format(event_id),
        json={"protected": False},
    )
    assert unprotected.status_code == 200
    assert unprotected.json() == {"protected": False}


def test_protection_rejects_unknown_event(client: TestClient):
    response = client.put(
        "/api/events/missing/protection", json={"protected": True}
    )
    assert response.status_code == 404


def test_given_camera_filter_when_searching_then_only_matching_rows(
    client: TestClient,
):
    # arrange
    _post_event(client, camera_id="front_door", label="person")
    _post_event(client, camera_id="back_yard", label="person")

    # act — the contract-blessed `camera=` spelling.
    r = client.get("/api/events/search?camera=back_yard")

    # assert
    assert r.status_code == 200, r.text
    items = r.json()["items"]
    assert len(items) == 1
    assert items[0]["camera_id"] == "back_yard"


def test_given_unknown_camera_filter_when_searching_then_zero_rows(
    client: TestClient,
):
    """Strict equality — an id the registry (or the DB) has never seen
    matches nothing; that is fine, not an error."""
    # arrange
    _post_event(client, camera_id="front_door", label="person")

    # act
    r = client.get("/api/events/search?camera=garage")

    # assert
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["items"] == []
    assert body["next_cursor"] is None


def test_given_both_camera_params_when_searching_then_camera_wins(
    client: TestClient,
):
    """`camera=` is the contract spelling; the legacy `camera_id=`
    stays for back-compat, and when both arrive the contract one is
    authoritative."""
    # arrange
    _post_event(client, camera_id="front_door", label="person")
    _post_event(client, camera_id="back_yard", label="person")

    # act
    r = client.get(
        "/api/events/search?camera=front_door&camera_id=back_yard"
    )

    # assert
    items = r.json()["items"]
    assert len(items) == 1
    assert items[0]["camera_id"] == "front_door"
