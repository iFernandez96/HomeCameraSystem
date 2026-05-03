"""Direct unit tests for the iter-216 events_db module.

Each test gets a per-tmp_path SQLite file via pytest's tmp_path
fixture so they don't leak state. The schema is tiny enough that
init+populate per test is fractions of a millisecond.
"""
from __future__ import annotations

import json
import os
import sqlite3
import time

import pytest

from app.services import events_db
from app.services.event_bus import make_detection_event


def _make_event(**over) -> dict:
    """Helper: minimal DetectionEventDict with overrides."""
    e = make_detection_event(
        label="person",
        score=0.91,
        boxes=[{"x": 0.1, "y": 0.1, "w": 0.2, "h": 0.3, "label": "person", "score": 0.91}],
    )
    e.update(over)
    return e


def test_init_db_creates_schema(tmp_path):
    path = tmp_path / "events.db"
    events_db.init_db(path)
    assert path.exists()
    # Schema is queryable.
    with sqlite3.connect(path) as conn:
        rows = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='events'"
        ).fetchall()
        assert len(rows) == 1


def test_init_db_creates_indexes(tmp_path):
    """Without indexes, the cursor pagination + camera/person filters
    in slice 4 would table-scan. Pin that the indexes are created so
    a future iter doesn't drop them by mistake."""
    path = tmp_path / "events.db"
    events_db.init_db(path)
    with sqlite3.connect(path) as conn:
        idx = {
            r[0]
            for r in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='index' "
                "AND tbl_name='events' AND name NOT LIKE 'sqlite_%'"
            ).fetchall()
        }
    assert "events_ts_desc" in idx
    assert "events_camera_ts" in idx
    assert "events_person_ts" in idx


def test_init_db_creates_file_with_mode_0o600(tmp_path):
    """Mirrors the iter-183 users_db pattern: the file MUST be
    created with mode 0o600 BEFORE sqlite3.connect opens it. Stops
    a stray umask leaving the events DB world-readable for a
    millisecond at boot."""
    path = tmp_path / "events.db"
    events_db.init_db(path)
    mode = os.stat(path).st_mode & 0o777
    assert mode == 0o600


def test_init_db_idempotent(tmp_path):
    path = tmp_path / "events.db"
    events_db.init_db(path)
    events_db.init_db(path)
    # No exception; schema is unchanged.
    assert events_db.count_events(path) == 0


def test_init_db_belt_and_braces_chmod_for_legacy(tmp_path):
    """Pre-existing file with looser perms (legacy install upgraded
    in-place) gets chmod'd to 0o600 by the belt-and-braces step."""
    path = tmp_path / "events.db"
    # Pre-create with 0o644 (group/world-readable).
    path.touch(mode=0o644)
    events_db.init_db(path)
    mode = os.stat(path).st_mode & 0o777
    assert mode == 0o600


def test_insert_event_round_trips(tmp_path):
    path = tmp_path / "events.db"
    events_db.init_db(path)
    e = _make_event(camera_id="cam1", person_name="alice")
    inserted = events_db.insert_event(path, e)
    assert inserted is True
    items = events_db.recent(path, limit=10)
    assert len(items) == 1
    got = items[0]
    # All wire-shape fields preserved.
    assert got["id"] == e["id"]
    assert got["ts"] == pytest.approx(e["ts"])
    assert got["camera_id"] == "cam1"
    assert got["label"] == "person"
    assert got["score"] == pytest.approx(0.91)
    assert got["person_name"] == "alice"
    assert got["thumb_url"] is None
    assert got["clip_url"] is None
    # Boxes survive the JSON round-trip.
    assert got["boxes"] == e["boxes"]
    # Defaults preserved.
    assert got["v"] == 1
    assert got["type"] == "detection"


