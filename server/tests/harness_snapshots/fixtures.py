import re
import sqlite3
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[3]
SNAPSHOT_DIR = REPO_ROOT / ".jetson-snapshot" / "proof_fixtures" / "snapshots"
EVENTS_DB = REPO_ROOT / ".jetson-snapshot" / "db" / "events.sqlite"
APP_LOG = REPO_ROOT / ".jetson-snapshot" / "logs" / "homecam-server-app.log"

THUMB_FETCH_RE = re.compile(r'GET /snapshots/(thumb_[0-9]+\.jpg) HTTP/')


def list_snapshot_files():
    return sorted(SNAPSHOT_DIR.glob("*.jpg"))


def db_thumb_urls():
    with sqlite3.connect(EVENTS_DB) as conn:
        rows = conn.execute(
            "SELECT thumb_url FROM events WHERE thumb_url IS NOT NULL AND thumb_url != ''"
        ).fetchall()
    return [row[0] for row in rows]


def logged_thumb_fetches():
    return THUMB_FETCH_RE.findall(APP_LOG.read_text())
