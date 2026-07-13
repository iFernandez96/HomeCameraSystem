import asyncio


def _canonical_detection_event() -> dict:
    return {
        "id": "harness_p4_event_001",
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
        "camera_id": "front_door",
    }


async def test_given_canonical_event_without_thumb_when_push_payload_built_then_send_matching_receives_contract_payload_without_image(
    client,
    monkeypatch,
):
    # given
    from app.services.push_service import PushService

    captured = []

    async def spy_send_matching(self, event, payload):
        captured.append((event, payload))
        return 0

    monkeypatch.setattr(PushService, "send_matching", spy_send_matching)

    # when
    response = client.post(
        "/api/_internal/event",
        json=_canonical_detection_event(),
    )
    for _ in range(20):
        if captured:
            break
        await asyncio.sleep(0.01)

    # then
    assert response.status_code == 200, response.text
    assert captured
    _event, payload = captured[0]
    assert set(payload) == {
        "title",
        "body",
        "tag",
        "url",
        "event_id",
        "unread_count",
        "importance",
        "reason",
        "require_interaction",
        "silent",
        "notification_kind",
        "actions",
    }
    assert payload["notification_kind"] == "detection"
    assert payload["actions"] == ["view", "mark_seen"]
    assert "image" not in payload
    assert payload["title"] == "Person detected"
    assert payload["body"] == "Front Door · 91%"
    assert payload["tag"] == "visit:harness_p4_event_001"
    assert payload["url"] == "/events"
    assert payload["event_id"] == "harness_p4_event_001"
    assert payload["unread_count"] == 1
    assert payload["importance"] == "notable"
    assert payload["reason"] == "unknown_person"
    assert payload["require_interaction"] is False
    assert payload["silent"] is False
