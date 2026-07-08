"""GET /api/cameras — the camera registry, for the client.

docs/multicam_contract.md: the client fetches this once at boot; with
one camera it renders exactly as today (no switcher, no camera labels
on rows), with more it shows the Watch-page switcher + per-row camera
names. Auth-gated per-route like the sibling /api/events routes (this
file's router is included WITHOUT router-wide dependencies, mirroring
events.py, so the gate is explicit here).
"""
from __future__ import annotations

from fastapi import APIRouter, Depends

from ..auth.dependencies import get_current_user
from ..services.camera_registry import camera_registry

router = APIRouter()


@router.get("/cameras")
async def list_cameras(_user: str = Depends(get_current_user)) -> dict:
    return {"cameras": [cam.as_dict() for cam in camera_registry.cameras()]}
