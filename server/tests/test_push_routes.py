from fastapi.testclient import TestClient


def test_vapid_public_key_returns_500_when_keys_missing(
    client: TestClient, monkeypatch
):
    from app.services.push_service import push_service

    monkeypatch.setattr(push_service, "public_key_b64", None)
    r = client.get("/api/push/vapid-public-key")
    assert r.status_code == 500


def test_vapid_public_key_returns_key_when_loaded(client: TestClient, monkeypatch):
    from app.services.push_service import push_service

    monkeypatch.setattr(push_service, "public_key_b64", "BFakePublicKey")
    r = client.get("/api/push/vapid-public-key")
    assert r.status_code == 200
    assert r.json() == {"key": "BFakePublicKey"}


def test_subscribe_accepts_valid_payload(client: TestClient):
    payload = {
        "endpoint": "https://push.example/test",
        "keys": {"p256dh": "abc", "auth": "def"},
    }
    r = client.post("/api/push/subscribe", json=payload)
    assert r.status_code == 200
    assert r.json() == {"ok": True}


def test_subscribe_rejects_missing_keys(client: TestClient):
    r = client.post("/api/push/subscribe", json={"endpoint": "x"})
    assert r.status_code == 422


def test_subscribe_rejects_partial_keys(client: TestClient):
    # Missing the required `auth` field inside keys.
    r = client.post(
        "/api/push/subscribe",
        json={"endpoint": "x", "keys": {"p256dh": "abc"}},
    )
    assert r.status_code == 422


def test_subscribe_dedupes_same_endpoint(client: TestClient):
    from app.services.push_service import push_service

    payload = {
        "endpoint": "https://push.example/dedupe",
        "keys": {"p256dh": "abc", "auth": "def"},
    }
    client.post("/api/push/subscribe", json=payload)
    client.post("/api/push/subscribe", json=payload)
    assert len(push_service.subs) == 1


def test_unsubscribe_removes_known_endpoint(client: TestClient):
    sub = {
        "endpoint": "https://push.example/remove",
        "keys": {"p256dh": "a", "auth": "b"},
    }
    client.post("/api/push/subscribe", json=sub)
    r = client.post(
        "/api/push/unsubscribe", json={"endpoint": "https://push.example/remove"}
    )
    assert r.status_code == 200
    assert r.json() == {"ok": True}


def test_unsubscribe_returns_false_for_unknown_endpoint(client: TestClient):
    r = client.post(
        "/api/push/unsubscribe", json={"endpoint": "https://nonexistent"}
    )
    assert r.status_code == 200
    assert r.json() == {"ok": False}


def test_given_sub_owned_by_other_when_unsubscribe_then_denied_and_warns(
    client: TestClient, caplog
):
    """Given a subscription owned by another user (audit A2 attack),
    When testuser tries to unsubscribe it, Then the sub is NOT removed,
    the response is the non-leaking {ok: False}, AND a security WARNING
    records the actor + owner (never the endpoint bytes)."""
    import logging

    from app.services.push_service import push_service

    # arrange — a sub owned by "victim", not the auto-logged-in testuser
    push_service.subs.clear()
    endpoint = "https://push.example/victim-sub"
    push_service.subs.append(
        {"endpoint": endpoint, "keys": {"p256dh": "a", "auth": "b"},
         "user_id": "victim"}
    )
    caplog.set_level(logging.WARNING, logger="app.routes.push")

    # act
    r = client.post("/api/push/unsubscribe", json={"endpoint": endpoint})

    # assert — not removed, non-leaking response, WARNING emitted
    assert r.status_code == 200
    assert r.json() == {"ok": False}
    assert any(s["endpoint"] == endpoint for s in push_service.subs)
    warnings = [
        rec for rec in caplog.records
        if rec.levelno == logging.WARNING
        and "unsubscribe denied" in rec.getMessage()
    ]
    assert warnings, "expected an 'unsubscribe denied' WARNING"
    msg = warnings[0].getMessage()
    assert "victim" in msg
    # Endpoint bytes (push secret material) must NOT be logged.
    assert endpoint not in msg
    push_service.subs.clear()


