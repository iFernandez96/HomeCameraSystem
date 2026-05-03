"""iter-351 (face-capture-for-retraining, Phase 2): read-only routes
for browsing the face crops the worker saved under
`settings.face_captures_dir`. The PWA's `/training` page (iter-352)
calls these to render a per-name gallery; iter-353 layers move/delete
POST routes on top; iter-354 adds a Re-train button.

Layout on disk (managed by detection/face_recog/capture.py):

    <face_captures_dir>/
        alice/
            1700000000000_evt-X.jpg
            1700000060000_evt-Y.jpg
        bob/
        __unknown__/

All routes here are gated by `require_role("owner")` because the
contents (faces of household members + visitors) are privileged.
Path traversal is defended in two tiers: regex on the URL params,
then `Path.resolve().relative_to(face_captures_dir.resolve())` —
same pattern as the iter-212/iter-317 backup + timelapse routes.
"""
from __future__ import annotations

import asyncio
import logging
import re
from pathlib import Path

import os

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, ConfigDict, Field

from ..auth.dependencies import require_role
from ..config import settings

router = APIRouter()
log = logging.getLogger(__name__)

# Mirror of `_SAFE_NAME_RE` in detection/face_recog/capture.py — the
# worker writes only sanitized names ([A-Za-z0-9_-] + the __unknown__
# sentinel), so the route accepts the same charset. Anything outside
# this set is a path-traversal attempt or operator typo; either way 404.
#
# iter-353a (security-auditor B1): require [A-Za-z0-9_] (NOT bare `-`)
# at the start AND end of the name. A name of bare `-` is filesystem-
# legal but breaks any shell glob that treats `-` as a flag prefix and
# is almost certainly a typo. Underscores are allowed at the edges so
# `__unknown__` (the recognizer sentinel) still matches.
_NAME_RE = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_-]*[A-Za-z0-9_]$|^[A-Za-z0-9_]$")

# Filenames are `<ts_ms>_<sanitized_event_id>.jpg`. ts_ms is unix
# epoch milliseconds (13 digits today, future-proofed up to 16);
# event_id charset matches the recording_service `_VALID_EVENT_ID`
# regex used elsewhere.
_FILENAME_RE = re.compile(r"^[0-9]{1,16}_[A-Za-z0-9_-]+\.jpg$")


def _resolve_under_root(*parts: str) -> Path:
    """Resolve `face_captures_dir / parts` and guarantee the result
    is under the root. Raises HTTPException(404) on any escape /
    missing dir / unreadable path. Centralized so callers don't have
    to repeat the resolve+relative_to dance."""
    root = settings.face_captures_dir
    target = root.joinpath(*parts)
    try:
        resolved = target.resolve()
        resolved.relative_to(root.resolve())
    except (ValueError, OSError):
        raise HTTPException(status_code=404, detail="not found")
    return resolved


def _list_jpegs(directory: Path) -> list[Path]:
    """Return .jpg children of `directory`, ignoring subdirs and
    non-matching filenames. Empty list when dir is missing/unreadable."""
    if not directory.is_dir():
        return []
    out: list[Path] = []
    try:
        for child in directory.iterdir():
            if not child.is_file():
                continue
            if not _FILENAME_RE.match(child.name):
                continue
            out.append(child)
    except OSError:
        return []
    return out


@router.get(
    "/face/captures",
    dependencies=[Depends(require_role("owner"))],
)
async def list_capture_dirs() -> dict[str, object]:
    """List the per-name capture directories with counts + most-recent
    capture timestamp. The PWA renders this as a gallery index; the
    operator clicks a name to drill into the per-file list.

    Empty list when face_captures_dir doesn't exist yet (operator hasn't
    deployed the iter-351 worker change OR no face has been seen since
    the dir was last cleared). Returns 200 with empty list, NOT 404 —
    "no captures yet" is a normal first-deploy state.

    iter-356.7 (code-scalability H, sync-on-loop): wrap the stat-heavy
    scan in `asyncio.to_thread`. At 200 captures × 5 people the SD-card
    stat() calls block the event loop for 50-200ms — long enough to
    flap WS heartbeats under concurrent UI load.
    """
    root = settings.face_captures_dir
    return await asyncio.to_thread(_capture_dirs_sync, root)


