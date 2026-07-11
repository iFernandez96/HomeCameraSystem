"""MediaMTX continuous-archive discovery and bounded range export."""
from __future__ import annotations

import hashlib
import logging
import os
import re
import subprocess
import threading
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ..config import settings
from .camera_registry import camera_registry
from .security_export_capacity import (
    CAPACITY_LOCK,
    ExportCapacityError,
    cleanup_owned_temps,
    conservative_reservation,
    ensure_finished_output_fits,
    ensure_reservation_fits,
)
from .security_store import security_store

log = logging.getLogger(__name__)
_SEGMENT_RE = re.compile(r"^[0-9]{1,13}\.mp4$")
_DURATION_CACHE: dict[str, tuple[int, int, float]] = {}
_EXPORT_LOCK = threading.Lock()


class TimelineError(ValueError):
    pass


@dataclass(frozen=True)
class Segment:
    camera_id: str
    path: Path
    start_ts: float
    end_ts: float
    size: int

    def public(self) -> dict[str, Any]:
        return {
            "id": "{}:{}".format(self.camera_id, self.path.stem),
            "camera_id": self.camera_id,
            "start_ts": self.start_ts,
            "end_ts": self.end_ts,
            "url": "/api/security/timeline/segments/{}/{}".format(
                self.camera_id, self.path.name
            ),
            "size_bytes": self.size,
        }


def validate_window(
    since_ts: float, until_ts: float, *, max_range_s: float | None = None
) -> None:
    if not (since_ts > 0 and until_ts > since_ts):
        raise TimelineError("until_ts must be greater than since_ts")
    if max_range_s is None:
        max_range_s = settings.security_timeline_max_range_s
    if until_ts - since_ts > max_range_s:
        raise TimelineError("requested timeline range is too large")


def _camera_dir(camera_id: str) -> Path:
    camera = camera_registry.get(camera_id)
    if camera is None:
        raise TimelineError("unknown camera_id")
    root = settings.continuous_recordings_dir.resolve()
    target = (root / camera.path).resolve()
    try:
        target.relative_to(root)
    except ValueError as exc:  # defense in depth; registry path is strict
        raise TimelineError("invalid camera archive path") from exc
    return target


def resolve_segment(camera_id: str, filename: str) -> Path:
    if _SEGMENT_RE.fullmatch(filename) is None:
        raise TimelineError("segment not found")
    directory = _camera_dir(camera_id)
    candidate = (directory / filename).resolve()
    try:
        candidate.relative_to(directory)
    except ValueError as exc:
        raise TimelineError("segment not found") from exc
    if not candidate.is_file():
        raise TimelineError("segment not found")
    return candidate


