"""SQLite-backed event store (iter-216, Feature #6 slice 1).

Foundation for the eventual event-search + calendar-heatmap UI per
the iter-200 audit roadmap. iter-216 ships the schema + helpers ONLY;
no integration with `event_bus.py` yet (slice 2 wires the writer
in alongside the existing in-memory deque, slice 3 swaps the deque
read path, slice 4 adds the search route).

Design choices, mirroring the iter-178 `users_db.py` pattern:
- Stdlib `sqlite3` only — no SQLAlchemy, no Alembic.
- Connection-per-call (FastAPI request lifetime is short; INSERT cost
  on the Nano is dominated by I/O, not connect overhead).
- WAL mode for concurrent reads/writes.
- Mode 0o600 on the file via `os.open(O_CREAT, 0o600)` BEFORE
  `sqlite3.connect` opens it (closes the iter-180 chmod-after-create
  race, same shape as `users_db.init_db` at iter-183).

Schema (one table, indexes for the search slice):

    CREATE TABLE events (
        id            TEXT PRIMARY KEY,
        ts            REAL NOT NULL,
        camera_id     TEXT NOT NULL,
        label         TEXT NOT NULL,
        score         REAL NOT NULL,
        person_name   TEXT,
        thumb_url     TEXT,
        clip_url      TEXT,
        boxes_json    TEXT NOT NULL DEFAULT '[]',
        v             INTEGER NOT NULL DEFAULT 1,
        type          TEXT NOT NULL DEFAULT 'detection'
    );
    CREATE INDEX events_ts_desc ON events(ts DESC);
    CREATE INDEX events_camera_ts ON events(camera_id, ts DESC);
    CREATE INDEX events_person_ts ON events(person_name, ts DESC);

The schema mirrors `event_bus.DetectionEventDict` field-for-field
(boxes serialized as JSON since SQLite doesn't have a list type;
slice 4 search route deserializes on read). PK on `id` makes the
slice-2 write path naturally idempotent — duplicate publishes
(network retry, worker restart races) become INSERT OR IGNORE
no-ops rather than ID collisions.

iter-216 helpers exposed:
- `init_db(path)` — schema + WAL + 0o600 mode.
- `insert_event(path, event)` — write a DetectionEventDict.
- `recent(path, limit, before_ts=None)` — newest-first, with
  cursor-style pagination via `before_ts`.
- `count_events(path)` — for observability + tests.
"""
from __future__ import annotations

import json
import logging
import os
import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

from ..log import RateLimitedLog
from .event_bus import DetectionEventDict


log = logging.getLogger(__name__)

# A malformed `boxes_json` (operator hand-edit, half-written row) is
# benign — `_row_to_event` degrades to empty boxes rather than 500 —
# but a SYSTEMATIC corruption (bad migration, disk bit-rot) would
# otherwise be invisible. Rate-limit the WARN so one bad row per
# listing doesn't flood, but a sustained problem still surfaces every
# 60s. Matches the docs/logging_plan.md "once-per-N" intent.
_boxes_parse_gate = RateLimitedLog(60.0)


_SCHEMA = """
CREATE TABLE IF NOT EXISTS events (
    id                 TEXT PRIMARY KEY,
    ts                 REAL NOT NULL,
    camera_id          TEXT NOT NULL,
    label              TEXT NOT NULL,
    score              REAL NOT NULL,
    person_name        TEXT,
    thumb_url          TEXT,
    clip_url           TEXT,
    boxes_json         TEXT NOT NULL DEFAULT '[]',
    v                  INTEGER NOT NULL DEFAULT 1,
    type               TEXT NOT NULL DEFAULT 'detection',
    seen               INTEGER NOT NULL DEFAULT 0,
    person_names_json  TEXT
);
CREATE INDEX IF NOT EXISTS events_ts_desc ON events(ts DESC);
CREATE INDEX IF NOT EXISTS events_camera_ts ON events(camera_id, ts DESC);
CREATE INDEX IF NOT EXISTS events_person_ts ON events(person_name, ts DESC);
-- iter-333b (perf C2): label-ts composite index covers iter-329's
-- per-class filter on /api/events/search?label= and the same
-- filter forwarded by count_by_day. Without this index a non-
-- dominant label like ?label=dog forced a ts-ordered table scan
-- until N matching rows were found (O(N) on a 95% person DB).
-- Idempotent CREATE INDEX IF NOT EXISTS — safe on re-init.
CREATE INDEX IF NOT EXISTS events_label_ts ON events(label, ts DESC);
"""


