import sqlite3
from types import SimpleNamespace

import httpx
from fastapi import FastAPI


async def _inline_to_thread(func, /, *args, **kwargs):
    return func(*args, **kwargs)


def _person_event_payload(**overrides):
    payload = {
        "id": "harness-r11-named",
        "label": "person",
        "score": 0.93,
        "boxes": [
            {
                "x": 0.18,
                "y": 0.12,
                "w": 0.28,
                "h": 0.45,
                "label": "person",
                "score": 0.93,
            }
        ],
        "camera_id": "front_door",
        "continuation": True,
    }
    payload.update(overrides)
    return payload


async def test_given_person_names_only_when_ingested_then_legacy_name_derives_and_search_round_trips(
    monkeypatch, worker_auth_header,
):
    from app.config import settings
    from app.routes import _internal, events
    from app.services.detection import detection_service

    monkeypatch.setattr(detection_service, "active", True)
    monkeypatch.setattr(events, "asyncio", SimpleNamespace(to_thread=_inline_to_thread))

    app = FastAPI()
    app.include_router(_internal.router, prefix="/api")

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(
        transport=transport,
        base_url="http://testserver",
        headers={"Authorization": worker_auth_header},
    ) as client:
        post = await client.post(
            "/api/_internal/event",
            json=_person_event_payload(person_names=["israel", "sheenal"]),
        )
        assert post.status_code == 200, post.text
        event_id = post.json()["event_id"]

        with sqlite3.connect(settings.events_db_path) as conn:
            row = conn.execute(
                "SELECT person_name, person_names_json FROM events WHERE id = ?",
                (event_id,),
            ).fetchone()
        assert row is not None
        assert row[0] == "israel"
        assert row[1] == '["israel", "sheenal"]'

        search = await events.search_events(
            camera_id=None,
            camera=None,
            person_name="israel",
            label=None,
            since_ts=None,
            until_ts=None,
            before_ts=None,
            face_unrecognized=None,
            limit=10,
            _user="harness",
        )
        items = search["items"]
        matched = [item for item in items if item["id"] == event_id]

        assert matched
        assert matched[0]["person_name"] == "israel"
        assert matched[0]["person_names"] == ["israel", "sheenal"]
