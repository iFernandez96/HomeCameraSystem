import json
import sqlite3
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[3]
PERSONS_DIR = REPO_ROOT / ".jetson-snapshot" / "proof_fixtures" / "persons"
EVENTS_DB = REPO_ROOT / ".jetson-snapshot" / "db" / "events.sqlite"

SIDECAR_REQUIRED_KEYS = {
    "confidence",
    "detection",
    "event_id",
    "gear",
    "infer_ms",
    "jpeg_quality",
    "kind",
    "model",
    "pad_frac",
    "person_index",
    "predicted_name",
    "schema_version",
    "source",
    "sw_rev",
    "ts_ms",
}


def load_crop_paths() -> list[Path]:
    return sorted(PERSONS_DIR.glob("*/*.jpg"))


def load_sidecar_paths() -> list[Path]:
    return sorted(PERSONS_DIR.glob("*/*.json"))


def load_sidecar(path: Path) -> dict[str, Any]:
    data = json.loads(path.read_text())
    assert isinstance(data, dict)
    return data


def load_sidecars() -> list[dict[str, Any]]:
    return [load_sidecar(path) for path in load_sidecar_paths()]


def load_db_rows_by_id() -> dict[str, dict[str, Any]]:
    with sqlite3.connect(EVENTS_DB) as conn:
        conn.row_factory = sqlite3.Row
        rows = conn.execute("SELECT * FROM events").fetchall()
    return {row["id"]: dict(row) for row in rows}


def count_person_events() -> int:
    with sqlite3.connect(EVENTS_DB) as conn:
        return int(
            conn.execute("SELECT COUNT(*) FROM events WHERE label = 'person'").fetchone()[0]
        )


def count_named_person_name_rows() -> int:
    with sqlite3.connect(EVENTS_DB) as conn:
        return int(
            conn.execute(
                """
                SELECT COUNT(*)
                FROM events
                WHERE person_name IS NOT NULL AND person_name != ''
                """
            ).fetchone()[0]
        )