def _capture_dirs_sync(root: Path) -> dict[str, object]:
    if not root.is_dir():
        return {"dirs": []}
    out: list[dict[str, object]] = []
    try:
        children = sorted(root.iterdir(), key=lambda p: p.name.lower())
    except OSError:
        return {"dirs": []}
    for child in children:
        if not child.is_dir() or not _NAME_RE.match(child.name):
            continue
        files = _list_jpegs(child)
        if not files:
            continue
        # iter-353a (security-auditor F1): worker LRU eviction
        # (capture.py::_enforce_cap) runs concurrently with this GET.
        # If the worker deletes a file between _list_jpegs and the
        # stat call, an unguarded `f.stat()` raises FileNotFoundError →
        # FastAPI 500. Wrap each stat individually so a missing file
        # is just dropped from the count.
        mtimes: list[float] = []
        kept_count = 0
        for f in files:
            try:
                mtimes.append(f.stat().st_mtime)
                kept_count += 1
            except OSError:
                continue
        if kept_count == 0:
            continue
        out.append({
            "name": child.name,
            "count": kept_count,
            "latest_ts": max(mtimes),
        })
    return {"dirs": out}


@router.get(
    "/face/captures/{name}",
    dependencies=[Depends(require_role("owner"))],
)
async def list_captures_in_dir(name: str) -> dict[str, object]:
    """List the .jpg files under `<face_captures_dir>/<name>/`. The
    PWA renders this as a thumbnail grid; each entry includes the URL
    the browser uses to fetch the image (back through this router so
    the auth gate applies).

    iter-356.7 (code-scalability H): wrap the per-file sidecar read
    loop in asyncio.to_thread (each sidecar = open+read of a small
    JSON; at 200 files × 10ms = 2s of event-loop block).
    """
    if not _NAME_RE.match(name):
        raise HTTPException(status_code=404, detail="not found")
    target_dir = _resolve_under_root(name)
    return await asyncio.to_thread(_captures_in_dir_sync, name, target_dir)


def _captures_in_dir_sync(name: str, target_dir: Path) -> dict[str, object]:
    files = _list_jpegs(target_dir)
    out: list[dict[str, object]] = []
    for f in files:
        # `<ts_ms>_<event_id>.jpg` → split once on the first `_` so
        # event_ids that themselves contain `_` (allowed by the worker
        # regex) round-trip correctly.
        stem = f.stem
        ts_str, _, event_id = stem.partition("_")
        try:
            ts_ms = int(ts_str)
        except ValueError:
            continue
        # iter-355a: read sidecar JSON when present. Carries
        # `predicted_name` + `confidence` per crop so the iter-355b
        # Tinder-card UI can sort by uncertainty + show "73% confident".
        # Missing sidecar (legacy capture pre-iter-355a worker, OR
        # operator-uploaded bootstrap photo): defaults — predicted_name
        # = bucket dirname, confidence = null.
        sidecar = _read_sidecar(target_dir, f.stem)
        out.append({
            "filename": f.name,
            "ts_ms": ts_ms,
            "event_id": event_id,
            "url": f"/api/face/captures/{name}/{f.name}",
            "predicted_name": sidecar.get("predicted_name", name),
            "confidence": sidecar.get("confidence"),
        })
    # Newest first — the operator wants to triage the most recent
    # capture, not scroll past two months of history.
    out.sort(key=lambda d: d["ts_ms"], reverse=True)
    return {"name": name, "files": out}


