import asyncio
import re

import pytest
from fastapi.testclient import TestClient

from server.tests.harness_snapshots.fixtures import SNAPSHOT_DIR, list_snapshot_files


THUMB_FILENAME_RE = re.compile(r"^thumb_[0-9]+\.jpg$")
THUMB_FIXTURES = [
    snapshot_file
    for snapshot_file in list_snapshot_files()
    if THUMB_FILENAME_RE.fullmatch(snapshot_file.name)
]


pytestmark = [
    pytest.mark.skipif(
        not SNAPSHOT_DIR.exists(),
        reason="no Jetson snapshot fixtures - capture .jetson-snapshot/proof_fixtures/snapshots",
    ),
    pytest.mark.skipif(
        not THUMB_FIXTURES,
        reason="no Jetson thumb fixtures - capture .jetson-snapshot/proof_fixtures/snapshots/thumb_*.jpg",
    ),
]


def _detection_event(thumb_url: str) -> dict:
    return {
        "id": "harness_h49_event_001",
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
        "thumb_url": thumb_url,
    }


async def test_given_valid_event_with_fixture_thumb_url_when_send_matching_spied_then_payload_image_is_exact_url(
    client: TestClient, monkeypatch
):
    from app.services.push_service import PushService

    thumb_url = f"/snapshots/{THUMB_FIXTURES[0].name}"
    captured = []

    async def spy_send_matching(self, event, payload):
        captured.append((event, payload))
        return 0

    monkeypatch.setattr(PushService, "send_matching", spy_send_matching)

    response = client.post(
        "/api/_internal/event",
        json=_detection_event(thumb_url),
    )
    for _ in range(20):
        if captured:
            break
        await asyncio.sleep(0.01)

    assert response.status_code == 200, response.text
    assert captured
    _event, payload = captured[0]
    assert payload["image"] == thumb_url
