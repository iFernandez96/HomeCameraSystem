import json
import sqlite3
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[3]
EVENTS_JSON = (
    REPO_ROOT
    / ".jetson-snapshot"
    / "continuous_capture_fixtures"
    / "events_tonight.json"
)
EVENTS_DB = REPO_ROOT / ".jetson-snapshot" / "db" / "events.sqlite"


def load_json_rows() -> list[dict[str, Any]]:
    rows = json.loads(EVENTS_JSON.read_text())
    assert isinstance(rows, list)
    return [dict(row) for row in rows]


def load_db_rows() -> list[dict[str, Any]]:
    with sqlite3.connect(EVENTS_DB) as conn:
        conn.row_factory = sqlite3.Row
        rows = conn.execute("SELECT * FROM events").fetchall()
    return [dict(row) for row in rows]


def load_db_rows_by_id() -> dict[str, dict[str, Any]]:
    return {row["id"]: row for row in load_db_rows()}


def normalize(row: dict[str, Any] | sqlite3.Row) -> dict[str, Any]:
    raw = dict(row)
    return {
        "id": raw["id"],
        "ts": float(raw["ts"]),
        "camera_id": raw["camera_id"],
        "label": raw["label"],
        "score": float(raw["score"]),
        "person_name": raw.get("person_name"),
        "thumb_url": raw.get("thumb_url"),
        "clip_url": raw.get("clip_url"),
        "boxes": _json_or_default(raw.get("boxes_json"), []),
        "v": int(raw.get("v", 1)),
        "type": raw.get("type", "detection"),
        "person_names": _json_or_default(raw.get("person_names_json"), None),
    }


def detection_payload_dict(row: dict[str, Any] | sqlite3.Row) -> dict[str, Any]:
    event = normalize(row)
    return {
        "id": event["id"],
        "camera_id": event["camera_id"],
        "label": event["label"],
        "score": event["score"],
        "boxes": event["boxes"],
        "person_name": event["person_name"],
        "person_names": event["person_names"],
        "thumb_url": event["thumb_url"],
        "clip_url": event["clip_url"],
    }


def _json_or_default(value: Any, default: Any) -> Any:
    if value is None or value == "":
        return default
    if isinstance(value, str):
        return json.loads(value)
    return value
