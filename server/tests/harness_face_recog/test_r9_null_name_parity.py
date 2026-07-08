import json
import sqlite3
import sys
from types import ModuleType

import pytest

from server.tests.harness_face_recog.fixtures import (
    DETECTION_DIR,
    ENCODINGS_PATH,
    EVENTS_DB,
    PERSONS_DIR,
    load_crop_paths,
)


pytestmark = [
    pytest.mark.skipif(
        not PERSONS_DIR.exists(),
        reason="no Jetson person crop fixtures - capture .jetson-snapshot/proof_fixtures/persons",
    ),
    pytest.mark.skipif(
        not EVENTS_DB.exists(),
        reason="no Jetson events DB fixture - capture .jetson-snapshot/db/events.sqlite",
    ),
]


def _load_production_recognizer(monkeypatch):
    """Call detection.detect's real init gate without requiring Jetson SDK."""
    monkeypatch.setitem(sys.modules, "jetson_inference", ModuleType("jetson_inference"))
    monkeypatch.setitem(sys.modules, "jetson_utils", ModuleType("jetson_utils"))
    if str(DETECTION_DIR) not in sys.path:
        sys.path.insert(0, str(DETECTION_DIR))

    import detect

    return detect.init_face_recognizer()


def _person_name_rows():
    with sqlite3.connect(EVENTS_DB) as conn:
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            """
            SELECT id, person_name, person_names_json
            FROM events
            WHERE label = 'person'
            ORDER BY ts ASC, id ASC
            """
        ).fetchall()
    return [dict(row) for row in rows]


def _person_names_empty(raw):
    if raw in (None, "", "null"):
        return True
    decoded = json.loads(raw)
    return decoded == []


def test_given_production_capture_only_loader_when_replaying_real_crops_then_db_is_all_null_parity(
    monkeypatch,
):
    image = pytest.importorskip("PIL.Image")
    np = pytest.importorskip("numpy")

    assert not ENCODINGS_PATH.exists(), (
        "R9 pins the current production dead path: no deployed encodings.pkl, "
        "so the worker can only emit null person_name decisions"
    )

    recognizer = _load_production_recognizer(monkeypatch)
    assert recognizer is not None
    assert recognizer._fr is None
    assert recognizer.names == []

    crop_paths = load_crop_paths()
    assert crop_paths

    replayed = {}
    for crop_path in crop_paths:
        with image.open(crop_path) as im:
            rgb = np.array(im.convert("RGB"))
        replayed[str(crop_path.relative_to(PERSONS_DIR))] = (
            recognizer.recognize_in_crop(rgb, capture_dir=None)
        )

    assert all(name is None for name in replayed.values())

    rows = _person_name_rows()
    assert rows
    invalid_rows = [
        row
        for row in rows
        if row["person_name"] is not None
        or not _person_names_empty(row["person_names_json"])
    ]
    assert invalid_rows == []
    assert len(rows) >= len(replayed)
