import sqlite3
from types import SimpleNamespace

import httpx
from fastapi import FastAPI


async def _inline_to_thread(func, /, *args, **kwargs):
    return func(*args, **kwargs)


def _person_event_payload(**overrides):
    payload = {
        "id": "harness-r10-null-name",
        "label": "person",
        "score": 0.88,
        "boxes": [
            {
                "x": 0.1,
                "y": 0.2,
                "w": 0.3,
                "h": 0.4,
                "label": "person",
                "score": 0.88,
            }
        ],
        "camera_id": "front_door",
        "continuation": True,
    }
    payload.update(overrides)
    return payload


async def test_given_real_shaped_person_event_without_name_when_ingested_then_search_finds_unrecognized(
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
        post = await client.post("/api/_internal/event", json=_person_event_payload())
        assert post.status_code == 200, post.text
        event_id = post.json()["event_id"]

        with sqlite3.connect(settings.events_db_path) as conn:
            row = conn.execute(
                "SELECT person_name FROM events WHERE id = ?",
                (event_id,),
            ).fetchone()
        assert row is not None
        assert row[0] is None

        search = await events.search_events(
            camera_id=None,
            camera=None,
            person_name=None,
            label=None,
            since_ts=None,
            until_ts=None,
            before_ts=None,
            face_unrecognized=True,
            limit=10,
            _user="harness",
        )
        items = search["items"]
        matched = [item for item in items if item["id"] == event_id]

        assert matched
        assert matched[0]["person_name"] is None