# iter-355c1 (active-learning Phase 5 — review queue): the uncertainty
# band the iter-355c2 Tinder-card UI surfaces. Confidence within this
# range = "the classifier almost matched but isn't sure" — the
# operator's labeling is highest-value here. Boundaries chosen so:
# - confidence < 0.3 → strong miss, almost certainly an unknown face
#   (already routed to __unknown__/, no review needed)
# - confidence > 0.75 → strong match, no operator action required
# - in between → review queue (Tinder swipe: "is this Alice? yes/no/skip")
_UNCERTAINTY_LO = 0.3
_UNCERTAINTY_HI = 0.75
# Default + max page size for the review queue. Cap protects the
# server from a malicious operator passing limit=1000000 — sidecar
# reads are ~10ms each on the Nano, so 100 reads = 1 sec which is
# our hard ceiling for a single request.
_REVIEW_DEFAULT_LIMIT = 25
_REVIEW_MAX_LIMIT = 100


@router.get(
    "/face/review_queue",
    dependencies=[Depends(require_role("owner"))],
)
async def list_review_queue(limit: int = _REVIEW_DEFAULT_LIMIT) -> dict:
    """iter-355c1: surface face captures the classifier was UNCERTAIN
    about — sorted by `|confidence - 0.5|` ascending so the most-
    uncertain crops come first. The PWA's iter-355c2 /training/review
    Tinder UI consumes this.

    Response:
        {
          "items": [
            {filename, ts_ms, event_id, predicted_name, confidence,
             url, current_dir},
            ...
          ],
          "total_uncertain": <int>,
          "limit": <echoed>
        }

    `current_dir` is the directory the capture currently lives in
    (e.g. "alice" or "__unknown__") — distinct from `predicted_name`
    if the operator has already moved it. The Tinder UI uses
    `current_dir` for the move/delete URL composition.

    Captures WITHOUT a sidecar (legacy pre-iter-355a OR bootstrap
    uploads) are excluded — the queue is meaningless without
    confidence values.

    iter-356.7 (security F1): the per-capture sidecar reads are sync
    blocking I/O (each ~10 ms on the Nano's eMMC). At 20 enrolled
    people × 200 captures = 4000 reads = ~40 s of wall clock. Pre-
    iter-356.7 the whole loop ran on the asyncio event loop, blocking
    every concurrent handler (heartbeat write, WS fanout, status
    poll) for that duration. The fix wraps the entire scan in a
    single `asyncio.to_thread` call so the loop yields back to the
    event loop while the threadpool churns through the FS walk.
    """
    if limit < 1:
        limit = 1
    if limit > _REVIEW_MAX_LIMIT:
        limit = _REVIEW_MAX_LIMIT

    root = settings.face_captures_dir
    return await asyncio.to_thread(_review_queue_sync, root, limit)


def _review_queue_sync(root: Path, limit: int) -> dict:
    """Sync helper for list_review_queue. Single threadpool hop instead
    of one per sidecar read. Returns the response shape as a dict."""
    if not root.is_dir():
        return {"items": [], "total_uncertain": 0, "limit": limit}

    candidates: list[dict] = []
    try:
        children = list(root.iterdir())
    except OSError:
        return {"items": [], "total_uncertain": 0, "limit": limit}
    for child in children:
        if not child.is_dir() or not _NAME_RE.match(child.name):
            continue
        files = _list_jpegs(child)
        for f in files:
            sidecar = _read_sidecar(child, f.stem)
            conf = sidecar.get("confidence")
            if conf is None:
                continue
            if not (_UNCERTAINTY_LO <= conf <= _UNCERTAINTY_HI):
                continue
            stem = f.stem
            ts_str, _, event_id = stem.partition("_")
            try:
                ts_ms = int(ts_str)
            except ValueError:
                continue
            candidates.append({
                "filename": f.name,
                "ts_ms": ts_ms,
                "event_id": event_id,
                "predicted_name": sidecar.get("predicted_name"),
                "confidence": conf,
                "current_dir": child.name,
                "url": f"/api/face/captures/{child.name}/{f.name}",
                "_uncertainty": abs(conf - 0.5),
            })

    candidates.sort(key=lambda c: c["_uncertainty"])
    total = len(candidates)
    items = [
        {k: v for k, v in c.items() if not k.startswith("_")}
        for c in candidates[:limit]
    ]
    return {"items": items, "total_uncertain": total, "limit": limit}