# iter-357 (multi-person face-recog): legacy installs pre-date the
# `person_names_json` column. SQLite's `ALTER TABLE ADD COLUMN` is
# non-conditional, so we PRAGMA-check before issuing it (same shape
# as `_ensure_seen_column` at iter-248). The new column is nullable
# (no DEFAULT) — events written by a pre-iter-357 worker / older
# row store NULL there, and `_row_to_event` reads NULL back as the
# `person_names: None` legacy semantic. No backfill needed: the
# existing `person_name` column still serves the iter-22 single-
# match case for old rows. The indexed `events_person_ts` covers
# search by FIRST matched name without an extra index on
# person_names_json — secondary names in a multi-person event are
# searchable only via post-filter today (acceptable bound: in a
# 2-user household a multi-person event is the rare case).
def _ensure_person_names_column(conn: sqlite3.Connection) -> None:
    cols = {row[1] for row in conn.execute("PRAGMA table_info(events)")}
    if "person_names_json" not in cols:
        conn.execute(
            "ALTER TABLE events ADD COLUMN person_names_json TEXT"
        )


# iter-248: schema migration for installs that pre-date the `seen`
# column. SQLite's `ALTER TABLE ... ADD COLUMN` is idempotent only
# via a PRAGMA-driven check; do that check explicitly so reads on
# fresh DBs work AND legacy DBs gain the column on first init_db.
#
# The `events_unseen_ts` partial index also lives here (not in
# `_SCHEMA`) — on a legacy DB the index references a column that
# `_SCHEMA`'s `CREATE TABLE IF NOT EXISTS` doesn't add (since the
# table already exists), so creating the index inside the schema
# script fails with "no such column: seen". Creating it AFTER the
# `ALTER TABLE` is run — fresh OR legacy DB — keeps both paths
# correct.
def _ensure_seen_column(conn: sqlite3.Connection) -> None:
    cols = {row[1] for row in conn.execute("PRAGMA table_info(events)")}
    if "seen" not in cols:
        conn.execute(
            "ALTER TABLE events ADD COLUMN seen INTEGER NOT NULL DEFAULT 0"
        )
    # Idempotent — runs on every init_db, costs ~µs when the index
    # already exists. The partial-index `WHERE seen = 0` keeps the
    # unread-count query effectively constant-time regardless of
    # total event volume.
    conn.execute(
        "CREATE INDEX IF NOT EXISTS events_unseen_ts "
        "ON events(ts DESC) WHERE seen = 0"
    )


