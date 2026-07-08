import shutil
import sqlite3
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[3]
EVENTS_DB = REPO_ROOT / ".jetson-snapshot" / "db" / "events.sqlite"


def copy_events_db(tmp_path: Path) -> Path:
    target = tmp_path / "events.sqlite"
    shutil.copy2(EVENTS_DB, target)
    return target


def camera_counts(db_path: Path = EVENTS_DB) -> dict[str, int]:
    with sqlite3.connect(db_path) as conn:
        rows = conn.execute(
            "SELECT camera_id, COUNT(*) FROM events GROUP BY camera_id"
        ).fetchall()
    return {str(camera_id): int(count) for camera_id, count in rows}


def sample_front_door_ids(db_path: Path = EVENTS_DB, *, limit: int = 10) -> list[str]:
    with sqlite3.connect(db_path) as conn:
        rows = conn.execute(
            "SELECT id FROM events WHERE camera_id = 'front_door' "
            "ORDER BY ts DESC LIMIT ?",
            (limit,),
        ).fetchall()
    return [str(row[0]) for row in rows]
