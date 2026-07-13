import sqlite3

import httpx
import pytest
from fastapi import FastAPI

from server.tests.harness_eventbus.fixtures import (
    EVENTS_DB,
    EVENTS_JSON,
    detection_payload_dict,
    load_json_rows,
    normalize,
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


def _sorted_events(rows):
    return sorted((normalize(row) for row in rows), key=lambda row: (row["ts"], row["id"]))


def _read_scratch_rows(db_path):
    with sqlite3.connect(db_path) as conn:
        conn.row_factory = sqlite3.Row
        rows = conn.execute("SELECT * FROM events").fetchall()
    return _sorted_events(rows)


async def test_given_real_payloads_when_posted_to_internal_route_then_rows_match_bus_replay(
    tmp_path, monkeypatch, worker_auth_header,
):
    from app.config import settings
    from app.routes import _internal
    from app.services import events_db
    from app.services import event_bus as event_bus_module
    from app.services.detection import detection_service

    db_path = tmp_path / "events.db"
    monkeypatch.setattr(settings, "events_db_path", db_path)
    events_db.init_db(db_path)
    monkeypatch.setattr(detection_service, "active", True)

    app = FastAPI()
    app.include_router(_internal.router, prefix="/api")

    fixture_rows = load_json_rows()
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(
        transport=transport,
        base_url="http://testserver",
        headers={"Authorization": worker_auth_header},
    ) as client:
        for row in fixture_rows:
            monkeypatch.setattr(event_bus_module.time, "time", lambda ts=row["ts"]: ts)
            payload = detection_payload_dict(row)
            payload["continuation"] = True
            response = await client.post(
                "/api/_internal/event",
                json=payload,
            )
            assert response.status_code == 200, response.text
            assert response.json()["event_id"] == row["id"]

    assert _read_scratch_rows(db_path) == _sorted_events(fixture_rows)