def init_db(path: Path) -> None:
    """Create the events table + indexes if missing. Idempotent.
    Enables WAL mode so the future fanout writer doesn't block
    `recent` reads. Mode 0o600 because event records can contain
    person_name + thumb URLs the operator may not want world-
    readable on a multi-tenant box.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    if not path.exists():
        # Atomic mode-0o600 pre-create — same pattern as iter-183
        # users_db.init_db. Closes the chmod-after-create race.
        fd = os.open(path, os.O_CREAT | os.O_RDWR, 0o600)
        os.close(fd)
    with sqlite3.connect(path) as conn:
        conn.execute("PRAGMA journal_mode=WAL")
        conn.executescript(_SCHEMA)
        _ensure_seen_column(conn)
        _ensure_person_names_column(conn)
        conn.commit()
    # Belt-and-braces chmod for legacy installs where the file
    # already exists with looser perms. No-op on read-only mounts.
    try:
        path.chmod(0o600)
    except OSError as exc:
        # PRIVACY: events.db can hold person_name + thumb URLs. If we
        # can't tighten the mode the file may stay world-readable on a
        # multi-tenant box — surface it (WARN, not silent pass).
        log.warning(
            "events_db: could not chmod 0o600 on %s — DB may remain "
            "world-readable: %s",
            path,
            exc,
        )


@contextmanager
def _connect(path: Path) -> Iterator[sqlite3.Connection]:
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
    finally:
        conn.close()


@contextmanager
def _db_op(op: str, path: Path, **key_args: Any) -> Iterator[None]:
    """Wrap a DB helper body so any sqlite error (locked DB, disk
    full, corrupt page, missing window-function support on an old
    SQLite) is logged with the OPERATION + db PATH + the key filter
    args at ERROR (with ``exc_info``) BEFORE re-raising.

    Without this the route layer just 500s on a bare ``sqlite3.Error``
    and the operator never learns WHICH query died on WHICH db. The
    ``people_summary`` window-function query is the worst landmine —
    SQLite < 3.25 raises ``OperationalError: near "OVER"`` and the
    failure is otherwise silent.

    Re-raises the ORIGINAL exception unchanged so the route still
    surfaces its 500 and any existing ``except sqlite3.Error`` handler
    keeps working — this only adds the diagnostic line.

    ``key_args`` are short identifying scalars (camera_id, before_ts,
    a count of ids) — NEVER PII bodies. Caller chooses what to pass.
    """
    try:
        yield
    except sqlite3.Error as exc:
        # `%r` on a dict keeps the line greppable + bounded; key_args
        # are deliberately small scalars chosen by the caller.
        log.error(
            "events_db.%s failed on %s: %s (%s) [%r]",
            op,
            path,
            exc,
            type(exc).__name__,
            key_args,
            exc_info=True,
        )
        raise


def insert_event(path: Path, event: DetectionEventDict) -> bool:
    """Persist a single event. Returns True if a row was inserted,
    False if the id already existed (INSERT OR IGNORE — duplicate
    publishes are idempotent no-ops rather than IntegrityError
    crashes). Slice 2 will call this from the EventBus.publish path
    alongside the existing deque append.

    `boxes` is JSON-encoded inline; SQLite has no native list type
    and the slice-4 search route doesn't query inside boxes anyway
    (the indexable filters are camera_id, person_name, ts).
    """
    with _connect(path) as conn:
        # iter-357: `person_names_json` carries the multi-person
        # match list (if any) as JSON. Stored as NULL when the
        # event has no list (legacy single-person semantic) so
        # `_row_to_event` reads it back as `person_names: None`.
        # JSON-encoded only when non-empty so we don't store the
        # noisy `"[]"` for every single-person event.
        person_names = event.get("person_names")
        if person_names:
            person_names_json: str | None = json.dumps(person_names)
        else:
            person_names_json = None
        cur = conn.execute(
            "INSERT OR IGNORE INTO events "
            "(id, ts, camera_id, label, score, person_name, "
            "thumb_url, clip_url, boxes_json, v, type, "
            "person_names_json) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                event["id"],
                event["ts"],
                event["camera_id"],
                event["label"],
                event["score"],
                event.get("person_name"),
                event.get("thumb_url"),
                event.get("clip_url"),
                json.dumps(event.get("boxes", [])),
                event.get("v", 1),
                event.get("type", "detection"),
                person_names_json,
            ),
        )
        conn.commit()
        return cur.rowcount > 0


def _row_to_event(row: sqlite3.Row) -> DetectionEventDict:
    boxes_raw = row["boxes_json"]
    try:
        boxes = json.loads(boxes_raw) if boxes_raw else []
    except (TypeError, ValueError) as exc:
        # Operator hand-edited the DB with malformed JSON. Don't
        # crash the listing — empty boxes is a cleaner degradation
        # than a 500 on /api/events. But a SYSTEMATIC corruption
        # (bad migration, bit-rot) should still surface: WARN at
        # most once per 60s so one bad row can't flood a listing.
        boxes = []
        if _boxes_parse_gate.should_log():
            log.warning(
                "events_db: unparseable boxes_json for event %s "
                "(rendering zero boxes): %s",
                row["id"],
                exc,
            )
    # iter-357: row may not carry `person_names_json` at all on
    # SQLite Row objects from a CONNECTION whose read predates the
    # column migration (rare — `_ensure_person_names_column` runs
    # on every init_db) OR rows from a row factory that doesn't
    # know the new column. `try/except KeyError` covers both legacy
    # paths cleanly. NULL column or empty/malformed JSON → None
    # (legacy single-person semantic).
    try:
        pn_raw = row["person_names_json"]
    except (KeyError, IndexError):
        pn_raw = None
    person_names: list[str] | None
    if pn_raw:
        try:
            decoded = json.loads(pn_raw)
            if (
                isinstance(decoded, list)
                and decoded
                and all(isinstance(n, str) and n for n in decoded)
            ):
                person_names = decoded
            else:
                # Well-formed JSON but wrong shape — multi-person
                # match list degrades to the single `person_name`.
                # DEBUG (not WARN): benign, high-frequency-possible.
                person_names = None
                log.debug(
                    "events_db: person_names_json wrong shape for "
                    "event %s; using single person_name",
                    row["id"],
                )
        except (TypeError, ValueError) as exc:
            # Unparseable person_names_json → degrade to single
            # person_name. DEBUG only: an operator hand-edit and the
            # event still renders via `person_name`.
            person_names = None
            log.debug(
                "events_db: unparseable person_names_json for event "
                "%s (using single person_name): %s",
                row["id"],
                exc,
            )
    else:
        person_names = None
    return {
        "v": int(row["v"]),
        "type": row["type"],
        "id": row["id"],
        "ts": float(row["ts"]),
        "camera_id": row["camera_id"],
        "label": row["label"],
        "score": float(row["score"]),
        "boxes": boxes,
        "thumb_url": row["thumb_url"],
        "person_name": row["person_name"],
        "person_names": person_names,
        "clip_url": row["clip_url"],
    }


def recent(
    path: Path,
    limit: int = 100,
    before_ts: float | None = None,
) -> list[DetectionEventDict]:
    """Return the most recent events, newest-first.

    `before_ts` is the cursor for pagination — pass the ts of the
    LAST event returned in the previous page to fetch the next
    older slice. Strict `<` (not `<=`) so a tied-ts pair doesn't
    appear on both pages — slice 4 search route will use this same
    semantic.

    The (ts DESC) index makes this O(log N + K) regardless of total
    event count.
    """
    with _connect(path) as conn:
        if before_ts is None:
            rows = conn.execute(
                "SELECT * FROM events ORDER BY ts DESC LIMIT ?",
                (limit,),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM events WHERE ts < ? ORDER BY ts DESC LIMIT ?",
                (before_ts, limit),
            ).fetchall()
        return [_row_to_event(r) for r in rows]


def search(
    path: Path,
    *,
    camera_id: str | None = None,
    person_name: str | None = None,
    since_ts: float | None = None,
    until_ts: float | None = None,
    label: str | None = None,
    limit: int = 100,
    before_ts: float | None = None,
    face_unrecognized: bool | None = None,
) -> list[DetectionEventDict]:
    """iter-219 (Feature #6 slice 4): cursor-paginated event search.

    All filters are AND-combined. Each filter is optional; passing
    only `limit` + `before_ts` reduces to the same shape as
    `recent()`. The composed query uses the existing iter-216
    indexes (events_ts_desc, events_camera_ts, events_person_ts) so
    common filter shapes are O(log N + K).

    Semantics (matches the client's natural mental model):
    - `since_ts` = inclusive lower bound (events at exactly this ts
      are included). "Show me detections from 9am" → `since_ts =
      <9am as unix epoch>`.
    - `until_ts` = exclusive upper bound (matches `before_ts`'s
      strict-`<` cursor semantic). "Show me detections before 5pm"
      → `until_ts = <5pm>`. Combined with `since_ts` for a window.
    - `before_ts` = the cursor — distinct from `until_ts` because
      pagination needs to advance through pages without losing the
      original time-of-day window. The client passes the LAST
      event's `ts` from page N to fetch page N+1.
    - `label`, `camera_id`, `person_name` = exact-match equality.
      Empty string = no rows match (use None to disable the filter).

    Returns events newest-first, capped at `limit`. Empty list when
    no rows match. Caller decides next-cursor logic from the last
    item's `ts`.
    """
    clauses: list[str] = []
    args: list = []
    if camera_id is not None:
        clauses.append("camera_id = ?")
        args.append(camera_id)
    if person_name is not None:
        clauses.append("person_name = ?")
        args.append(person_name)
    if label is not None:
        clauses.append("label = ?")
        args.append(label)
    if since_ts is not None:
        clauses.append("ts >= ?")
        args.append(since_ts)
    if until_ts is not None:
        clauses.append("ts < ?")
        args.append(until_ts)
    if before_ts is not None:
        clauses.append("ts < ?")
        args.append(before_ts)
    # iter-227 (Feature #6 polish): closes the iter-221 `__unknown__`
    # chip server-side gap. `face_unrecognized=True` matches events
    # with NULL person_name (no face match); `False` matches events
    # WITH a person_name (any). `None` (default) doesn't filter on
    # this dimension. Distinct from `person_name=...` which matches
    # an EXACT name — these two filters can't combine usefully (the
    # caller picks one or the other), but we don't enforce that
    # here; the iter-221 client UI is the gate.
    if face_unrecognized is True:
        clauses.append("person_name IS NULL")
    elif face_unrecognized is False:
        clauses.append("person_name IS NOT NULL")
    where = (" WHERE " + " AND ".join(clauses)) if clauses else ""
    sql = (
        "SELECT * FROM events" + where + " ORDER BY ts DESC LIMIT ?"
    )
    args.append(limit)
    with _db_op(
        "search",
        path,
        camera_id=camera_id,
        person_name=person_name,
        label=label,
        since_ts=since_ts,
        until_ts=until_ts,
        before_ts=before_ts,
        face_unrecognized=face_unrecognized,
        limit=limit,
    ), _connect(path) as conn:
        rows = conn.execute(sql, args).fetchall()
        return [_row_to_event(r) for r in rows]


def count_by_day(
    path: Path,
    *,
    camera_id: str | None = None,
    person_name: str | None = None,
    label: str | None = None,
    since_ts: float | None = None,
    until_ts: float | None = None,
    face_unrecognized: bool | None = None,
) -> dict[str, int]:
    """iter-222 (Feature #6 slice 7b-server): aggregate event counts
    per day. Date bucketing uses SQLite's `date(ts, 'unixepoch',
    'localtime')` so days align with the SERVER LOCAL TIME (same
    convention as the iter-209 schedule_window filter — keeps
    "what day was this event on" consistent across the stack).

    Same optional filter set as `search()`. Returns a dict mapping
    `YYYY-MM-DD` → count (sorted by date ascending in iteration
    order so the client can render straight into a heatmap grid
    without re-sorting). Empty dict when no rows match.

    The (ts DESC) iter-216 index covers the GROUP BY when no other
    filter is set; with camera_id or person_name the (camera_id, ts)
    / (person_name, ts) indexes provide the same coverage. Cost is
    O(N) over matching rows but in practice ~1 ms for a year of
    events.
    """
    clauses: list[str] = []
    args: list = []
    if camera_id is not None:
        clauses.append("camera_id = ?")
        args.append(camera_id)
    if person_name is not None:
        clauses.append("person_name = ?")
        args.append(person_name)
    if label is not None:
        clauses.append("label = ?")
        args.append(label)
    if since_ts is not None:
        clauses.append("ts >= ?")
        args.append(since_ts)
    if until_ts is not None:
        clauses.append("ts < ?")
        args.append(until_ts)
    # iter-227: same `face_unrecognized` flag as `search` — see
    # comment block on `search` for semantics.
    if face_unrecognized is True:
        clauses.append("person_name IS NULL")
    elif face_unrecognized is False:
        clauses.append("person_name IS NOT NULL")
    where = (" WHERE " + " AND ".join(clauses)) if clauses else ""
    sql = (
        "SELECT date(ts, 'unixepoch', 'localtime') AS day, COUNT(*) AS n "
        "FROM events" + where + " GROUP BY day ORDER BY day ASC"
    )
    with _db_op(
        "count_by_day",
        path,
        camera_id=camera_id,
        person_name=person_name,
        label=label,
        since_ts=since_ts,
        until_ts=until_ts,
        face_unrecognized=face_unrecognized,
    ), _connect(path) as conn:
        rows = conn.execute(sql, args).fetchall()
        # `dict()` preserves insertion order in 3.7+, so the ASC
        # SQL ordering carries through to the response. Useful for
        # the iter-223 client heatmap which renders left-to-right.
        return {r["day"]: int(r["n"]) for r in rows}


def distinct_persons(path: Path, *, limit: int = 200) -> list[str]:
    """iter-303 (notifications fuzzy-search): distinct non-null
    person_name values, sorted alphabetically. Powers the per-user
    notification filter UI's "People" toggle list — users pick from
    actual observed names instead of free-typing.

    `limit` caps the response so a worst-case face-recognition
    misconfiguration with thousands of mis-matched names can't blow
    up the client. 200 is generous for a household deployment; bump
    if a multi-tenant variant ever ships.
    """
    with _connect(path) as conn:
        rows = conn.execute(
            "SELECT DISTINCT person_name AS n FROM events "
            "WHERE person_name IS NOT NULL "
            "ORDER BY person_name COLLATE NOCASE ASC LIMIT ?",
            (limit,),
        ).fetchall()
        return [r["n"] for r in rows]


def distinct_cameras(path: Path, *, limit: int = 32) -> list[str]:
    """iter-303 (notifications fuzzy-search): distinct camera_id
    values from observed events, sorted alphabetically. Single-cam
    deploys today return one entry ("cam1"); multi-cam (MC Phase 1+)
    will populate this with each configured source.

    `limit` is a defensive cap; 32 cameras per Jetson is well past
    the documented hardware envelope.
    """
    with _connect(path) as conn:
        rows = conn.execute(
            "SELECT DISTINCT camera_id AS c FROM events "
            "WHERE camera_id IS NOT NULL "
            "ORDER BY camera_id COLLATE NOCASE ASC LIMIT ?",
            (limit,),
        ).fetchall()
        return [r["c"] for r in rows]


def get_by_ids(path: Path, ids: list[str]) -> list[dict]:
    """iter-330: batch event lookup by id list. Returns the same
    `_row_to_event` shape as `recent()` / `search()`. Used by the
    Event Export ZIP route — the client posts a list of selected
    event IDs and the server bundles their clips + thumbs.

    `ids` is bound via SQLite's IN ?,?,?,... parameterization so
    SQL injection is impossible regardless of the id format. Caller
    is responsible for capping the list size; this function does not
    enforce a max (the route layer enforces 50 per the iter-330
    contract). Order of the returned list matches `ids` (so the
    operator's selection order in the UI is preserved in the manifest).
    Missing IDs are silently dropped — caller can compare lengths
    if "all-or-nothing" semantics are needed.
    """
    if not ids:
        return []
    placeholders = ",".join("?" for _ in ids)
    sql = "SELECT * FROM events WHERE id IN ({})".format(placeholders)
    with _db_op("get_by_ids", path, n_ids=len(ids)), _connect(path) as conn:
        rows = conn.execute(sql, tuple(ids)).fetchall()
    by_id = {r["id"]: _row_to_event(r) for r in rows}
    return [by_id[i] for i in ids if i in by_id]


def people_total(path: Path) -> int:
    """iter-328 (R2): count of distinct recognized person_names in
    events. Pairs with `people_summary(limit=N)` so the client can
    render "Showing N of M" when the operator has more enrolled
    faces than the route returns. Cheap (~ms) — index-backed
    COUNT(DISTINCT) on the (person_name, ts) composite at scale."""
    with _connect(path) as conn:
        row = conn.execute(
            "SELECT COUNT(DISTINCT person_name) AS n "
            "FROM events WHERE person_name IS NOT NULL"
        ).fetchone()
        return int(row["n"]) if row else 0


def people_summary(path: Path, *, limit: int = 100) -> list[dict]:
    """iter-326 (missing-feature #5, "Familiar Faces" log): per-
    person aggregation for the new /people page.

    Returns one row per distinct `person_name` with:
      - name: the person_name
      - count: total events with that name
      - last_seen_ts: most recent event ts
      - first_seen_ts: earliest event ts
      - last_clip_url: clip_url of the most recent event (for the
        page's "play their last visit" affordance), nullable
      - last_thumb_url: thumb_url of the most recent event,
        nullable
    Sorted by last_seen_ts DESC (recent visitors first). NULL
    person_name (unmatched faces) is excluded — those have their
    own iter-227 `face_unrecognized` filter.

    `limit` caps the response — a household might have 5-15
    enrolled faces; the cap is defensive (~100).

    iter-327 (perf C1 + sec B2): single-pass window-function query
    eliminates the iter-326 1+N inner SELECT (was 1 GROUP BY + N
    `WHERE person_name=? ORDER BY ts DESC LIMIT 1` for last clip /
    thumb URLs). At N=100 enrolled people, was ~100ms serialized
    SQLite work per request; now one statement against the
    `events_person_ts` composite index. Window functions require
    SQLite 3.25+ (2018-09); the Docker container's python:3.11-slim-
    bookworm ships SQLite 3.40+ so the syntax is safe.

    The CTE form pre-filters NULL person_name + ranks each person's
    rows by ts DESC; the outer SELECT picks rn=1 (the latest event)
    per person and aggregates count + first_seen with window
    functions over the same partition. ORDER BY last_seen_ts DESC
    LIMIT ? matches the iter-326 contract.
    """
    sql = (
        "WITH ranked AS ("
        "  SELECT"
        "    person_name AS name,"
        "    ts,"
        "    clip_url,"
        "    thumb_url,"
        "    ROW_NUMBER() OVER (PARTITION BY person_name ORDER BY ts DESC) AS rn,"
        "    COUNT(*)     OVER (PARTITION BY person_name) AS count,"
        "    MAX(ts)      OVER (PARTITION BY person_name) AS last_seen_ts,"
        "    MIN(ts)      OVER (PARTITION BY person_name) AS first_seen_ts"
        "  FROM events"
        "  WHERE person_name IS NOT NULL"
        ")"
        " SELECT name, count, last_seen_ts, first_seen_ts,"
        "        clip_url AS last_clip_url,"
        "        thumb_url AS last_thumb_url"
        " FROM ranked"
        " WHERE rn = 1"
        " ORDER BY last_seen_ts DESC"
        " LIMIT ?"
    )
    # The window-function syntax (`OVER (...)`) requires SQLite >= 3.25
    # — on an unexpectedly-old runtime this is an `OperationalError`
    # the `_db_op` wrap names explicitly instead of a silent 500.
    with _db_op("people_summary", path, limit=limit), _connect(path) as conn:
        rows = conn.execute(sql, (limit,)).fetchall()
        return [
            {
                "name": r["name"],
                "count": int(r["count"]),
                "last_seen_ts": float(r["last_seen_ts"]),
                "first_seen_ts": float(r["first_seen_ts"]),
                "last_clip_url": r["last_clip_url"],
                "last_thumb_url": r["last_thumb_url"],
            }
            for r in rows
        ]


def count_events(path: Path) -> int:
    """Total events stored. Cheap (COUNT(*) on a small table is
    sub-ms; on a year-of-events table ~36k rows is still trivial).
    Slice-3+ may expose this on `/api/status` or `/metrics` for the
    operator dashboard."""
    with _connect(path) as conn:
        row = conn.execute("SELECT COUNT(*) AS n FROM events").fetchone()
        return int(row["n"]) if row else 0


def unread_count(path: Path) -> int:
    """Count events with seen=0. Backed by the iter-248 partial
    index `events_unseen_ts` so the query is sub-ms even when total
    event volume is large. Used by the home-screen badge wiring +
    the future ongoing-notification feature.
    """
    with _connect(path) as conn:
        row = conn.execute(
            "SELECT COUNT(*) AS n FROM events WHERE seen = 0"
        ).fetchone()
        return int(row["n"]) if row else 0


def mark_seen(path: Path, event_id: str) -> bool:
    """Mark a single event as seen. Returns True on a real flip,
    False when the row is missing or already seen. Caller uses the
    return value to decide whether to refresh the badge.
    """
    with _db_op("mark_seen", path, event_id=event_id), _connect(path) as conn:
        cur = conn.execute(
            "UPDATE events SET seen = 1 WHERE id = ? AND seen = 0",
            (event_id,),
        )
        conn.commit()
        return cur.rowcount > 0


def mark_all_seen(path: Path) -> int:
    """Bulk-mark every unseen event as seen. Returns the number
    flipped. Powers the "Mark all as seen" button on the Events
    page + the auto-clear-on-tab-visit flow.
    """
    with _connect(path) as conn:
        cur = conn.execute("UPDATE events SET seen = 1 WHERE seen = 0")
        conn.commit()
        return cur.rowcount


def delete(path: Path, event_id: str) -> bool:
    """iter-299 (user "be able to delete events manually with a
    confirmation"): delete one event by id. Returns True if a row
    was actually removed, False if the id didn't exist (caller can
    surface a 404 if needed).
    """
    with _db_op("delete", path, event_id=event_id), _connect(path) as conn:
        cur = conn.execute("DELETE FROM events WHERE id = ?", (event_id,))
        conn.commit()
        return cur.rowcount > 0


def delete_by_day(path: Path, day: str) -> int:
    """iter-299 (user "delete all events for a day/week/year"):
    bulk-delete every event whose local-time date matches `day`
    (YYYY-MM-DD). Returns the number of rows removed. Bucketing
    matches `count_by_day` (`date(ts, 'unixepoch', 'localtime')`)
    so the UI's "delete all N events for May 2" matches the count
    the heatmap showed.

    Caller is responsible for validating `day` against the
    `^[0-9]{4}-[01][0-9]-[0-3][0-9]$` regex; this function
    parameter-binds, so SQL injection isn't a concern, but a
    malformed date would silently return 0.
    """
    with _connect(path) as conn:
        cur = conn.execute(
            "DELETE FROM events WHERE "
            "date(ts, 'unixepoch', 'localtime') = ?",
            (day,),
        )
        conn.commit()
        return cur.rowcount


def reset(path: Path) -> None:
    """Truncate the events table. NOT called by production code;
    used by tests to give each one a clean baseline. The fixture
    style mirrors the iter-? `event_bus.reset()` and `push_service`
    test helpers."""
    with _connect(path) as conn:
        conn.execute("DELETE FROM events")
        conn.commit()


# A bit of typing-erasure noise: the inserted event accepts any
# dict-like with the right keys (TypedDicts are erased at runtime),
# so callers that haven't fully typed their payload yet won't trip a
# type checker. mypy/pyright still validate at the call site.
_ = Any  # silence "imported but unused" if Any goes unused later
