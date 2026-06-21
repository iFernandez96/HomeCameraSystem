"""Real-data regression tests, gated on a fetched Jetson snapshot.

These validate against REAL production data pulled off the Jetson by
`deploy/fetch-jetson-data.sh` into `.jetson-snapshot/`. They SKIP when the
snapshot is absent, so development continues with the Jetson powered off
(memory: feedback-dev-offline-when-jetson-off) — and run automatically once
real data has been downloaded.

What they pin: the events.db wire shape the timelapse resolver depends on. If
`clip_url` ever drifts from `/api/events/<id>/clip`, `timelapse._resolve_clip_
path` would silently resolve nothing and reels would come back empty — these
catch that against the real schema rather than a synthetic fixture.

To populate: run `deploy/fetch-jetson-data.sh` whenever the Jetson is on.
"""
import re
import sqlite3
from pathlib import Path

import pytest

_SNAPSHOT = Path(__file__).resolve().parents[2] / ".jetson-snapshot"
_DB = _SNAPSHOT / "db" / "events.sqlite"

pytestmark = pytest.mark.skipif(
    not _DB.exists(),
    reason="no Jetson snapshot — run deploy/fetch-jetson-data.sh (Jetson must be on)",
)


def _ro():
    return sqlite3.connect("file:{0}?mode=ro".format(_DB), uri=True)


def test_given_a_real_snapshot_when_loaded_then_events_table_is_usable():
    # arrange / act
    con = _ro()
    cols = {row[1] for row in con.execute("PRAGMA table_info(events)")}
    (count,) = con.execute("SELECT count(*) FROM events").fetchone()
    # assert — the columns the timelapse builder + dedup analysis rely on.
    assert {"id", "ts", "clip_url"} <= cols, "events schema drifted: {0}".format(cols)
    assert count > 0, "snapshot events table is empty"


def test_given_real_clip_urls_when_inspected_then_they_match_the_resolver_pattern():
    # arrange — the same shape `timelapse._resolve_clip_path` parses to find
    # the on-disk recording. A drift here silently empties every reel.
    con = _ro()
    urls = [
        row[0]
        for row in con.execute(
            "SELECT clip_url FROM events WHERE clip_url IS NOT NULL LIMIT 100"
        )
    ]
    pattern = re.compile(r"^/api/events/[A-Za-z0-9_-]+/clip$")
    # act / assert
    assert urls, "no clip-bearing events in the snapshot"
    bad = [u for u in urls if not pattern.match(u)]
    assert not bad, "clip_url drifted from the resolver pattern: {0}".format(bad[:3])