def _read_sidecar(directory: Path, basename: str) -> dict:
    """Read the iter-355a sidecar JSON for `<directory>/<basename>.jpg`.
    Returns `{}` when the sidecar is missing, unreadable, or malformed
    — caller falls back to per-row defaults. Bounded read size so a
    pathological 1 GB JSON doesn't OOM the request handler.

    iter-356.5 (security G1): per-field type+range validation. The
    detection worker writes these sidecars; if the worker is ever
    compromised, an attacker controls the bytes here. Pre-iter-356.5
    a sidecar with `"confidence": "0.5"` (a JSON string) flowed through
    `list_review_queue` and triggered `TypeError: '<=' not supported
    between instances of 'float' and 'str'` → unhandled exception →
    HTTP 500 on the route forever. Mirrors the iter-? `_coerce_metric`
    pattern in `_internal.py` — drop bad fields, keep good ones."""
    import json as _json
    import math as _math
    sidecar_path = directory / (basename + ".json")
    try:
        with sidecar_path.open("rb") as f:
            data = f.read(64 * 1024)  # 64 KB cap — sidecars are ~100 bytes
        parsed = _json.loads(data)
    except (OSError, ValueError, _json.JSONDecodeError):
        return {}
    if not isinstance(parsed, dict):
        return {}
    out: dict = {}
    # confidence: numeric, finite, [0,1]; reject bool/str/NaN/Inf
    conf = parsed.get("confidence")
    if (
        isinstance(conf, (int, float))
        and not isinstance(conf, bool)
        and _math.isfinite(conf)
        and 0.0 <= conf <= 1.0
    ):
        out["confidence"] = float(conf)
    # predicted_name: str, ≤64 chars (matches the iter-118 names cap
    # in heartbeat metrics); a 50 KB string in a single sidecar would
    # inflate the response to multi-MB once × 100 review queue items.
    name = parsed.get("predicted_name")
    if isinstance(name, str) and len(name) <= 64:
        out["predicted_name"] = name
    elif name is None:
        out["predicted_name"] = None
    # event_id: str, ≤64 chars (uuid4 hex is 32; cap at 64 for slack).
    eid = parsed.get("event_id")
    if isinstance(eid, str) and len(eid) <= 64:
        out["event_id"] = eid
    return out


@router.get(
    "/face/captures/{name}/{filename}",
    dependencies=[Depends(require_role("owner"))],
)
async def get_capture_file(name: str, filename: str) -> FileResponse:
    """Serve one face crop JPEG. Same path-traversal defense as
    `/api/snapshots/{filename}` (regex + resolve+relative_to). Returns
    FileResponse so range requests work even though crops are tiny —
    keeps the contract uniform with the snapshots route.
    """
    if not _NAME_RE.match(name):
        raise HTTPException(status_code=404, detail="not found")
    if not _FILENAME_RE.match(filename):
        raise HTTPException(status_code=404, detail="not found")
    target = _resolve_under_root(name, filename)
    if not target.is_file():
        raise HTTPException(status_code=404, detail="not found")
    return FileResponse(path=str(target), media_type="image/jpeg")


