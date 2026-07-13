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
        "id": "harness_h47_event_001",
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


def test_given_real_fixture_thumb_url_when_internal_event_posts_then_stored_event_carries_exact_url(
    client: TestClient,
):
    thumb_url = f"/snapshots/{THUMB_FIXTURES[0].name}"

    response = client.post(
        "/api/_internal/event",
        json=_detection_event(thumb_url),
    )

    assert response.status_code == 200, response.text
    events = client.get("/api/events?limit=1").json()
    assert events[0]["id"] == "harness_h47_event_001"
    assert events[0]["thumb_url"] == thumb_url