def test_subscribe_rejects_oversized_endpoint(client: TestClient):
    """The body-size middleware caps total request size at 1 MB but
    individual fields aren't otherwise capped. A subscription with a
    50 KB endpoint would persist forever in `push_subs.json`. Pin the
    field-level cap so future limit changes can't accidentally
    silently widen it."""
    payload = {
        "endpoint": "https://push.example/" + ("x" * 5000),
        "keys": {"p256dh": "abc", "auth": "def"},
    }
    r = client.post("/api/push/subscribe", json=payload)
    assert r.status_code == 422


def test_subscribe_rejects_oversized_p256dh(client: TestClient):
    payload = {
        "endpoint": "https://push.example/normal",
        "keys": {"p256dh": "x" * 500, "auth": "def"},
    }
    r = client.post("/api/push/subscribe", json=payload)
    assert r.status_code == 422


def test_subscribe_rejects_oversized_auth(client: TestClient):
    payload = {
        "endpoint": "https://push.example/normal",
        "keys": {"p256dh": "abc", "auth": "x" * 500},
    }
    r = client.post("/api/push/subscribe", json=payload)
    assert r.status_code == 422


def test_subscribe_rejects_blank_endpoint(client: TestClient):
    payload = {
        "endpoint": "",
        "keys": {"p256dh": "abc", "auth": "def"},
    }
    r = client.post("/api/push/subscribe", json=payload)
    assert r.status_code == 422


def test_subscribe_rejects_extra_fields(client: TestClient):
    """`extra='forbid'` mirrors the iter-22 hardening of the bbox
    payload — an attacker can't sneak unexpected fields into push
    subs which then get persisted to disk."""
    payload = {
        "endpoint": "https://push.example/extra",
        "keys": {"p256dh": "abc", "auth": "def"},
        "malicious": "<script>",
    }
    r = client.post("/api/push/subscribe", json=payload)
    assert r.status_code == 422


def test_unsubscribe_rejects_blank_endpoint(client: TestClient):
    """The previous `dict[str, str]` shape silently accepted empty
    strings (and would call `push_service.remove('')` which always
    returns False). The typed Unsubscribe model rejects them at the
    boundary."""
    r = client.post("/api/push/unsubscribe", json={"endpoint": ""})
    assert r.status_code == 422


def test_unsubscribe_rejects_extra_fields(client: TestClient):
    r = client.post(
        "/api/push/unsubscribe",
        json={"endpoint": "https://push.example/x", "malicious": "<script>"},
    )
    assert r.status_code == 422


def test_test_push_with_no_keys_returns_zero(client: TestClient, monkeypatch):
    from app.services.push_service import push_service

    monkeypatch.setattr(push_service, "private_pem", None)
    r = client.post("/api/push/test")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert body["sent"] == 0


def test_given_authed_caller_when_unsubscribing_anothers_endpoint_then_no_op(
    client: TestClient, tmp_path, monkeypatch
):
    """iter-356.x security audit A2 — pin the unsubscribe ownership check.

    Given a subscription owned by 'someone-else' was registered server-
    side, when the default authed test user (testuser) tries to remove
    it by endpoint, then the unsubscribe is rejected (returns ok:False)
    and the subscription remains in push_service.subs.
    """
    from app.services.push_service import push_service

    # arrange — seed a sub owned by another user, bypassing the route
    # so we can simulate the cross-user case directly.
    push_service.subs.append(
        {
            "endpoint": "https://push.example/owned-by-alice",
            "keys": {"p256dh": "a", "auth": "b"},
            "user_id": "alice",
        }
    )
    assert any(s["endpoint"] == "https://push.example/owned-by-alice" for s in push_service.subs)

    # act — testuser tries to remove alice's sub
    r = client.post(
        "/api/push/unsubscribe",
        json={"endpoint": "https://push.example/owned-by-alice"},
    )

    # assert — request succeeded but did NOT remove the foreign sub
    assert r.status_code == 200
    assert r.json() == {"ok": False}
    assert any(
        s["endpoint"] == "https://push.example/owned-by-alice"
        for s in push_service.subs
    ), "foreign sub must still be present"


def test_given_authed_caller_when_unsubscribing_own_endpoint_then_removed(
    client: TestClient,
):
    """iter-356.x — happy path: the owner of a sub can still remove it.
    The /subscribe handler stamps user_id=testuser server-side."""
    sub = {
        "endpoint": "https://push.example/mine",
        "keys": {"p256dh": "a", "auth": "b"},
    }
    client.post("/api/push/subscribe", json=sub)

    r = client.post(
        "/api/push/unsubscribe",
        json={"endpoint": "https://push.example/mine"},
    )
    assert r.status_code == 200
    assert r.json() == {"ok": True}