# iter-353 (Phase 3): mutating routes for the operator triage loop —
# move a capture to a different person's dir (correct a misclassification)
# or delete it entirely (drop a noise crop). require_role("owner") on
# both. Same 2-tier path-traversal defense as the GET routes.
class _MoveBody(BaseModel):
    """Body for POST /api/face/captures/{name}/{filename}/move.
    `target_name` is the destination dir under face_captures_dir;
    must match the same `_NAME_RE` charset as URL `name` so a
    malicious operator can't smuggle a traversal through the body.
    `extra='forbid'` rejects unknown fields outright.
    """
    model_config = ConfigDict(extra="forbid")
    # iter-353a (security-auditor B2): `pattern=` makes the charset
    # constraint self-documenting and survives a future refactor that
    # drops the manual `_NAME_RE.match()` re-check below. The regex is
    # the loose [A-Za-z0-9_-] charset; the route handler's
    # `_NAME_RE.match()` is the stricter no-bare-hyphen version.
    target_name: str = Field(
        ..., min_length=1, max_length=64, pattern=r"^[A-Za-z0-9_-]+$",
    )


@router.post(
    "/face/captures/{name}/{filename}/move",
    dependencies=[Depends(require_role("owner"))],
)
async def move_capture(name: str, filename: str, body: _MoveBody) -> dict:
    """Move <face_captures_dir>/<name>/<filename> →
    <face_captures_dir>/<target_name>/<filename>. Used by the iter-352
    /training PWA when the operator drags a misclassified crop into
    the right person's folder (or into __unknown__/ for "drop this
    label" workflow).

    On collision the destination filename is suffixed with `_NN` so
    iter-353 doesn't silently overwrite an existing crop. Filename
    suffix preserves the original ts_ms ordering so the gallery's
    "newest first" sort still works.

    Returns `{"ok": True, "moved_to": "<target_name>/<final_filename>"}`.
    """
    if not _NAME_RE.match(name):
        raise HTTPException(status_code=404, detail="not found")
    if not _FILENAME_RE.match(filename):
        raise HTTPException(status_code=404, detail="not found")
    if not _NAME_RE.match(body.target_name):
        # 422 here vs 404 — the body shape is wrong (charset),
        # distinct from "URL didn't match a route."
        raise HTTPException(status_code=422, detail="invalid target_name")

    src = _resolve_under_root(name, filename)
    if not src.is_file():
        raise HTTPException(status_code=404, detail="not found")

    # Same-name move is a no-op success — caller might be retrying
    # after a network blip, no need to 400.
    if name == body.target_name:
        return {"ok": True, "moved_to": "{}/{}".format(name, filename)}

    # iter-353a (security-auditor E1): resolve + relative_to BEFORE
    # mkdir. Pre-iter-353a the order was mkdir → resolve check, so a
    # weakened _NAME_RE could create attacker-controlled directories
    # before the guard fired. Today _NAME_RE blocks all traversal
    # chars, but pinning the resolve-first order removes the
    # permanent dependency on the regex being the sole barrier.
    target_dir = settings.face_captures_dir / body.target_name
    try:
        resolved_target_dir = target_dir.resolve()
        resolved_target_dir.relative_to(settings.face_captures_dir.resolve())
    except (ValueError, OSError):
        raise HTTPException(status_code=404, detail="not found")
    try:
        target_dir.mkdir(parents=True, exist_ok=True)
    except OSError:
        raise HTTPException(status_code=500, detail="could not create target dir")

    final_name = _suffix_on_collision(target_dir, filename)
    dst = target_dir / final_name
    try:
        # os.rename is atomic on the same filesystem (face_captures_dir
        # always is); cross-filesystem moves would EXDEV but that's
        # not a real case here. If it ever became one, swap to shutil.move.
        os.rename(str(src), str(dst))
    except OSError:
        raise HTTPException(status_code=500, detail="move failed")
    # iter-355a: also move the sidecar JSON if present. The new dst
    # filename uses the SAME basename as the JPEG (with .json), so
    # the iter-355a list route's `_read_sidecar` finds it on the
    # other side. Sidecar absent = no-op (not an error, legacy
    # captures don't have one).
    src_sidecar = src.with_suffix(".json")
    dst_sidecar = dst.with_suffix(".json")
    if src_sidecar.is_file():
        try:
            os.rename(str(src_sidecar), str(dst_sidecar))
        except OSError:
            # Sidecar move is best-effort — the JPEG already moved.
            # Worst case the operator sees the crop with default
            # predicted_name (the destination dir name).
            pass
    return {"ok": True, "moved_to": "{}/{}".format(body.target_name, final_name)}