def _probe_duration(path: Path) -> float | None:
    try:
        stat = path.stat()
    except OSError:
        return None
    key = str(path)
    cached = _DURATION_CACHE.get(key)
    marker = (stat.st_mtime_ns, stat.st_size)
    if cached is not None and cached[:2] == marker:
        return cached[2]
    try:
        result = subprocess.run(
            [
                "ffprobe", "-v", "error", "-show_entries", "format=duration",
                "-of", "default=noprint_wrappers=1:nokey=1", str(path),
            ],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
        duration = float(result.stdout.strip()) if result.returncode == 0 else 0.0
    except (OSError, ValueError, subprocess.TimeoutExpired):
        duration = 0.0
    if not (0.0 < duration <= 3600.0):
        log.warning("continuous archive segment is unreadable: %s", path)
        return None
    _DURATION_CACHE[key] = (marker[0], marker[1], duration)
    return duration


def _has_video_stream(path: Path) -> bool:
    try:
        result = subprocess.run(
            [
                "ffprobe", "-v", "error", "-select_streams", "v:0",
                "-show_entries", "stream=codec_type", "-of",
                "default=noprint_wrappers=1:nokey=1", str(path),
            ],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return False
    return result.returncode == 0 and result.stdout.strip() == "video"


def list_segments(camera_id: str, since_ts: float, until_ts: float) -> list[Segment]:
    validate_window(since_ts, until_ts)
    directory = _camera_dir(camera_id)
    if not directory.is_dir():
        return []
    found: list[Segment] = []
    try:
        children = list(directory.iterdir())
    except OSError as exc:
        log.warning("continuous archive unavailable at %s: %s", directory, exc)
        return []
    for path in children:
        if not path.is_file() or _SEGMENT_RE.fullmatch(path.name) is None:
            continue
        try:
            start = float(int(path.stem))
            resolved = resolve_segment(camera_id, path.name)
            duration = _probe_duration(resolved)
            size = resolved.stat().st_size
        except (OSError, TimelineError, ValueError):
            continue
        if duration is None:
            continue
        end = start + duration
        if end > since_ts and start < until_ts:
            found.append(Segment(camera_id, resolved, start, end, size))
    return sorted(found, key=lambda item: (item.start_ts, item.path.name))


def coverage(
    segments: list[Segment], since_ts: float, until_ts: float
) -> tuple[list[dict[str, Any]], float, float]:
    """Return explicit not-recorded gaps and unioned coverage seconds."""
    gaps: list[dict[str, Any]] = []
    cursor = since_ts
    recorded = 0.0
    for segment in segments:
        start = max(since_ts, segment.start_ts)
        end = min(until_ts, segment.end_ts)
        if end <= start:
            continue
        if start > cursor:
            gaps.append({"start_ts": cursor, "end_ts": start, "reason": "not_recorded"})
        covered_start = max(cursor, start)
        if end > covered_start:
            recorded += end - covered_start
        cursor = max(cursor, end)
    if cursor < until_ts:
        gaps.append({"start_ts": cursor, "end_ts": until_ts, "reason": "not_recorded"})
    total = until_ts - since_ts
    return gaps, recorded, max(0.0, total - recorded)


def create_export_job(camera_id: str, since_ts: float, until_ts: float) -> dict[str, Any]:
    validate_window(
        since_ts,
        until_ts,
        max_range_s=settings.security_timeline_export_max_range_s,
    )
    if camera_registry.get(camera_id) is None:
        raise TimelineError("unknown camera_id")
    prune_export_jobs()
    segments = list_segments(camera_id, since_ts, until_ts)
    if not segments:
        raise TimelineError("no recorded video in requested range")
    _gaps, recorded_s, gap_s = coverage(segments, since_ts, until_ts)
    reservation_bytes = conservative_reservation(segment.size for segment in segments)
    now = time.time()
    job_id = uuid.uuid4().hex
    job = {
        "id": job_id,
        "status": "pending",
        "created_ts": now,
        "updated_ts": now,
        "camera_id": camera_id,
        "since_ts": since_ts,
        "until_ts": until_ts,
        "file_path": None,
        "sha256": None,
        "bytes": None,
        "error": None,
        "recorded_s": recorded_s,
        "gap_s": gap_s,
        "reservation_bytes": reservation_bytes,
    }

    def _add(state: dict[str, Any]) -> dict[str, Any]:
        outstanding = sum(
            1
            for existing in state["timeline_exports"].values()
            if isinstance(existing, dict)
            and existing.get("status") in {"pending", "running"}
        )
        max_outstanding = max(1, int(settings.security_export_max_outstanding_jobs))
        if outstanding >= max_outstanding:
            raise ExportCapacityError(
                422,
                "Too many exports are already pending; wait for one to finish and retry.",
            )
        ensure_reservation_fits(state, reservation_bytes)
        state["timeline_exports"][job_id] = job
        return job

    with CAPACITY_LOCK:
        security_store.transact(_add)
    return public_job(job)


def _set_job(job_id: str, **patch: Any) -> None:
    def _update(state: dict[str, Any]) -> None:
        job = state["timeline_exports"].get(job_id)
        if not isinstance(job, dict):
            return
        job.update(patch)
        job["updated_ts"] = time.time()

    security_store.transact(_update)


def mark_export_failed(job_id: str, error: str = "timeline export failed") -> None:
    """Best-effort terminal transition that always releases reservation."""
    with CAPACITY_LOCK:
        _set_job(
            job_id,
            status="failed",
            error=error[:160],
            reservation_bytes=0,
            file_path=None,
            bytes=None,
            sha256=None,
        )


def run_export_job(job_id: str) -> None:
    try:
        # Jobs are persisted as pending before their worker thread starts. A
        # blocking lock naturally serializes them without recursion or an
        # extra state write that can fail before the protected runner begins.
        with _EXPORT_LOCK:
            _run_export_job_locked(job_id)
    except Exception as exc:
        # Covers store reads/status writes that happen outside the inner ffmpeg
        # try. Never leave an unobserved task exception or a pending reservation
        # stuck silently; error detail remains generic and path-free.
        log.error(
            "timeline export runner crashed job_id=%s error_type=%s",
            job_id,
            type(exc).__name__,
            exc_info=True,
        )
        try:
            mark_export_failed(job_id)
        except Exception:
            log.error(
                "timeline export failure-state persistence failed job_id=%s",
                job_id,
                exc_info=True,
            )


def _hash_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _run_export_job_locked(job_id: str) -> None:
    state = security_store.read()
    job = state["timeline_exports"].get(job_id)
    if not isinstance(job, dict):
        return
    _set_job(job_id, status="running", error=None)
    list_path: Path | None = None
    temp_path: Path | None = None
    output_path: Path | None = None
    published = False
    try:
        segments = list_segments(
            str(job["camera_id"]), float(job["since_ts"]), float(job["until_ts"])
        )
        if not segments:
            raise TimelineError("no recorded video in requested range")
        gaps, recorded_s, gap_s = coverage(
            segments, float(job["since_ts"]), float(job["until_ts"])
        )
        del gaps  # persisted coverage totals are sufficient for job status
        export_dir = settings.security_exports_dir
        export_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        output = export_dir / "timeline-{}.mp4".format(job_id)
        output_path = output
        temp_path = export_dir / ".timeline-{}.part.mp4".format(job_id)
        list_path = export_dir / ".timeline-{}.ffconcat".format(job_id)
        lines = ["ffconcat version 1.0"]
        for segment in segments:
            safe_path = str(segment.path).replace("'", "'\\''")
            lines.append("file '{}'".format(safe_path))
            inpoint = max(0.0, float(job["since_ts"]) - segment.start_ts)
            outpoint = min(
                segment.end_ts - segment.start_ts,
                float(job["until_ts"]) - segment.start_ts,
            )
            lines.append("inpoint {:.6f}".format(inpoint))
            lines.append("outpoint {:.6f}".format(outpoint))
        fd = os.open(str(list_path), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        try:
            payload = ("\n".join(lines) + "\n").encode("utf-8")
            view = memoryview(payload)
            written = 0
            while written < len(view):
                count = os.write(fd, view[written:])
                if count <= 0:
                    raise OSError("short write while creating export list")
                written += count
            os.fsync(fd)
        finally:
            os.close(fd)
        duration = float(job["until_ts"]) - float(job["since_ts"])
        result = subprocess.run(
            [
                "ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "concat",
                "-safe", "0", "-i", str(list_path),
                "-map", "0:v:0", "-c", "copy",
                "-movflags", "+faststart", "-y", str(temp_path),
            ],
            capture_output=True,
            timeout=max(60.0, min(900.0, duration * 0.5)),
            check=False,
        )
        if result.returncode != 0 or not temp_path.is_file() or temp_path.stat().st_size == 0:
            raise TimelineError("ffmpeg could not create the requested range")
        output_duration = _probe_duration(temp_path)
        if (
            output_duration is None
            or not _has_video_stream(temp_path)
            or output_duration > recorded_s + 3.0
            or output_duration < max(0.1, recorded_s - 3.0)
        ):
            raise TimelineError("export validation failed")
        output_size = temp_path.stat().st_size
        reservation_bytes = max(0, int(job.get("reservation_bytes", 0) or 0))
        if output_size > reservation_bytes:
            raise ExportCapacityError(
                507,
                "Export exceeded its reserved storage; shorten the range and retry.",
            )
        digest = _hash_file(temp_path)
        with CAPACITY_LOCK:
            current_state = security_store.read()
            ensure_finished_output_fits(
                current_state, output_size, exclude_job_id=job_id
            )
            os.replace(temp_path, output)
            output.chmod(0o600)
            _set_job(
                job_id, status="ready", file_path=str(output), sha256=digest,
                bytes=output_size, recorded_s=recorded_s, gap_s=gap_s,
                reservation_bytes=0,
            )
            published = True
    except Exception as exc:
        log.warning("timeline export %s failed: %s", job_id, type(exc).__name__)
        safe_error = (
            exc.detail if isinstance(exc, ExportCapacityError)
            else str(exc) if isinstance(exc, TimelineError)
            else "timeline export failed"
        )
        mark_export_failed(job_id, safe_error)
    finally:
        for path in (list_path, temp_path):
            if path is not None:
                try:
                    path.unlink(missing_ok=True)
                except OSError:
                    pass
        if output_path is not None and not published:
            try:
                output_path.unlink(missing_ok=True)
            except OSError:
                pass


def public_job(job: dict[str, Any]) -> dict[str, Any]:
    job_id = str(job["id"])
    status = str(job.get("status", "failed"))
    return {
        "v": 1,
        "id": job_id,
        "status": status,
        "created_ts": float(job.get("created_ts", 0.0)),
        "updated_ts": float(job.get("updated_ts", 0.0)),
        "requested": {
            "camera_id": job.get("camera_id"),
            "since_ts": job.get("since_ts"),
            "until_ts": job.get("until_ts"),
        },
        "coverage": {
            "recorded_s": float(job.get("recorded_s", 0.0)),
            "gap_s": float(job.get("gap_s", 0.0)),
        },
        "size_bytes": job.get("bytes"),
        "sha256": job.get("sha256"),
        "error": job.get("error"),
        "status_url": "/api/security/timeline/exports/{}".format(job_id),
        "file_url": (
            "/api/security/timeline/exports/{}/file".format(job_id)
            if status == "ready" else None
        ),
    }


def get_export_job(job_id: str) -> dict[str, Any] | None:
    job = security_store.read()["timeline_exports"].get(job_id)
    return public_job(job) if isinstance(job, dict) else None


def get_export_path(job_id: str) -> Path | None:
    job = security_store.read()["timeline_exports"].get(job_id)
    if not isinstance(job, dict) or job.get("status") != "ready":
        return None
    raw = job.get("file_path")
    if not isinstance(raw, str):
        return None
    root = settings.security_exports_dir.resolve()
    path = Path(raw).resolve()
    try:
        path.relative_to(root)
    except ValueError:
        return None
    return path if path.is_file() else None


def prune_export_jobs(now: float | None = None, max_age_s: float = 86400.0) -> int:
    """Remove expired job metadata and its generated file."""
    now = time.time() if now is None else now
    with CAPACITY_LOCK:
        return _prune_export_jobs_locked(now, max_age_s)


def _prune_export_jobs_locked(now: float, max_age_s: float) -> int:
    state_snapshot = security_store.read()
    cleanup_owned_temps(
        state_snapshot, include_timeline=True, include_incident=False
    )
    snapshot = state_snapshot["timeline_exports"]
    root = settings.security_exports_dir.resolve()

    def _ready_file_missing(job: dict[str, Any]) -> bool:
        if job.get("status") != "ready" or not isinstance(job.get("file_path"), str):
            return job.get("status") == "ready"
        path = Path(job["file_path"]).resolve()
        try:
            path.relative_to(root)
        except ValueError:
            return True
        return not path.is_file()

    expired_ids = {
        job_id
        for job_id, job in snapshot.items()
        if (
            isinstance(job, dict)
            and (
                _ready_file_missing(job)
                or (
                    job.get("status") in {"ready", "failed"}
                    and now - float(job.get("updated_ts", now)) > max_age_s
                )
            )
        )
    }
    if not expired_ids:
        return 0

    def _prune(state: dict[str, Any]) -> dict[str, Any]:
        removed: list[str] = []
        count = 0
        jobs = state["timeline_exports"]
        for job_id in expired_ids:
            job = jobs.get(job_id)
            if (
                isinstance(job, dict)
                and (
                    _ready_file_missing(job)
                    or (
                        job.get("status") in {"ready", "failed"}
                        and now - float(job.get("updated_ts", now)) > max_age_s
                    )
                )
            ):
                if isinstance(job.get("file_path"), str):
                    removed.append(job["file_path"])
                del jobs[job_id]
                count += 1
        return {"paths": removed, "count": count}

    result = security_store.transact(_prune)
    for raw in result["paths"]:
        path = Path(raw).resolve()
        try:
            path.relative_to(root)
        except ValueError:
            continue
        try:
            path.unlink(missing_ok=True)
        except OSError:
            pass
    return int(result["count"])
