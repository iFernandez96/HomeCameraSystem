import pytest
from fastapi.testclient import TestClient


def _detection_event(thumb_url: str) -> dict:
    return {
        "id": "harness_h48_event_001",
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


@pytest.mark.parametrize(
    "thumb_url",
    [
        "https://evil/x.jpg",
        "/snapshots/../users.db",
        "/api/snapshots/thumb_1.jpg",
        "/snapshots/thumb_1.png",
        "/snapshots/thumb_abc.jpg",
    ],
)
def test_given_invalid_thumb_url_when_internal_event_posts_then_rejected_with_422(
    client: TestClient, thumb_url: str
):
    response = client.post(
        "/api/_internal/event",
        json=_detection_event(thumb_url),
    )

    assert response.status_code == 422, response.text