@router.delete(
    "/face/captures/{name}/{filename}",
    dependencies=[Depends(require_role("owner"))],
)
async def delete_capture(name: str, filename: str) -> dict:
    """Delete <face_captures_dir>/<name>/<filename>. Used when a crop
    is too blurry / partial / mislabeled-and-not-worth-saving. Sister
    to move; same path-traversal defense.

    Returns `{"ok": True}` on success. 404 if the file doesn't exist
    so a double-delete (operator double-tapped the menu button) gets
    a clear "already gone" instead of the success path lying.
    """
    if not _NAME_RE.match(name):
        raise HTTPException(status_code=404, detail="not found")
    if not _FILENAME_RE.match(filename):
        raise HTTPException(status_code=404, detail="not found")
    target = _resolve_under_root(name, filename)
    if not target.is_file():
        raise HTTPException(status_code=404, detail="not found")
    try:
        os.remove(str(target))
    except OSError:
        raise HTTPException(status_code=500, detail="delete failed")
    # iter-355a: also drop the sidecar JSON if present. Best-effort:
    # an orphaned sidecar without its JPEG is harmless (the list
    # route reads sidecars BY jpeg basename, so an orphan never
    # surfaces).
    sidecar = target.with_suffix(".json")
    try:
        os.remove(str(sidecar))
    except OSError:
        pass
    return {"ok": True}


# iter-354 (Phase 4 scaffold): bootstrap + re-train stub routes. Same
# stub-with-note pattern as iter-197 reboot / iter-210 backup / iter-
# 212 restore — route accepts the body shape, validates input, returns
# `{ok: True, note: "..."}` until the host-side helper lands at
# iter-355. Client (Training.tsx) branches on `r.note` to surface the
# honest "scaffold — operator action required" message instead of
# pretending the encode ran.
#
# Bootstrap UX: operator uploads a single JPEG of a household member
# whose face the camera should learn. Server-side this lands in
# face_captures/<name>/_bootstrap_<ts>.jpg so the worker's existing
# face-capture LRU + the iter-355 retrain helper can pick it up via
# the same path face_captures lives at. NOT in detection/face_recog/
# known_faces/ because that dir is host-side only (not bind-mounted
# into the container; doing so would couple deploys and add the dlib
# import surface to the server image).
#
# Re-train UX: button on the Training index. POST returns immediately
# with `{ok: True, note: "scaffold"}`; iter-355 wires the actual
# `encode_known_faces.py` subprocess + worker restart via NOPASSWD
# sudoers entry (operator setup).

# 5 MB cap on the bootstrap JPEG. Even a 12 MP DSLR photo is ~3-4 MB.
# The detection worker's frame buffer is at most 1280x720 ≈ 200 KB,
# so 5 MB is generous. Lower than the iter-75 1 MB body cap because
# this route is multipart (Content-Length + boundary overhead) — set
# explicitly here so the operator gets a friendly 413 instead of the
# generic body-cap rejection.
_BOOTSTRAP_MAX_BYTES = 5 * 1024 * 1024
_BOOTSTRAP_ALLOWED_TYPES = {"image/jpeg", "image/jpg", "image/png"}