# --- iter-207 (Feature #4 slice 3a): per-user filter routes -----


def _sub_payload(**over):
    body = {
        "endpoint": "https://push.example/abc",
        "expirationTime": None,
        "keys": {"p256dh": "p256-key", "auth": "auth-secret"},
    }
    body.update(over)
    return body


def test_get_filters_returns_null_when_user_has_no_subs(client: TestClient):
    r = client.get("/api/push/filters")
    assert r.status_code == 200
    assert r.json() == {"filters": None}


def test_get_filters_returns_user_current_filters(client: TestClient):
    filters = {"cameras": ["cam1"], "person_names": ["israel"]}
    client.post("/api/push/subscribe", json=_sub_payload(filters=filters))
    r = client.get("/api/push/filters")
    assert r.status_code == 200
    # iter-209 (slice 4): PushFilters now includes `schedule_window`
    # (default None). Pydantic emits the full shape in the response.
    assert r.json() == {
        "filters": {
            "cameras": ["cam1"],
            "person_names": ["israel"],
            "schedule_window": None,
        }
    }


def test_get_filters_anon_returns_401(client_anon: TestClient):
    r = client_anon.get("/api/push/filters")
    assert r.status_code == 401


def test_put_filters_updates_user_subs(client: TestClient):
    from app.services.push_service import push_service

    client.post("/api/push/subscribe", json=_sub_payload())
    new_filters = {"cameras": ["cam1"], "person_names": ["israel"]}
    r = client.put("/api/push/filters", json={"filters": new_filters})
    assert r.status_code == 200
    # iter-209 (slice 4): response now includes `schedule_window`
    # (default None) per the extended PushFilters shape.
    expected = {**new_filters, "schedule_window": None}
    assert r.json() == {"filters": expected}
    assert push_service.subs[0]["filters"] == expected


def test_put_filters_with_null_resets_to_match_all(client: TestClient):
    from app.services.push_service import push_service

    client.post(
        "/api/push/subscribe",
        json=_sub_payload(filters={"cameras": ["cam1"]}),
    )
    r = client.put("/api/push/filters", json={"filters": None})
    assert r.status_code == 200
    assert r.json() == {"filters": None}
    assert push_service.subs[0]["filters"] is None


def test_put_filters_returns_404_when_user_has_no_subs(client: TestClient):
    """Caller must subscribe first — PUT can't bootstrap a sub."""
    r = client.put(
        "/api/push/filters",
        json={"filters": {"cameras": ["cam1"]}},
    )
    assert r.status_code == 404
    assert "subscribe" in r.json().get("detail", "").lower()


def test_put_filters_anon_returns_401(client_anon: TestClient):
    r = client_anon.put("/api/push/filters", json={"filters": None})
    assert r.status_code == 401


def test_put_filters_rejects_extra_fields(client: TestClient):
    """`FiltersBody` is extra='forbid'; unknown root keys 422."""
    client.post("/api/push/subscribe", json=_sub_payload())
    r = client.put(
        "/api/push/filters",
        json={"filters": None, "evil": "yes"},
    )
    assert r.status_code == 422


def test_put_filters_with_schedule_window_round_trips(client: TestClient):
    """iter-209 (slice 4): PUT /api/push/filters accepts the new
    schedule_window field and persists it on the user's subs."""
    from app.services.push_service import push_service

    client.post("/api/push/subscribe", json=_sub_payload())
    body = {
        "filters": {
            "cameras": None,
            "person_names": None,
            "schedule_window": {"start": "22:00", "end": "07:00"},
        }
    }
    r = client.put("/api/push/filters", json=body)
    assert r.status_code == 200
    assert r.json()["filters"]["schedule_window"] == {
        "start": "22:00",
        "end": "07:00",
    }
    assert push_service.subs[0]["filters"]["schedule_window"] == {
        "start": "22:00",
        "end": "07:00",
    }


