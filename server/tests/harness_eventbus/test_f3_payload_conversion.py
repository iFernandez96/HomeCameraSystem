import pytest

from app.routes._internal import DetectionPayload
from server.tests.harness_eventbus.fixtures import (
    EVENTS_DB,
    EVENTS_JSON,
    detection_payload_dict,
    load_json_rows,
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


def test_given_real_event_row_when_converted_then_real_detection_payload_validates():
    row = load_json_rows()[0]
    payload = detection_payload_dict(row)

    parsed = DetectionPayload(**payload)

    assert parsed.id == row["id"]
    assert parsed.label == row["label"]
    assert parsed.boxes
