"""Durable SQLite state for background timelapse builds.

The video itself lives in ``settings.timelapses_dir``; keeping the small job
database beside it makes build state survive a server/container restart on the
same persistent volume.
"""
from __future__ import annotations

import logging
import os
import sqlite3
import time
from pathlib import Path
from typing import Literal, TypedDict

log = logging.getLogger(__name__)
JobState = Literal["queued", "running", "ready", "failed"]
_JOB_STATES = frozenset(("queued", "running", "ready", "failed"))


class TimelapseJob(TypedDict):
    date: str
    state: JobState
    error: str | None
    requested_by: str | None
    updated_at: float


def db_path(timelapses_dir: Path) -> Path:
    return timelapses_dir / ".jobs.sqlite3"


def init_db(timelapses_dir: Path) -> Path:
    timelapses_dir.mkdir(parents=True, exist_ok=True)
    path = db_path(timelapses_dir)
    if not path.exists():
        fd = os.open(path, os.O_CREAT | os.O_RDWR, 0o600)
        os.close(fd)
    with sqlite3.connect(path) as conn:
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute(
            "CREATE TABLE IF NOT EXISTS timelapse_jobs ("
            "date TEXT PRIMARY KEY, state TEXT NOT NULL, error TEXT, "
            "requested_by TEXT, updated_at REAL NOT NULL)"
        )
        conn.commit()
    try:
        path.chmod(0o600)
    except OSError as exc:
        log.warning(
            "timelapse_jobs: could not chmod 0o600 on %s: %s", path, exc
        )
    return path


def get(timelapses_dir: Path, date: str) -> TimelapseJob | None:
    path = init_db(timelapses_dir)
    with sqlite3.connect(path) as conn:
        row = conn.execute(
            "SELECT date, state, error, requested_by, updated_at "
            "FROM timelapse_jobs WHERE date = ?", (date,)
        ).fetchone()
    if row is None:
        return None
    return TimelapseJob(
        date=row[0], state=row[1], error=row[2], requested_by=row[3],  # type: ignore[typeddict-item]
        updated_at=float(row[4]),
    )


def set_state(
    timelapses_dir: Path,
    date: str,
    state: JobState,
    *,
    error: str | None = None,
    requested_by: str | None = None,
) -> None:
    if state not in _JOB_STATES:
        raise ValueError("invalid timelapse job state: {0!r}".format(state))
    path = init_db(timelapses_dir)
    with sqlite3.connect(path) as conn:
        conn.execute(
            "INSERT INTO timelapse_jobs(date,state,error,requested_by,updated_at) "
            "VALUES(?,?,?,?,?) ON CONFLICT(date) DO UPDATE SET "
            "state=excluded.state,error=excluded.error,"
            "requested_by=COALESCE(excluded.requested_by,timelapse_jobs.requested_by),"
            "updated_at=excluded.updated_at",
            (date, state, error, requested_by, time.time()),
        )
        conn.commit()


def unfinished(timelapses_dir: Path) -> list[TimelapseJob]:
    path = init_db(timelapses_dir)
    with sqlite3.connect(path) as conn:
        rows = conn.execute(
            "SELECT date,state,error,requested_by,updated_at FROM timelapse_jobs "
            "WHERE state IN ('queued','running') ORDER BY updated_at"
        ).fetchall()
    return [
        TimelapseJob(
            date=r[0], state=r[1], error=r[2], requested_by=r[3],  # type: ignore[typeddict-item]
            updated_at=float(r[4]),
        )
        for r in rows
    ]


def delete(timelapses_dir: Path, date: str) -> None:
    path = init_db(timelapses_dir)
    with sqlite3.connect(path) as conn:
        conn.execute("DELETE FROM timelapse_jobs WHERE date = ?", (date,))
        conn.commit()
