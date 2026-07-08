import json

import httpx
import pytest
from fastapi import FastAPI

from app.auth.dependencies import get_current_user
from app.config import settings
from app.routes import cameras


@pytest.mark.anyio
async def test_given_two_camera_env_when_get_cameras_then_route_returns_both(
    monkeypatch,
):
    monkeypatch.setattr(
        settings,
        "cameras_json",
        json.dumps(
            [
                {
                    "id": "front_door",
                    "name": "Front Door",
                    "path": "cam",
                },
                {
                    "id": "driveway",
                    "name": "Driveway",
                    "path": "synth",
                },
            ]
        ),
    )
    app = FastAPI()

    async def auth_override() -> str:
        return "harness-user"

    app.dependency_overrides[get_current_user] = auth_override
    app.include_router(cameras.router, prefix="/api")

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(
        transport=transport,
        base_url="http://testserver",
    ) as client:
        response = await client.get("/api/cameras")

    assert response.status_code == 200
    assert response.json() == {
        "cameras": [
            {
                "id": "front_door",
                "name": "Front Door",
                "path": "cam",
            },
            {
                "id": "driveway",
                "name": "Driveway",
                "path": "synth",
            },
        ]
    }
