import sqlite3
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[3]
CLIPS_DIR = REPO_ROOT / ".jetson-snapshot" / "proof_fixtures" / "clips"
EVENTS_DB = REPO_ROOT / ".jetson-snapshot" / "db" / "events.sqlite"


def list_clips():
    return [
        (clip_path.stem, clip_path, clip_path.stat().st_size)
        for clip_path in sorted(CLIPS_DIR.glob("*.mp4"))
    ]


def db_rows_for(ids):
    event_ids = list(ids)
    if not event_ids:
        return []

    placeholders = ",".join("?" for _ in event_ids)
    with sqlite3.connect(EVENTS_DB) as conn:
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            f"SELECT * FROM events WHERE id IN ({placeholders})",
            event_ids,
        ).fetchall()
    return [dict(row) for row in rows]
