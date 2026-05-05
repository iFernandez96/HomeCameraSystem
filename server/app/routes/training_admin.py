"""iter-356.62 slice 3 (privacy controls): owner-only purge + consent
admin endpoints layered on top of the iter-351 face-capture tree.

Slice 2 (parallel worktree) owns `training.py` for the export ZIP
route; this module deliberately uses a different filename to avoid
collision. The export reader will eventually consume the
`<face_captures_dir>/<name>/consent.json` files written here to
filter out any unconsented names — but Slice 2 is in flight in a
sibling worktree, so we only establish the on-disk shape here.

All routes are gated by `require_role("owner")`. Path-traversal
defense mirrors `face.py::_resolve_under_root`: regex on the URL
param + `Path.resolve().relative_to(root.resolve())`.
"""
from __future__ import annotations

import json
import logging
import os
import time
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from ..auth.dependencies import get_current_user, require_role
from ..config import settings
from .face import _NAME_RE

router = APIRouter()
log = logging.getLogger(__name__)


# Consent text version cap. Free-form short identifier
# (e.g. "v1", "household-2026-05") so the operator can prove which
# wording the household member agreed to. 64 chars is generous.
_CONSENT_TEXT_VERSION_MAX = 64


def _resolve_capture_subdir(root: Path, name: str) -> Path | None:
    """Resolve `<root>/<name>` and verify it stays under `root`.
    Returns the resolved path on success, None on traversal-escape
    or unresolvable filesystem state. Mirrors the iter-353a E1
    pattern in face.py — resolve check BEFORE any mkdir."""
    try:
        target = (root / name).resolve()
        target.relative_to(root.resolve())
    except (ValueError, OSError):
        return None
    return target


def _purge_dir(target: Path) -> int:
    """Remove every `*.jpg` + matching `*.json` sidecar under
    `target`. Returns the count of JPEGs deleted. Best-effort —
    a single OSError doesn't abort the rest of the walk. The
    target directory itself is removed when empty after the sweep
    so a follow-up list_capture_dirs no longer surfaces an empty
    bucket for the purged name."""
    if not target.is_dir():
        return 0
    deleted = 0
    try:
        entries = list(target.iterdir())
    except OSError as e:
        log.warning("training_admin: cannot list %s: %s", target, e)
        return 0
    for entry in entries:
        try:
            if not entry.is_file():
                continue
        except OSError:
            continue
        if entry.suffix == ".jpg":
            sidecar = entry.with_suffix(".json")
            try:
                os.remove(str(entry))
                deleted += 1
            except OSError as e:
                log.warning("training_admin: failed to remove %s: %s", entry, e)
                continue
            try:
                if sidecar.is_file():
                    os.remove(str(sidecar))
            except OSError:
                pass
        elif entry.suffix == ".json" and entry.name != "consent.json":
            # Orphan sidecars (matching JPEG was already removed by
            # an earlier delete) — clean them up too. Preserve
            # consent.json: the operator might want consent records
            # to outlive a purge so a future export still respects
            # the household member's last-known stance.
            try:
                os.remove(str(entry))
            except OSError:
                pass
    # Best-effort rmdir: only succeeds if the dir is empty (consent
    # file may keep it alive, which is fine).
    try:
        target.rmdir()
    except OSError:
        pass
    return deleted


@router.delete(
    "/training/captures",
    dependencies=[Depends(require_role("owner"))],
)
async def delete_training_captures(name: str) -> dict:
    """Purge every JPEG + sidecar for `name` under both
    `face_captures_dir/<name>/` AND `person_captures_dir/<name>/`.
    Returns `{"ok": True, "deleted": <count>}`. 404 if NEITHER
    directory exists for that name (operator typo / already purged).

    The `consent.json` file is preserved — see `_purge_dir` for the
    rationale (export filter still respects it after purge).
    """
    if not _NAME_RE.match(name):
        raise HTTPException(status_code=404, detail="not found")

    face_target = _resolve_capture_subdir(settings.face_captures_dir, name)
    person_target = _resolve_capture_subdir(settings.person_captures_dir, name)
    if face_target is None and person_target is None:
        raise HTTPException(status_code=404, detail="not found")

    face_exists = face_target is not None and face_target.is_dir()
    person_exists = person_target is not None and person_target.is_dir()
    if not face_exists and not person_exists:
        raise HTTPException(status_code=404, detail="not found")

    deleted = 0
    if face_exists:
        deleted += _purge_dir(face_target)  # type: ignore[arg-type]
    if person_exists:
        deleted += _purge_dir(person_target)  # type: ignore[arg-type]
    return {"ok": True, "deleted": deleted}


