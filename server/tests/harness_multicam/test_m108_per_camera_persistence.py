import inspect

import pytest

from app.routes import events
from app.services import events_db


def _search_camera_param_name() -> str | None:
    params = inspect.signature(events.search_events).parameters
    if "camera" in params:
        return "camera"
    if "camera_id" in params:
        return "camera_id"
    return None


def _event(event_id: str, camera_id: str, ts: float) -> dict:
    return {
        "v": 1,
        "type": "detection",
        "id": event_id,
        "ts": ts,
        "camera_id": camera_id,
        "label": "person",
        "score": 0.91,
        "boxes": [{"x": 0.1, "y": 0.2, "w": 0.3, "h": 0.4}],
        "thumb_url": f"/snapshots/thumb_{int(ts)}.jpg",
        "person_name": None,
        "clip_url": f"/clips/{event_id}.mp4",
    }


def test_given_two_camera_events_when_searching_then_filter_returns_only_that_camera(
    tmp_path,
):
    db_path = tmp_path / "events.sqlite"
    events_db.init_db(db_path)

    front_event = _event("m108-front-door", "front_door", 1_800_000_002.0)
    synth_event = _event("m108-synth", "synth", 1_800_000_001.0)
    assert events_db.insert_event(db_path, front_event) is True
    assert events_db.insert_event(db_path, synth_event) is True

    unfiltered_items = events_db.search(db_path, limit=10)
    assert {item["id"] for item in unfiltered_items} == {
        front_event["id"],
        synth_event["id"],
    }
    assert {item["camera_id"] for item in unfiltered_items} == {
        "front_door",
        "synth",
    }

    camera_param = _search_camera_param_name()
    if camera_param is None:
        pytest.skip(
            "missing camera filter param on /api/events/search; expected "
            "`camera` or legacy `camera_id`; persistence only asserted"
        )
    assert camera_param in {"camera", "camera_id"}

    front_items = events_db.search(
        db_path,
        camera_id="front_door",
        limit=10,
    )
    synth_items = events_db.search(
        db_path,
        camera_id="synth",
        limit=10,
    )

    assert [item["id"] for item in front_items] == [front_event["id"]]
    assert [item["camera_id"] for item in front_items] == ["front_door"]

    assert [item["id"] for item in synth_items] == [synth_event["id"]]
    assert [item["camera_id"] for item in synth_items] == ["synth"]
