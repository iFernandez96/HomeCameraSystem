"""Durable recording lifecycle reconciliation and integrity objectives.

The Python 3.6 worker owns capture and publishes a JSON ledger beside clips.
This service mirrors that evidence into SQLite so transitions, validation and
time-to-playback measurements survive worker and server restarts.
"""
from __future__ import annotations

import logging
import os
import sqlite3
import subprocess
import time
from pathlib import Path
from statistics import median
from typing import Any

from ..config import settings
from . import events_db, recording_service


log = logging.getLogger(__name__)
_VALID_STATES = {"recording", "finalizing", "available", "failed", "unknown", "expired"}
_PROCESSING_STATES = {"recording", "finalizing"}
_STUCK_AFTER_S = 5 * 60


def _connect(path: Path) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    if not path.exists():
        fd = os.open(path, os.O_CREAT | os.O_WRONLY, 0o600)
        os.close(fd)
    conn = sqlite3.connect(path, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS recording_jobs (
            event_id TEXT PRIMARY KEY,
            event_ts REAL NOT NULL,
            capture_end_ts REAL,
            state TEXT NOT NULL,
            first_seen_ts REAL NOT NULL,
            updated_ts REAL NOT NULL,
            ready_ts REAL,
            bytes INTEGER,
            source TEXT,
            failure_code TEXT,
            failure_summary TEXT,
            validation_state TEXT NOT NULL DEFAULT 'pending',
            validated_ts REAL,
            file_mtime REAL,
            attempts INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS recording_jobs_state_updated
          ON recording_jobs(state, updated_ts DESC);
        CREATE TABLE IF NOT EXISTS recording_job_transitions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            event_id TEXT NOT NULL,
            from_state TEXT,
            to_state TEXT NOT NULL,
            ts REAL NOT NULL,
            detail TEXT
        );
        CREATE INDEX IF NOT EXISTS recording_job_transitions_event
          ON recording_job_transitions(event_id, ts ASC);
        """
    )
    return conn


def init_db(path: Path | None = None) -> None:
    with _connect(path or settings.recording_jobs_db_path) as conn:
        conn.commit()


def _has_playable_video(path: Path) -> bool:
    try:
        result = subprocess.run(
            [
                "ffprobe", "-v", "error", "-select_streams", "v:0",
                "-show_entries", "stream=codec_type", "-of", "default=nw=1:nk=1",
                str(path),
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=20,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return False
    return result.returncode == 0 and b"video" in result.stdout.splitlines()


def _percentile(values: list[float], fraction: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, int(round((len(ordered) - 1) * fraction))))
    return round(ordered[index], 1)


def reconcile_recent(
    *,
    limit: int = 500,
    validate_limit: int = 3,
    now: float | None = None,
    path: Path | None = None,
) -> dict[str, int]:
    """Mirror recent worker/disk evidence and validate bounded new outputs."""
    now = time.time() if now is None else now
    events = events_db.search(settings.events_db_path, limit=limit)
    ids = [str(event["id"]) for event in events]
    states = recording_service.clip_statuses(ids)
    validated = 0
    transitions = 0

    with _connect(path or settings.recording_jobs_db_path) as conn:
        for event in events:
            event_id = str(event["id"])
            event_ts = float(event.get("ts") or now)
            capture_end_ts = (
                float(event["end_ts"])
                if isinstance(event.get("end_ts"), (int, float))
                and not isinstance(event.get("end_ts"), bool)
                else None
            )
            state = states.get(event_id, "unknown")
            if state not in _VALID_STATES:
                state = "unknown"
            detail = recording_service.clip_state(event_id)
            existing = conn.execute(
                "SELECT * FROM recording_jobs WHERE event_id = ?", (event_id,)
            ).fetchone()
            if state == "unknown" and existing is not None and existing["validation_state"] == "invalid":
                state = "failed"
                detail = {
                    **detail,
                    "failure_code": existing["failure_code"] or "integrity_validation_failed",
                    "failure_summary": existing["failure_summary"] or "The published file does not contain playable video.",
                }

            size = detail.get("bytes") if isinstance(detail.get("bytes"), int) else None
            file_mtime = None
            clip = recording_service.clip_path(event_id)
            if state == "available":
                try:
                    stat = clip.stat()
                    size = stat.st_size
                    file_mtime = stat.st_mtime
                except OSError:
                    state = "unknown"

            validation_state = existing["validation_state"] if existing else "pending"
            validated_ts = existing["validated_ts"] if existing else None
            if (
                state == "available"
                and validated < validate_limit
                and (
                    existing is None
                    or validation_state != "valid"
                    or existing["file_mtime"] != file_mtime
                    or existing["bytes"] != size
                )
            ):
                validated += 1
                if _has_playable_video(clip):
                    validation_state = "valid"
                    validated_ts = now
                else:
                    validation_state = "invalid"
                    validated_ts = now
                    state = "failed"
                    detail = {
                        **detail,
                        "failure_code": "integrity_validation_failed",
                        "failure_summary": "The published file does not contain playable video.",
                    }
                    # An invalid final must never remain serveable as an
                    # apparently available video. Only this exact event-owned
                    # path is removed.
                    try:
                        clip.unlink()
                    except FileNotFoundError:
                        pass
                    except OSError:
                        log.warning(
                            "recording integrity could not remove invalid clip event_id=%s",
                            event_id,
                            exc_info=True,
                        )

            previous_state = str(existing["state"]) if existing else None
            source_updated = detail.get("updated_ts")
            if state == "available" and file_mtime is not None:
                job_updated_ts = file_mtime
            elif isinstance(source_updated, (int, float)) and not isinstance(source_updated, bool):
                job_updated_ts = float(source_updated)
            elif state in _PROCESSING_STATES:
                job_updated_ts = event_ts
            else:
                job_updated_ts = now
            ready_ts = existing["ready_ts"] if existing else None
            if state == "available" and ready_ts is None:
                # The final file's publication mtime is the best durable
                # approximation of when playback became possible. Using the
                # reconciler's first scan time would inflate latency after a
                # long server outage.
                ready_ts = file_mtime if file_mtime is not None else now
            failure_code = detail.get("failure_code") if state == "failed" else None
            failure_summary = detail.get("failure_summary") if state == "failed" else None
            attempts = int(existing["attempts"]) if existing else 0
            if previous_state != state:
                transitions += 1
                attempts += 1
                conn.execute(
                    "INSERT INTO recording_job_transitions "
                    "(event_id, from_state, to_state, ts, detail) VALUES (?, ?, ?, ?, ?)",
                    (event_id, previous_state, state, now, failure_code),
                )
            conn.execute(
                """
                INSERT INTO recording_jobs (
                    event_id,event_ts,capture_end_ts,state,first_seen_ts,updated_ts,ready_ts,bytes,
                    source,failure_code,failure_summary,validation_state,validated_ts,
                    file_mtime,attempts
                ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                ON CONFLICT(event_id) DO UPDATE SET
                    capture_end_ts=excluded.capture_end_ts,
                    state=excluded.state, updated_ts=excluded.updated_ts,
                    ready_ts=excluded.ready_ts, bytes=excluded.bytes,
                    source=excluded.source, failure_code=excluded.failure_code,
                    failure_summary=excluded.failure_summary,
                    validation_state=excluded.validation_state,
                    validated_ts=excluded.validated_ts,
                    file_mtime=excluded.file_mtime, attempts=excluded.attempts
                """,
                (
                    event_id, event_ts, capture_end_ts, state,
                    float(existing["first_seen_ts"]) if existing else now,
                    job_updated_ts, ready_ts, size, str(detail.get("source") or "unknown"),
                    failure_code, failure_summary, validation_state, validated_ts,
                    file_mtime, attempts,
                ),
            )
        conn.commit()
    return {"examined": len(events), "validated": validated, "transitions": transitions}


def summary(*, now: float | None = None, path: Path | None = None) -> dict[str, Any]:
    now = time.time() if now is None else now
    with _connect(path or settings.recording_jobs_db_path) as conn:
        rows = conn.execute(
            "SELECT * FROM recording_jobs ORDER BY event_ts DESC LIMIT 1000"
        ).fetchall()
    counts = {name: 0 for name in _VALID_STATES}
    latency = []
    oldest_processing_ts = None
    invalid = 0
    for row in rows:
        state = str(row["state"])
        counts[state if state in counts else "unknown"] += 1
        if state in _PROCESSING_STATES:
            progress_ts = float(row["updated_ts"])
            oldest_processing_ts = (
                progress_ts if oldest_processing_ts is None else min(oldest_processing_ts, progress_ts)
            )
        if row["ready_ts"] is not None:
            reference_ts = row["capture_end_ts"] if row["capture_end_ts"] is not None else row["event_ts"]
            latency.append(max(0.0, float(row["ready_ts"]) - float(reference_ts)))
        if row["validation_state"] == "invalid":
            invalid += 1
    oldest_age = None if oldest_processing_ts is None else max(0.0, now - oldest_processing_ts)
    stuck = sum(
        1 for row in rows
        if row["state"] in _PROCESSING_STATES and now - float(row["updated_ts"]) > _STUCK_AFTER_S
    )
    median_latency = round(median(latency), 1) if latency else None
    p95_latency = _percentile(latency, 0.95)
    objectives = [
        {
            "id": "no_stuck_jobs", "label": "No video waits unresolved over five minutes",
            "met": stuck == 0, "value": stuck, "target": 0,
        },
        {
            "id": "validated_available", "label": "Every available video passes validation",
            "met": invalid == 0, "value": invalid, "target": 0,
        },
        {
            "id": "playback_p95", "label": "95% of videos become playable within 30 seconds after capture ends",
            "met": None if p95_latency is None else p95_latency <= 30.0,
            "value": p95_latency, "target": 30.0,
        },
    ]
    return {
        "v": 1,
        "total": len(rows),
        "counts": counts,
        "processing": counts["recording"] + counts["finalizing"],
        "oldest_processing_age_s": None if oldest_age is None else round(oldest_age, 1),
        "stuck_jobs": stuck,
        "invalid_videos": invalid,
        "median_ready_s": median_latency,
        "p95_ready_s": p95_latency,
        "objectives": objectives,
        "generated_ts": now,
    }


def recent_failures(limit: int = 20, path: Path | None = None) -> list[dict[str, Any]]:
    with _connect(path or settings.recording_jobs_db_path) as conn:
        rows = conn.execute(
            "SELECT event_id,event_ts,state,failure_code,failure_summary,updated_ts "
            "FROM recording_jobs WHERE state = 'failed' ORDER BY updated_ts DESC LIMIT ?",
            (limit,),
        ).fetchall()
    return [dict(row) for row in rows]