def test_put_filters_rejects_invalid_hhmm_in_schedule_window(client: TestClient):
    """iter-209: schedule_window.start / end must match HH:MM (24h);
    Pydantic regex rejects malformed payloads with 422 BEFORE they
    reach the service layer."""
    client.post("/api/push/subscribe", json=_sub_payload())
    r = client.put(
        "/api/push/filters",
        json={
            "filters": {
                "cameras": None,
                "person_names": None,
                "schedule_window": {"start": "25:99", "end": "07:00"},
            }
        },
    )
    assert r.status_code == 422


def test_put_filters_rejects_extra_fields_in_schedule_window(client: TestClient):
    """iter-209: `_ScheduleWindow` is extra='forbid'; unknown nested
    keys 422 (e.g. an attacker trying to sneak `tz` or `weekday`)."""
    client.post("/api/push/subscribe", json=_sub_payload())
    r = client.put(
        "/api/push/filters",
        json={
            "filters": {
                "cameras": None,
                "person_names": None,
                "schedule_window": {
                    "start": "09:00",
                    "end": "17:00",
                    "tz": "America/Los_Angeles",
                },
            }
        },
    )
    assert r.status_code == 422


def test_put_filters_updates_only_caller_subs(client: TestClient):
    """A user's PUT only modifies subs they own. Sub-2 attributed to
    a different user via direct service mutation must stay
    unchanged."""
    from app.services.push_service import push_service

    client.post(
        "/api/push/subscribe",
        json=_sub_payload(endpoint="https://push.example/a"),
    )
    push_service.add({
        "endpoint": "https://push.example/other-user",
        "keys": {"p256dh": "p", "auth": "a"},
        "user_id": "alice",
        "filters": None,
    })

    r = client.put(
        "/api/push/filters",
        json={"filters": {"cameras": ["cam1"]}},
    )
    assert r.status_code == 200

    testuser_subs = [s for s in push_service.subs if s["user_id"] == "testuser"]
    assert len(testuser_subs) == 1
    assert testuser_subs[0]["filters"] == {
        "cameras": ["cam1"],
        "person_names": None,
        "schedule_window": None,
    }
    alice_subs = [s for s in push_service.subs if s["user_id"] == "alice"]
    assert len(alice_subs) == 1
    assert alice_subs[0]["filters"] is None


# iter-303 (notifications fuzzy-search): GET /api/push/known_filter_options
# returns distinct cameras + person_names from the events table, plus the
# user's currently-selected filter values so editing never silently loses
# entries.

def test_when_events_have_persons_when_known_filter_options_called_then_returns_distinct_alpha_sorted(
    client,
):
    # arrange
    from app.config import settings as _settings
    from app.services import events_db
    from app.services.event_bus import make_detection_event
    db_path = _settings.events_db_path
    events_db.insert_event(
        db_path,
        {**make_detection_event(label="person", score=0.9, boxes=[]),
         "person_name": "alice", "camera_id": "cam2"},
    )
    events_db.insert_event(
        db_path,
        {**make_detection_event(label="person", score=0.9, boxes=[]),
         "person_name": "Bob", "camera_id": "cam1"},
    )

    # act
    r = client.get("/api/push/known_filter_options")

    # assert
    assert r.status_code == 200
    body = r.json()
    assert body["person_names"] == ["alice", "Bob"]
    assert body["cameras"] == ["cam1", "cam2"]


def test_given_user_filter_with_unseen_name_when_known_filter_options_called_then_includes_filter_value(
    client,
):
    """Editing a filter that selects 'newname' (not yet observed in
    events) should still show 'newname' in the picker — otherwise the
    next save silently drops it."""
    # arrange
    from app.services.push_service import push_service
    from datetime import datetime
    push_service.subs.append({
        "endpoint": "https://example.com/x",
        "keys": {"p256dh": "k" * 88, "auth": "a" * 24},
        "filters": {
            "cameras": ["futurecam"],
            "person_names": ["newname"],
            "schedule_window": None,
        },
        "user_id": "testuser",
        "created_at": datetime.utcnow().isoformat() + "Z",
    })

    # act
    r = client.get("/api/push/known_filter_options")

    # assert
    assert r.status_code == 200
    body = r.json()
    assert "newname" in body["person_names"]
    assert "futurecam" in body["cameras"]


def test_when_anonymous_when_known_filter_options_called_then_401(client_anon):
    # arrange — anonymous client; route is gated by get_current_user.

    # act
    r = client_anon.get("/api/push/known_filter_options")

    # assert
    assert r.status_code == 401
