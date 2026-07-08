import json
import os
import subprocess
import sys

import pytest

from server.tests.harness_eventbus.fixtures import (
    EVENTS_DB,
    EVENTS_JSON,
    REPO_ROOT,
    load_json_rows,
    normalize,
)


pytestmark = [
    pytest.mark.skipif(
        not EVENTS_JSON.exists(),
        reason="no continuous capture events fixture - capture .jetson-snapshot/continuous_capture_fixtures/events_tonight.json",
    ),
    pytest.mark.skipif(
        not EVENTS_DB.exists(),
        reason="no Jetson events DB fixture - capture .jetson-snapshot/db/events.sqlite",
    ),
]


def test_given_event_bus_imported_first_when_publishing_then_no_circular_importerror(tmp_path):
    event = normalize(load_json_rows()[0])
    db_path = tmp_path / "events.db"
    env = os.environ.copy()
    env["PYTHONPATH"] = str(REPO_ROOT / "server")
    env["HOMECAM_F6_DB"] = str(db_path)
    env["HOMECAM_F6_EVENT"] = json.dumps(event)

    code = """
import asyncio
import json
import os
from pathlib import Path

from app.services.event_bus import event_bus
from app.config import settings
from app.services import events_db

db_path = Path(os.environ["HOMECAM_F6_DB"])
event = json.loads(os.environ["HOMECAM_F6_EVENT"])
settings.events_db_path = db_path
events_db.init_db(db_path)
asyncio.run(event_bus.publish(event))
assert events_db.count_events(db_path) == 1
"""
    result = subprocess.run(
        [sys.executable, "-c", code],
        cwd=REPO_ROOT,
        env=env,
        text=True,
        capture_output=True,
        timeout=10,
        check=False,
    )

    assert result.returncode == 0, (
        "subprocess failed\nstdout={}\nstderr={}".format(
            result.stdout,
            result.stderr,
        )
    )
