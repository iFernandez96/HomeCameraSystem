import sqlite3
import shutil
from pathlib import Path

from app.services import events_db


REPO_ROOT = Path(__file__).resolve().parents[3]
CLIPS_DIR = REPO_ROOT / ".jetson-snapshot" / "proof_fixtures" / "clips"
EVENTS_DB = REPO_ROOT / ".jetson-snapshot" / "db" / "events.sqlite"


def list_clips():
    return [
        (clip_path.stem, clip_path, clip_path.stat().st_size)
        for clip_path in sorted(CLIPS_DIR.glob("*.mp4"))
    ]


def clip_ids():
    return [event_id for event_id, _, _ in list_clips()]


def build_scratch_recordings(tmp_path):
    recordings_dir = tmp_path / "recordings"
    recordings_dir.mkdir()
    copied = []
    for event_id, source, _size_bytes in list_clips():
        target = recordings_dir / "{}.mp4".format(event_id)
        shutil.copy2(source, target)
        copied.append((event_id, source, target))
    return recordings_dir, copied


def copy_events_db(tmp_path):
    target = tmp_path / "events.sqlite"
    shutil.copy2(EVENTS_DB, target)
    return target


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


def ordered_raw_rows_for(ids, *, db_path=EVENTS_DB):
    event_ids = list(ids)
    rows = db_rows_for_path(db_path, event_ids)
    by_id = {row["id"]: row for row in rows}
    return [by_id[event_id] for event_id in event_ids if event_id in by_id]


def db_rows_for_path(db_path, ids):
    event_ids = list(ids)
    if not event_ids:
        return []

    placeholders = ",".join("?" for _ in event_ids)
    with sqlite3.connect(db_path) as conn:
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            f"SELECT * FROM events WHERE id IN ({placeholders})",
            event_ids,
        ).fetchall()
    return [dict(row) for row in rows]


def expected_event_from_raw_row(row):
    return events_db._row_to_event(_DictRow(row))


def assert_event_matches_raw_row(event, raw_row):
    expected = expected_event_from_raw_row(raw_row)
    for key, value in expected.items():
        assert event[key] == value, {
            "event_id": raw_row["id"],
            "field": key,
            "actual": event[key],
            "expected": value,
            "raw_row": raw_row,
        }


class _DictRow:
    def __init__(self, row):
        self._row = row

    def __getitem__(self, key):
        return self._row[key]

