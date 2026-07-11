from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Path, Response
from fastapi.responses import FileResponse
from pydantic import BaseModel, ConfigDict, Field

from ..auth.dependencies import require_role
from ..config import settings
from ..services import clip_shares, recording_service

router = APIRouter(tags=["clip-shares"])


class CreateShareBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    ttl_s: int = Field(default=3600, ge=60, le=604800)


@router.post("/events/{event_id}/share", dependencies=[Depends(require_role("owner"))])
def create_share(
    body: CreateShareBody,
    response: Response,
    event_id: str = Path(..., pattern=r"^[A-Za-z0-9_-]+$", max_length=128),
) -> dict:
    if not recording_service.clip_exists(event_id):
        raise HTTPException(status_code=404, detail="clip not available")
    grant = clip_shares.create(settings.clip_shares_path, event_id, body.ttl_s)
    # The body contains a bearer URL. Never let a shared browser/proxy retain
    # it after logout, and keep this explicit even if middleware is reordered.
    response.headers["Cache-Control"] = "private, no-store"
    return {
        "share_id": grant["share_id"],
        "url": "/api/shared/{}".format(grant["token"]),
        "expires_at": grant["expires_at"],
    }


@router.delete("/shares/{share_id}", dependencies=[Depends(require_role("owner"))])
def revoke_share(share_id: str = Path(..., pattern=r"^[a-f0-9]{16}$")) -> dict:
    return {"revoked": clip_shares.revoke(settings.clip_shares_path, share_id)}


@router.get("/shared/{token}")
def get_shared_clip(token: str = Path(..., min_length=32, max_length=128)) -> FileResponse:
    event_id = clip_shares.resolve(settings.clip_shares_path, token)
    if event_id is None or not recording_service.clip_exists(event_id):
        raise HTTPException(status_code=404, detail="share unavailable")
    return FileResponse(
        recording_service.clip_path(event_id),
        media_type="video/mp4",
        filename="homecam-shared-clip.mp4",
        headers={
            "Cache-Control": "private, no-store",
            "Referrer-Policy": "no-referrer",
        },
    )