def test_insert_event_preserves_optional_urls(tmp_path):
    path = tmp_path / "events.db"
    events_db.init_db(path)
    e = _make_event(
        thumb_url="/snapshots/thumb_1.jpg",
        clip_url="/api/events/abc/clip",
    )
    events_db.insert_event(path, e)
    got = events_db.recent(path)[0]
    assert got["thumb_url"] == "/snapshots/thumb_1.jpg"
    assert got["clip_url"] == "/api/events/abc/clip"


def test_insert_event_idempotent_on_duplicate_id(tmp_path):
    """INSERT OR IGNORE — a duplicate publish (network retry, race)
    must NOT raise IntegrityError. Returns False to signal the row
    was already present."""
    path = tmp_path / "events.db"
    events_db.init_db(path)
    e = _make_event()
    assert events_db.insert_event(path, e) is True
    assert events_db.insert_event(path, e) is False
    assert events_db.count_events(path) == 1


def test_recent_returns_newest_first(tmp_path):
    path = tmp_path / "events.db"
    events_db.init_db(path)
    base = time.time()
    for offset in (0, 10, 20, 30):
        events_db.insert_event(path, _make_event(ts=base - offset))
    items = events_db.recent(path, limit=10)
    # Newest first — the offset=0 event has the largest ts.
    assert len(items) == 4
    timestamps = [e["ts"] for e in items]
    assert timestamps == sorted(timestamps, reverse=True)


def test_recent_honors_limit(tmp_path):
    path = tmp_path / "events.db"
    events_db.init_db(path)
    for _ in range(50):
        events_db.insert_event(path, _make_event())
        time.sleep(0.0001)  # ensure distinct ts
    items = events_db.recent(path, limit=10)
    assert len(items) == 10


def test_recent_before_ts_paginates(tmp_path):
    """Cursor pagination: pass the ts of the LAST item from page 1
    to fetch page 2 (older events). Strict `<` semantics — a tied-
    ts pair doesn't appear on both pages."""
    path = tmp_path / "events.db"
    events_db.init_db(path)
    base = time.time()
    # 5 distinct timestamps, newest at offset 0.
    for offset in range(5):
        events_db.insert_event(path, _make_event(ts=base - offset))
    page1 = events_db.recent(path, limit=2)
    assert len(page1) == 2
    cursor = page1[-1]["ts"]
    page2 = events_db.recent(path, limit=2, before_ts=cursor)
    assert len(page2) == 2
    # No overlap between pages.
    page1_ids = {e["id"] for e in page1}
    page2_ids = {e["id"] for e in page2}
    assert page1_ids.isdisjoint(page2_ids)
    # Page 2's events are older than page 1's last event.
    for e in page2:
        assert e["ts"] < cursor


def test_recent_before_ts_excludes_tied_ts(tmp_path):
    """Strict `<` not `<=` — a tied ts must not appear on the next
    page. This is a deliberate choice; without it, a page boundary
    on a duplicate-ts pair would yield stutter."""
    path = tmp_path / "events.db"
    events_db.init_db(path)
    ts = 1700000000.0
    events_db.insert_event(path, _make_event(ts=ts))
    events_db.insert_event(path, _make_event(ts=ts))
    page2 = events_db.recent(path, limit=10, before_ts=ts)
    assert page2 == []


def test_count_events(tmp_path):
    path = tmp_path / "events.db"
    events_db.init_db(path)
    assert events_db.count_events(path) == 0
    events_db.insert_event(path, _make_event())
    events_db.insert_event(path, _make_event())
    assert events_db.count_events(path) == 2


def test_recent_empty_db_returns_empty_list(tmp_path):
    path = tmp_path / "events.db"
    events_db.init_db(path)
    assert events_db.recent(path) == []


def test_reset_truncates(tmp_path):
    path = tmp_path / "events.db"
    events_db.init_db(path)
    events_db.insert_event(path, _make_event())
    assert events_db.count_events(path) == 1
    events_db.reset(path)
    assert events_db.count_events(path) == 0