@router.post(
    "/face/bootstrap",
    dependencies=[Depends(require_role("owner"))],
)
async def bootstrap_face(
    name: str = Form(..., min_length=1, max_length=64),
    image: UploadFile = File(...),
) -> dict:
    """Operator uploads a single photo of a household member to seed
    face training. The image lands in
    `<face_captures_dir>/<sanitized_name>/_bootstrap_<ts>.jpg`. The
    file is NOT yet wired into encode_known_faces.py — iter-355 ships
    the host-helper subprocess. Until then the response carries
    `note: "scaffold..."` so the client can be honest.

    Validation:
    - `name` matches the same charset as other face routes.
    - `image` content-type is one of jpeg/png.
    - `image` size capped at 5 MB.
    """
    if not _NAME_RE.match(name):
        raise HTTPException(status_code=422, detail="invalid name")
    if image.content_type not in _BOOTSTRAP_ALLOWED_TYPES:
        raise HTTPException(
            status_code=415,
            detail="unsupported media type; expected image/jpeg or image/png",
        )
    contents = await image.read()
    if len(contents) > _BOOTSTRAP_MAX_BYTES:
        raise HTTPException(
            status_code=413,
            detail="image exceeds {} bytes".format(_BOOTSTRAP_MAX_BYTES),
        )
    if len(contents) == 0:
        raise HTTPException(status_code=400, detail="empty image")

    target_dir = settings.face_captures_dir / name
    try:
        # Resolve check BEFORE mkdir (iter-353a E1 pattern).
        target_dir.resolve().relative_to(settings.face_captures_dir.resolve())
    except (ValueError, OSError):
        raise HTTPException(status_code=404, detail="not found")
    try:
        target_dir.mkdir(parents=True, exist_ok=True)
    except OSError:
        raise HTTPException(status_code=500, detail="could not create dir")

    import time as _time
    ts_ms = int(_time.time() * 1000)
    # Filename uses the same `<ts_ms>_<event_id>.jpg` shape the worker's
    # capture path uses, so the iter-353 list/move/delete routes pick
    # it up as a normal capture. event_id sentinel `_bootstrap` makes
    # it greppable / distinguishable from organic captures.
    filename = "{}_bootstrap.jpg".format(ts_ms)
    target_path = target_dir / filename
    try:
        # Same 0o600 mode as the iter-353a F2 worker write path.
        fd = os.open(
            str(target_path),
            os.O_WRONLY | os.O_CREAT | os.O_TRUNC,
            0o600,
        )
        try:
            os.write(fd, contents)
        finally:
            os.close(fd)
    except OSError:
        raise HTTPException(status_code=500, detail="write failed")
    return {
        "ok": True,
        "saved_to": "{}/{}".format(name, filename),
        "note": (
            "scaffold: photo saved but face encodings are NOT updated. "
            "iter-355 will wire the encode_known_faces.py subprocess. "
            "For now, SSH to the Jetson and run "
            "`cd detection/face_recog && python encode_known_faces.py` "
            "after copying the file from face_captures/ to known_faces/<name>/."
        ),
    }


@router.post(
    "/face/retrain",
    dependencies=[Depends(require_role("owner"))],
)
async def retrain_face() -> dict:
    """Trigger encode_known_faces.py to rebuild encodings.pkl from the
    curated face_captures/<name>/ directories. iter-354 stub: returns
    `note: "scaffold..."`; iter-355 wires the actual subprocess +
    worker restart via host-helper.
    """
    return {
        "ok": True,
        "note": (
            "scaffold: re-train is stubbed. iter-355 will wire the "
            "encode_known_faces.py subprocess + worker restart via "
            "the host-helper NOPASSWD sudoers entry. For now, SSH to "
            "the Jetson and run `cd detection/face_recog && "
            "python encode_known_faces.py && "
            "sudo systemctl restart homecam-detect`."
        ),
    }


def _suffix_on_collision(target_dir: Path, filename: str) -> str:
    """If `<target_dir>/<filename>` doesn't exist, return `filename`
    as-is. Otherwise insert `_2`, `_3`, … before `.jpg` until a free
    name is found. Bounded to 100 attempts to avoid pathological
    loops in a degenerate dir."""
    base = filename[:-4]  # strip ".jpg"
    candidate = filename
    n = 2
    while (target_dir / candidate).exists() and n < 100:
        candidate = "{}_{}.jpg".format(base, n)
        n += 1
    return candidate