class _ConsentBody(BaseModel):
    """Body for POST /api/face/captures/{name}/consent.

    `granted` is the operator's record of whether the named household
    member agreed to have their face used in training. `consent_text_version`
    pins which wording was shown — operator-provided free-form short
    identifier (e.g. "v1", "household-2026-05").
    """
    model_config = ConfigDict(extra="forbid")
    granted: bool
    consent_text_version: str = Field(
        ..., min_length=1, max_length=_CONSENT_TEXT_VERSION_MAX
    )


def _consent_path(name: str) -> Path | None:
    """Resolve `<face_captures_dir>/<name>/consent.json` with the
    same traversal-guard as `_resolve_capture_subdir`. Returns None
    if the path escapes the root."""
    sub = _resolve_capture_subdir(settings.face_captures_dir, name)
    if sub is None:
        return None
    return sub / "consent.json"


@router.post(
    "/face/captures/{name}/consent",
    dependencies=[Depends(require_role("owner"))],
)
async def post_consent(
    name: str,
    body: _ConsentBody,
    user: str = Depends(get_current_user),
) -> dict:
    """Write the per-name consent record under
    `<face_captures_dir>/<name>/consent.json` atomically (open-with-0o600,
    write, rename). The Slice 2 export reader will read this file to
    filter unconsented names out of training ZIPs.

    Returns the saved record. 404 on path-traversal attempt or
    invalid name.
    """
    if not _NAME_RE.match(name):
        raise HTTPException(status_code=404, detail="not found")
    target = _consent_path(name)
    if target is None:
        raise HTTPException(status_code=404, detail="not found")
    parent = target.parent
    try:
        parent.mkdir(parents=True, exist_ok=True)
    except OSError:
        raise HTTPException(status_code=500, detail="could not create dir")

    record = {
        "recorded_by": user,
        "recorded_at_ms": int(time.time() * 1000),
        "consent_text_version": body.consent_text_version,
        "granted": body.granted,
    }
    payload = json.dumps(record).encode("utf-8")

    # Atomic write: open tmp w/ 0o600, write, fsync, rename. Mirrors
    # the iter-184 jwt_secret + users.db creation pattern (mode set
    # at open time, not after — closes the TOCTOU window where a
    # racing reader could open the file while it's still 0o644).
    tmp = target.with_suffix(".json.tmp")
    try:
        fd = os.open(
            str(tmp),
            os.O_WRONLY | os.O_CREAT | os.O_TRUNC,
            0o600,
        )
        try:
            os.write(fd, payload)
            os.fsync(fd)
        finally:
            os.close(fd)
        os.replace(str(tmp), str(target))
        # `os.replace` preserves the dest's mode if it existed; on
        # first write the tmp's 0o600 carries through. Be explicit
        # to defend against an existing wider-mode consent.json from
        # a buggy earlier version.
        try:
            os.chmod(str(target), 0o600)
        except OSError:
            pass
    except OSError as e:
        log.warning("training_admin: consent write failed for %s: %s", name, e)
        raise HTTPException(status_code=500, detail="write failed")
    return record


@router.get(
    "/face/captures/{name}/consent",
    dependencies=[Depends(require_role("owner"))],
)
async def get_consent(name: str) -> dict:
    """Read the per-name consent record. Returns the stored record
    on hit; on miss returns the default-deny shape so the client
    doesn't have to branch on 404."""
    if not _NAME_RE.match(name):
        raise HTTPException(status_code=404, detail="not found")
    target = _consent_path(name)
    default = {
        "granted": False,
        "recorded_at_ms": None,
        "consent_text_version": None,
        "recorded_by": None,
    }
    if target is None or not target.is_file():
        return default
    try:
        with target.open("rb") as f:
            data = f.read(64 * 1024)  # bounded read; consent records are tiny
        parsed = json.loads(data)
    except (OSError, ValueError, json.JSONDecodeError):
        return default
    if not isinstance(parsed, dict):
        return default
    # Validate field shapes; fall back to default per field. This is
    # the same defensive pattern as `face.py::_read_sidecar`.
    out = dict(default)
    granted = parsed.get("granted")
    if isinstance(granted, bool):
        out["granted"] = granted
    rec_at = parsed.get("recorded_at_ms")
    if isinstance(rec_at, int) and not isinstance(rec_at, bool) and rec_at >= 0:
        out["recorded_at_ms"] = rec_at
    ctv = parsed.get("consent_text_version")
    if isinstance(ctv, str) and 1 <= len(ctv) <= _CONSENT_TEXT_VERSION_MAX:
        out["consent_text_version"] = ctv
    rb = parsed.get("recorded_by")
    if isinstance(rb, str) and 1 <= len(rb) <= 128:
        out["recorded_by"] = rb
    return out
