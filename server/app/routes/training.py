"""iter-356.6X (tiered-inference slice 2): training-data export route.

`GET /api/training/export?kind=face|person&size=224` returns a ZIP of
letterboxed PNGs + a `manifest.csv` describing the per-frame transform.
Read-only with respect to the on-disk capture tree — never mutates the
worker-written JPEGs.

Auth-gated `require_role("owner")` because the contents are biometric.
Path-traversal is bounded structurally: the route only sees the kind
string ("face" / "person"), then dereferences a settings-controlled
absolute root. No user-supplied path component reaches the filesystem.
"""
from __future__ import annotations

import io

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse

from ..auth.dependencies import require_role
from ..config import settings
from ..services import training_export

router = APIRouter()

# Defensive whitelist — caller can't ask for an arbitrary canvas size
# (would let a hostile owner OOM the server with size=8192).
_VALID_SIZES = (64, 96, 128, 224, 320, 416, 640)
_VALID_KINDS = ("face", "person")
_MAX_ENTRIES = 5000


@router.get(
    "/training/export",
    dependencies=[Depends(require_role("owner"))],
)
async def export_training_zip(
    kind: str = Query(..., description="face | person"),
    size: int = Query(224, description="square canvas size in pixels"),
) -> StreamingResponse:
    """Stream a ZIP of letterboxed PNGs (+ manifest.csv) for the given
    capture kind. Capped at 5,000 entries; over-cap returns 413."""
    # arrange — validate inputs before touching disk
    if kind not in _VALID_KINDS:
        raise HTTPException(status_code=422, detail="invalid kind")
    if size not in _VALID_SIZES:
        raise HTTPException(status_code=422, detail="invalid size")

    if kind == "face":
        root = settings.face_captures_dir
    else:
        root = settings.person_captures_dir

    # act — build the archive in memory
    zip_bytes, summary = training_export.build_export_zip(
        root=root,
        kind=kind,
        size=size,
        max_entries=_MAX_ENTRIES,
    )
    if summary.get("truncated"):
        raise HTTPException(
            status_code=413,
            detail="capture directory exceeds {0} entries".format(_MAX_ENTRIES),
        )

    # assert — stream the bytes back; Content-Length set automatically
    filename = "homecam-training-{0}-{1}.zip".format(kind, size)
    return StreamingResponse(
        io.BytesIO(zip_bytes),
        media_type="application/zip",
        headers={
            "Content-Disposition": 'attachment; filename="{0}"'.format(filename),
            "Content-Length": str(len(zip_bytes)),
        },
    )