def test_recent_handles_malformed_boxes_json_gracefully(tmp_path):
    """Operator hand-edits the DB with malformed JSON in boxes_json
    → `recent` returns the row with empty boxes rather than 500-ing
    on the whole listing. Mirrors the iter-? push_service legacy
    sub tolerance pattern."""
    path = tmp_path / "events.db"
    events_db.init_db(path)
    e = _make_event()
    # Insert via raw SQL with broken boxes_json.
    with sqlite3.connect(path) as conn:
        conn.execute(
            "INSERT INTO events (id, ts, camera_id, label, score, boxes_json) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (e["id"], e["ts"], "cam1", "person", 0.5, "{not-json"),
        )
        conn.commit()
    items = events_db.recent(path)
    assert len(items) == 1
    assert items[0]["boxes"] == []


def test_insert_handles_missing_optional_fields(tmp_path):
    """make_detection_event leaves person_name / thumb_url / clip_url
    as None by default. The insert helper must accept those as NULL
    rather than serializing as the string 'None'."""
    path = tmp_path / "events.db"
    events_db.init_db(path)
    e = make_detection_event(label="person", score=0.5, boxes=[])
    events_db.insert_event(path, e)
    got = events_db.recent(path)[0]
    assert got["person_name"] is None
    assert got["thumb_url"] is None
    assert got["clip_url"] is None


def test_boxes_json_persisted_as_actual_json(tmp_path):
    """Defense: confirm the stored value parses as JSON. A future
    refactor that swaps to msgpack or repr() would silently break
    the slice-4 search route's box-deserialization path."""
    path = tmp_path / "events.db"
    events_db.init_db(path)
    boxes = [{"x": 0.1, "y": 0.2, "w": 0.3, "h": 0.4, "label": "car", "score": 0.7}]
    e = _make_event(boxes=boxes)
    events_db.insert_event(path, e)
    with sqlite3.connect(path) as conn:
        row = conn.execute("SELECT boxes_json FROM events").fetchone()
    parsed = json.loads(row[0])
    assert parsed == boxes


# iter-219 (Feature #6 slice 4): events_db.search() helper. Each
# filter is AND-combined; passing only `limit` reduces to recent().

def test_search_no_filters_equivalent_to_recent(tmp_path):
    path = tmp_path / "events.db"
    events_db.init_db(path)
    base = time.time()
    for offset in range(5):
        events_db.insert_event(path, _make_event(ts=base - offset))
    items = events_db.search(path, limit=10)
    recents = events_db.recent(path, limit=10)
    # Same rows, same order — no filters means search ≡ recent.
    assert [e["id"] for e in items] == [e["id"] for e in recents]


def test_search_filters_by_camera_id(tmp_path):
    path = tmp_path / "events.db"
    events_db.init_db(path)
    events_db.insert_event(path, _make_event(camera_id="cam1"))
    events_db.insert_event(path, _make_event(camera_id="cam2"))
    events_db.insert_event(path, _make_event(camera_id="cam1"))
    items = events_db.search(path, camera_id="cam1")
    assert len(items) == 2
    assert all(e["camera_id"] == "cam1" for e in items)


def test_search_filters_by_person_name(tmp_path):
    path = tmp_path / "events.db"
    events_db.init_db(path)
    events_db.insert_event(path, _make_event(person_name="alice"))
    events_db.insert_event(path, _make_event(person_name="bob"))
    events_db.insert_event(path, _make_event(person_name=None))
    items = events_db.search(path, person_name="alice")
    assert len(items) == 1
    assert items[0]["person_name"] == "alice"


def test_search_filters_by_label(tmp_path):
    path = tmp_path / "events.db"
    events_db.init_db(path)
    events_db.insert_event(path, _make_event(label="person"))
    events_db.insert_event(path, _make_event(label="car"))
    events_db.insert_event(path, _make_event(label="person"))
    items = events_db.search(path, label="car")
    assert len(items) == 1
    assert items[0]["label"] == "car"


def test_search_since_ts_inclusive(tmp_path):
    """iter-219 semantic: since_ts is INCLUSIVE — events at exactly
    that ts are returned. "Show me detections from 9am" includes
    the 9:00:00.000 event."""
    path = tmp_path / "events.db"
    events_db.init_db(path)
    events_db.insert_event(path, _make_event(ts=100.0))
    events_db.insert_event(path, _make_event(ts=200.0))
    events_db.insert_event(path, _make_event(ts=300.0))
    items = events_db.search(path, since_ts=200.0)
    timestamps = sorted(e["ts"] for e in items)
    assert timestamps == [200.0, 300.0]


def test_search_until_ts_exclusive(tmp_path):
    """iter-219 semantic: until_ts is EXCLUSIVE — matches the
    cursor pagination strict-`<` semantic from `recent`."""
    path = tmp_path / "events.db"
    events_db.init_db(path)
    events_db.insert_event(path, _make_event(ts=100.0))
    events_db.insert_event(path, _make_event(ts=200.0))
    events_db.insert_event(path, _make_event(ts=300.0))
    items = events_db.search(path, until_ts=200.0)
    timestamps = sorted(e["ts"] for e in items)
    assert timestamps == [100.0]


def test_search_window_combines_since_and_until(tmp_path):
    path = tmp_path / "events.db"
    events_db.init_db(path)
    for ts in (50.0, 100.0, 150.0, 200.0, 250.0):
        events_db.insert_event(path, _make_event(ts=ts))
    items = events_db.search(path, since_ts=100.0, until_ts=200.0)
    timestamps = sorted(e["ts"] for e in items)
    assert timestamps == [100.0, 150.0]


def test_search_filters_AND_combine(tmp_path):
    """All filters are AND-combined."""
    path = tmp_path / "events.db"
    events_db.init_db(path)
    events_db.insert_event(
        path, _make_event(camera_id="cam1", person_name="alice")
    )
    events_db.insert_event(
        path, _make_event(camera_id="cam1", person_name="bob")
    )
    events_db.insert_event(
        path, _make_event(camera_id="cam2", person_name="alice")
    )
    items = events_db.search(path, camera_id="cam1", person_name="alice")
    assert len(items) == 1


def test_search_before_ts_paginates(tmp_path):
    """Same cursor pagination semantic as `recent` — the
    `before_ts` advances the page without losing other filters."""
    path = tmp_path / "events.db"
    events_db.init_db(path)
    base = time.time()
    for offset in range(5):
        events_db.insert_event(
            path, _make_event(ts=base - offset, camera_id="cam1")
        )
    page1 = events_db.search(path, camera_id="cam1", limit=2)
    assert len(page1) == 2
    page2 = events_db.search(
        path, camera_id="cam1", limit=2, before_ts=page1[-1]["ts"]
    )
    assert len(page2) == 2
    page1_ids = {e["id"] for e in page1}
    page2_ids = {e["id"] for e in page2}
    assert page1_ids.isdisjoint(page2_ids)


def test_search_empty_db_returns_empty(tmp_path):
    path = tmp_path / "events.db"
    events_db.init_db(path)
    assert events_db.search(path, camera_id="cam1") == []


def test_search_empty_string_filter_matches_no_rows(tmp_path):
    """Empty string is not the same as None — it's an explicit
    "match exactly empty string." No real worker emits empty
    camera_id, so this returns []. Pinned because it's surprising
    if a caller passes `?camera_id=` and expects "all cameras"."""
    path = tmp_path / "events.db"
    events_db.init_db(path)
    events_db.insert_event(path, _make_event(camera_id="cam1"))
    assert events_db.search(path, camera_id="") == []


# iter-222 (Feature #6 slice 7b-server): count_by_day helper.
# SQL date() with 'localtime' bucketing matches iter-209 schedule_window
# semantics — same "what day was this on" answer across the stack.

def test_count_by_day_groups_events_into_days(tmp_path):
    """Three events on the same day → one bucket with count 3."""
    path = tmp_path / "events.db"
    events_db.init_db(path)
    base = time.mktime((2026, 4, 30, 12, 0, 0, 0, 0, -1))
    for offset_minutes in (0, 30, 60):
        events_db.insert_event(
            path, _make_event(ts=base + offset_minutes * 60)
        )
    counts = events_db.count_by_day(path)
    assert sum(counts.values()) == 3
    # Exactly one bucket — all three events on the same local day.
    assert len(counts) == 1


def test_count_by_day_returns_yyyy_mm_dd_keys(tmp_path):
    path = tmp_path / "events.db"
    events_db.init_db(path)
    base = time.mktime((2026, 4, 30, 12, 0, 0, 0, 0, -1))
    events_db.insert_event(path, _make_event(ts=base))
    counts = events_db.count_by_day(path)
    assert list(counts.keys())[0] == "2026-04-30"


def test_count_by_day_separates_consecutive_days(tmp_path):
    path = tmp_path / "events.db"
    events_db.init_db(path)
    day1 = time.mktime((2026, 4, 29, 12, 0, 0, 0, 0, -1))
    day2 = time.mktime((2026, 4, 30, 12, 0, 0, 0, 0, -1))
    events_db.insert_event(path, _make_event(ts=day1))
    events_db.insert_event(path, _make_event(ts=day2))
    events_db.insert_event(path, _make_event(ts=day2))
    counts = events_db.count_by_day(path)
    assert counts["2026-04-29"] == 1
    assert counts["2026-04-30"] == 2


def test_count_by_day_returns_keys_in_ascending_order(tmp_path):
    """iter-223 client heatmap renders left-to-right; insertion-
    ordered ascending keys avoid a re-sort at render time."""
    path = tmp_path / "events.db"
    events_db.init_db(path)
    day1 = time.mktime((2026, 4, 28, 12, 0, 0, 0, 0, -1))
    day2 = time.mktime((2026, 4, 29, 12, 0, 0, 0, 0, -1))
    day3 = time.mktime((2026, 4, 30, 12, 0, 0, 0, 0, -1))
    # Insert in reverse order to verify the ORDER BY isn't relying
    # on insertion order.
    events_db.insert_event(path, _make_event(ts=day3))
    events_db.insert_event(path, _make_event(ts=day1))
    events_db.insert_event(path, _make_event(ts=day2))
    keys = list(events_db.count_by_day(path).keys())
    assert keys == sorted(keys)


def test_count_by_day_filters_by_camera_id(tmp_path):
    path = tmp_path / "events.db"
    events_db.init_db(path)
    base = time.mktime((2026, 4, 30, 12, 0, 0, 0, 0, -1))
    events_db.insert_event(path, _make_event(ts=base, camera_id="cam1"))
    events_db.insert_event(path, _make_event(ts=base, camera_id="cam2"))
    events_db.insert_event(path, _make_event(ts=base, camera_id="cam1"))
    counts = events_db.count_by_day(path, camera_id="cam1")
    assert counts == {"2026-04-30": 2}


def test_count_by_day_filters_by_person_name(tmp_path):
    path = tmp_path / "events.db"
    events_db.init_db(path)
    base = time.mktime((2026, 4, 30, 12, 0, 0, 0, 0, -1))
    events_db.insert_event(path, _make_event(ts=base, person_name="alice"))
    events_db.insert_event(path, _make_event(ts=base, person_name="bob"))
    counts = events_db.count_by_day(path, person_name="alice")
    assert counts == {"2026-04-30": 1}


def test_count_by_day_window_filters(tmp_path):
    """since_ts inclusive + until_ts exclusive — same semantic as
    `search()`."""
    path = tmp_path / "events.db"
    events_db.init_db(path)
    day1 = time.mktime((2026, 4, 28, 12, 0, 0, 0, 0, -1))
    day2 = time.mktime((2026, 4, 29, 12, 0, 0, 0, 0, -1))
    day3 = time.mktime((2026, 4, 30, 12, 0, 0, 0, 0, -1))
    for ts in (day1, day2, day3):
        events_db.insert_event(path, _make_event(ts=ts))
    counts = events_db.count_by_day(path, since_ts=day2, until_ts=day3)
    # day2 included (since=inclusive), day3 excluded (until=exclusive).
    assert counts == {"2026-04-29": 1}


def test_count_by_day_empty_db_returns_empty_dict(tmp_path):
    path = tmp_path / "events.db"
    events_db.init_db(path)
    assert events_db.count_by_day(path) == {}


# iter-227 (Feature #6 polish): face_unrecognized filter for both
# search() and count_by_day(). Closes the iter-221 client `__unknown__`
# chip server-side gap. true → person_name IS NULL; false → IS NOT
# NULL; None → no filter.

def test_search_face_unrecognized_true_returns_only_null_persons(tmp_path):
    path = tmp_path / "events.db"
    events_db.init_db(path)
    events_db.insert_event(path, _make_event(person_name="alice"))
    events_db.insert_event(path, _make_event(person_name=None))
    events_db.insert_event(path, _make_event(person_name="bob"))
    items = events_db.search(path, face_unrecognized=True)
    assert len(items) == 1
    assert items[0]["person_name"] is None


def test_search_face_unrecognized_false_returns_only_named_persons(tmp_path):
    path = tmp_path / "events.db"
    events_db.init_db(path)
    events_db.insert_event(path, _make_event(person_name="alice"))
    events_db.insert_event(path, _make_event(person_name=None))
    events_db.insert_event(path, _make_event(person_name="bob"))
    items = events_db.search(path, face_unrecognized=False)
    assert len(items) == 2
    assert all(e["person_name"] is not None for e in items)


def test_search_face_unrecognized_none_does_not_filter(tmp_path):
    """None default = no filter applied — same shape as iter-219."""
    path = tmp_path / "events.db"
    events_db.init_db(path)
    events_db.insert_event(path, _make_event(person_name="alice"))
    events_db.insert_event(path, _make_event(person_name=None))
    items = events_db.search(path, face_unrecognized=None)
    assert len(items) == 2


def test_search_face_unrecognized_combines_with_camera_filter(tmp_path):
    path = tmp_path / "events.db"
    events_db.init_db(path)
    events_db.insert_event(
        path, _make_event(camera_id="cam1", person_name="alice")
    )
    events_db.insert_event(
        path, _make_event(camera_id="cam1", person_name=None)
    )
    events_db.insert_event(
        path, _make_event(camera_id="cam2", person_name=None)
    )
    items = events_db.search(path, camera_id="cam1", face_unrecognized=True)
    assert len(items) == 1
    assert items[0]["camera_id"] == "cam1"
    assert items[0]["person_name"] is None


def test_count_by_day_face_unrecognized_filters(tmp_path):
    path = tmp_path / "events.db"
    events_db.init_db(path)
    base = time.mktime((2026, 4, 30, 12, 0, 0, 0, 0, -1))
    events_db.insert_event(path, _make_event(ts=base, person_name="alice"))
    events_db.insert_event(path, _make_event(ts=base, person_name=None))
    events_db.insert_event(path, _make_event(ts=base, person_name=None))
    counts = events_db.count_by_day(path, face_unrecognized=True)
    assert counts == {"2026-04-30": 2}
    counts = events_db.count_by_day(path, face_unrecognized=False)
    assert counts == {"2026-04-30": 1}


# iter-303 (notifications fuzzy-search): distinct_persons + distinct_cameras
# power the toggle-list picker on the Notifications panel. Pin the SQL
# behavior here so a future schema change can't silently break the picker.

def test_when_events_have_mixed_persons_then_distinct_persons_returns_alpha_sorted_unique(
    tmp_path,
):
    # arrange
    path = tmp_path / "events.db"
    events_db.init_db(path)
    events_db.insert_event(path, _make_event(person_name="bob"))
    events_db.insert_event(path, _make_event(person_name="Alice"))
    events_db.insert_event(path, _make_event(person_name="bob"))  # dup
    events_db.insert_event(path, _make_event(person_name=None))   # excluded

    # act
    names = events_db.distinct_persons(path)

    # assert — case-insensitive sort, dups removed, NULLs excluded.
    assert names == ["Alice", "bob"]


def test_when_no_events_have_person_name_then_distinct_persons_returns_empty(
    tmp_path,
):
    # arrange
    path = tmp_path / "events.db"
    events_db.init_db(path)
    events_db.insert_event(path, _make_event(person_name=None))

    # act
    names = events_db.distinct_persons(path)

    # assert
    assert names == []


def test_when_events_have_mixed_camera_ids_then_distinct_cameras_returns_alpha_sorted_unique(
    tmp_path,
):
    # arrange
    path = tmp_path / "events.db"
    events_db.init_db(path)
    events_db.insert_event(path, _make_event(camera_id="cam2"))
    events_db.insert_event(path, _make_event(camera_id="cam1"))
    events_db.insert_event(path, _make_event(camera_id="cam1"))  # dup

    # act
    cams = events_db.distinct_cameras(path)

    # assert
    assert cams == ["cam1", "cam2"]


def test_given_limit_when_distinct_persons_called_then_at_most_limit_returned(tmp_path):
    # arrange
    path = tmp_path / "events.db"
    events_db.init_db(path)
    for n in ("alice", "bob", "carol", "dave"):
        events_db.insert_event(path, _make_event(person_name=n))

    # act
    names = events_db.distinct_persons(path, limit=2)

    # assert
    assert len(names) == 2


# iter-299 (manual event delete): single + bulk-by-day. Pin the
# wire shape + day-bucketing semantics.

def test_when_delete_called_with_existing_id_then_returns_true_and_row_gone(tmp_path):
    # arrange
    path = tmp_path / "events.db"
    events_db.init_db(path)
    e = _make_event()
    events_db.insert_event(path, e)

    # act
    deleted = events_db.delete(path, e["id"])

    # assert
    assert deleted is True
    assert events_db.recent(path) == []


def test_when_delete_called_with_unknown_id_then_returns_false(tmp_path):
    # arrange
    path = tmp_path / "events.db"
    events_db.init_db(path)

    # act
    deleted = events_db.delete(path, "no_such_id")

    # assert
    assert deleted is False


def test_given_three_events_on_two_days_when_delete_by_day_then_only_target_day_removed(
    tmp_path,
):
    # arrange — 2 events on 2026-04-30 + 1 event on 2026-05-01.
    path = tmp_path / "events.db"
    events_db.init_db(path)
    apr_base = time.mktime((2026, 4, 30, 12, 0, 0, 0, 0, -1))
    may_base = time.mktime((2026, 5, 1, 12, 0, 0, 0, 0, -1))
    events_db.insert_event(path, _make_event(ts=apr_base))
    events_db.insert_event(path, _make_event(ts=apr_base + 60))
    events_db.insert_event(path, _make_event(ts=may_base))

    # act
    n = events_db.delete_by_day(path, "2026-04-30")

    # assert — both Apr 30 events gone; the May 1 event survives.
    assert n == 2
    survivors = events_db.recent(path)
    assert len(survivors) == 1


def test_given_no_events_for_day_when_delete_by_day_then_returns_zero(tmp_path):
    # arrange
    path = tmp_path / "events.db"
    events_db.init_db(path)

    # act
    n = events_db.delete_by_day(path, "2026-04-30")

    # assert
    assert n == 0


# iter-326 (missing-feature #5): people_summary aggregates events
# by person_name for the new /people page (Familiar Faces log).

def test_when_no_recognized_events_then_people_summary_returns_empty(tmp_path):
    # arrange
    path = tmp_path / "events.db"
    events_db.init_db(path)

    # act
    result = events_db.people_summary(path)

    # assert
    assert result == []


def test_given_events_with_persons_when_people_summary_then_one_row_per_distinct_name(
    tmp_path,
):
    # arrange — 3 alice events, 1 bob event, 2 unrecognized.
    path = tmp_path / "events.db"
    events_db.init_db(path)
    base = 1700000000.0
    events_db.insert_event(path, _make_event(ts=base, person_name="alice"))
    events_db.insert_event(path, _make_event(ts=base + 60, person_name="alice"))
    events_db.insert_event(path, _make_event(ts=base + 120, person_name="alice"))
    events_db.insert_event(path, _make_event(ts=base + 30, person_name="bob"))
    events_db.insert_event(path, _make_event(ts=base + 45, person_name=None))
    events_db.insert_event(path, _make_event(ts=base + 90, person_name=None))

    # act
    result = events_db.people_summary(path)

    # assert — 2 rows (NULL excluded), sorted by last_seen DESC.
    assert len(result) == 2
    # alice has the most recent event (base+120) → first.
    assert result[0]["name"] == "alice"
    assert result[0]["count"] == 3
    assert result[0]["last_seen_ts"] == base + 120
    assert result[0]["first_seen_ts"] == base
    assert result[1]["name"] == "bob"
    assert result[1]["count"] == 1


def test_when_people_summary_returns_then_last_clip_and_thumb_urls_included(
    tmp_path,
):
    # arrange — alice's most recent event has both clip + thumb URLs.
    path = tmp_path / "events.db"
    events_db.init_db(path)
    e1 = _make_event(ts=1700000000.0, person_name="alice")
    e1["clip_url"] = "/api/events/old_id/clip"
    e1["thumb_url"] = "/snapshots/thumb_old.jpg"
    events_db.insert_event(path, e1)
    e2 = _make_event(ts=1700000060.0, person_name="alice")
    e2["clip_url"] = "/api/events/new_id/clip"
    e2["thumb_url"] = "/snapshots/thumb_new.jpg"
    events_db.insert_event(path, e2)

    # act
    result = events_db.people_summary(path)

    # assert — the LATER event's URLs (newer event wins).
    assert len(result) == 1
    assert result[0]["last_clip_url"] == "/api/events/new_id/clip"
    assert result[0]["last_thumb_url"] == "/snapshots/thumb_new.jpg"


def test_when_50_people_seeded_then_people_summary_executes_one_sql_statement_not_51(
    tmp_path,
):
    # arrange (iter-327 R1: pin the single-pass window-function
    # query — the iter-326 1+N inner SELECT was 1 GROUP BY + N
    # second-queries; rewrite collapsed both into one CTE). Use
    # SQLite's `set_trace_callback` to count statements executed
    # by the query path. Counts the BEGIN/COMMIT bookkeeping plus
    # our actual SELECT, but the load-bearing assertion is "no N
    # inner queries" — should be one SELECT regardless of N.
    path = tmp_path / "events.db"
    events_db.init_db(path)
    for i in range(50):
        e = _make_event(ts=1700000000.0 + i, person_name=f"person_{i:02d}")
        e["clip_url"] = f"/api/events/e{i}/clip"
        e["thumb_url"] = f"/snapshots/thumb_{i}.jpg"
        events_db.insert_event(path, e)
    select_calls: list[str] = []

    # act — patch sqlite3.connect inside _connect to attach a
    # trace callback that records every executed statement.
    import sqlite3 as _sqlite
    real_connect = _sqlite.connect

    def traced_connect(*a, **kw):
        c = real_connect(*a, **kw)
        c.set_trace_callback(lambda s: select_calls.append(s))
        return c

    _sqlite.connect = traced_connect
    try:
        result = events_db.people_summary(path)
    finally:
        _sqlite.connect = real_connect

    # assert: exactly ONE SELECT against `events` (the WITH ranked
    # CTE form). Pre-iter-327 this would have been 51. The CTE
    # appears as a single statement to the trace callback.
    select_statements = [s for s in select_calls if "SELECT" in s.upper()]
    assert len(select_statements) == 1, (
        f"Expected 1 SELECT, got {len(select_statements)}: {select_statements!r}"
    )
    # Sanity check: result still has 50 distinct people.
    assert len(result) == 50
