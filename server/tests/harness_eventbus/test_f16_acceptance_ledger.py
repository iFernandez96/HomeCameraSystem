import re
import sqlite3
from pathlib import Path

import pytest

from server.tests.harness_eventbus.fixtures import EVENTS_DB, EVENTS_JSON, REPO_ROOT


APP_LOG = REPO_ROOT / ".jetson-snapshot" / "logs" / "homecam-server-app.log"
DETECT_LOG = REPO_ROOT / ".jetson-snapshot" / "logs" / "homecam-detect.log"
ACCEPTED_EVENT_RE = re.compile(r'"POST /api/_internal/event HTTP/1\.1" 200 OK')
EVENT_POST_FAILED_RE = re.compile(r"event POST failed")


pytestmark = [
    pytest.mark.skipif(
        not EVENTS_JSON.exists(),
        reason="no continuous capture events fixture - capture .jetson-snapshot/continuous_capture_fixtures/events_tonight.json",
    ),
    pytest.mark.skipif(
        not EVENTS_DB.exists(),
        reason="no Jetson events DB fixture - capture .jetson-snapshot/db/events.sqlite",
    ),
    pytest.mark.skipif(
        not APP_LOG.exists(),
        reason="no fresh docker app log fixture - capture .jetson-snapshot/logs/homecam-server-app.log",
    ),
    pytest.mark.skipif(
        not DETECT_LOG.exists(),
        reason="no detection journal fixture - capture .jetson-snapshot/logs/homecam-detect.log",
    ),
]


def _count_matches(path: Path, pattern: re.Pattern[str]) -> int:
    return len(pattern.findall(path.read_text(errors="replace")))


def _persisted_count() -> int:
    with sqlite3.connect(EVENTS_DB) as conn:
        return int(conn.execute("SELECT COUNT(*) FROM events").fetchone()[0])


def test_given_fresh_app_and_detection_logs_when_acceptance_ledger_is_parsed_then_counts_are_self_consistent():
    accepted = _count_matches(APP_LOG, ACCEPTED_EVENT_RE)
    worker_lost = _count_matches(DETECT_LOG, EVENT_POST_FAILED_RE)
    persisted = _persisted_count()
    ledger = {
        "accepted_200s": accepted,
        "detection_post_failed": worker_lost,
        "persisted": persisted,
        "accepted_minus_persisted": accepted - persisted,
    }

    assert accepted > 0
    assert worker_lost > 0
    assert persisted > 0
    assert accepted <= persisted, ledger
    assert ledger["accepted_minus_persisted"] == accepted - persisted
