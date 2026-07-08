import json
import re
import shutil
import sqlite3
import threading
from pathlib import Path

import pytest
from pywebpush import WebPushException


SNAPSHOT = Path(__file__).resolve().parents[3] / ".jetson-snapshot"
EVENTS_DB = SNAPSHOT / "db" / "events.sqlite"
LOG_DIR = SNAPSHOT / "logs"
PUSH_SUBS = SNAPSHOT / "proof_fixtures" / "push" / "push_subs.json"

FANOUT_RE = re.compile(
    r"push fanout event=(?P<event_id>\S+) "
    r"sent=(?P<sent>\d+) "
    r"filtered=(?P<filtered>\d+) "
    r"failed=(?P<failed>\d+) "
    r"pruned=(?P<pruned>\d+)"
)


def _app_logs():
    if not LOG_DIR.exists():
        return []
    return sorted(LOG_DIR.glob("*app*.log"))


def _log_text():
    chunks = []
    for path in _app_logs():
        chunks.append(path.read_text(errors="replace"))
    return "\n".join(chunks)


pytestmark = [
    pytest.mark.skipif(
        not EVENTS_DB.exists(),
        reason="no Jetson events DB fixture - capture .jetson-snapshot/db/events.sqlite",
    ),
    pytest.mark.skipif(
        not _app_logs(),
        reason="no Jetson production app log - capture .jetson-snapshot/logs/homecam-server-app.log",
    ),
    pytest.mark.skipif(
        "push fanout event=" not in _log_text(),
        reason="snapshot predates fanout logging — refetch",
    ),
]


def _fanout_rows_from_logs():
    rows = []
    for match in FANOUT_RE.finditer(_log_text()):
        rows.append(
            {
                "event_id": match.group("event_id"),
                "sent": int(match.group("sent")),
                "filtered": int(match.group("filtered")),
                "failed": int(match.group("failed")),
                "pruned": int(match.group("pruned")),
            }
        )
    return rows


def _load_event(event_id):
    with sqlite3.connect(EVENTS_DB) as conn:
        conn.row_factory = sqlite3.Row
        row = conn.execute(
            "SELECT * FROM events WHERE id = ?",
            (event_id,),
        ).fetchone()
    if row is None:
        return None
    event = dict(row)
    raw_person_names = event.pop("person_names_json", None)
    if raw_person_names:
        event["person_names"] = json.loads(raw_person_names)
    return event


def _real_person_fanout_rows_from_logs():
    rows = []
    for logged in _fanout_rows_from_logs():
        event = _load_event(logged["event_id"])
        if event is None or event.get("label") != "person":
            continue
        row = dict(logged)
        row["event"] = event
        rows.append(row)
    return rows


class _Response:
    def __init__(self, status_code):
        self.status_code = status_code


@pytest.mark.asyncio
async def test_given_jetson_fanout_log_when_events_replayed_through_real_push_service_then_sent_and_filtered_match(
    tmp_path,
    monkeypatch,
    caplog,
):
    # given
    if not PUSH_SUBS.exists():
        pytest.skip(
            "no Jetson push subscriptions fixture - capture .jetson-snapshot/proof_fixtures/push/push_subs.json"
        )

    from app.services import push_service as push_service_module
    from app.services.push_service import PushService

    copied_subs = tmp_path / "push_subs.json"
    shutil.copy2(PUSH_SUBS, copied_subs)

    service = PushService(persist_path=copied_subs)
    service.private_pem = b"fake-pem"
    fixture_count = len(service.subs)

    logged_rows = [
        row
        for row in _real_person_fanout_rows_from_logs()
        if row["sent"] + row["filtered"] + row["failed"] + row["pruned"]
        == fixture_count
    ]
    if not logged_rows:
        pytest.skip(
            "no logged fanout lines match real person rows and current push_subs registry size - refetch"
        )

    outcomes = []
    lock = threading.Lock()

    async def inline_to_thread(func, /, *args, **kwargs):
        return func(*args, **kwargs)

    def stub_webpush(*args, **kwargs):
        del args, kwargs
        with lock:
            outcome = outcomes.pop(0) if outcomes else "failed"
        if outcome == "sent":
            return None
        if outcome == "pruned":
            raise WebPushException("gone", response=_Response(410))
        raise RuntimeError("harness simulated transient push failure")

    monkeypatch.setattr(push_service_module.asyncio, "to_thread", inline_to_thread)
    monkeypatch.setattr(push_service_module, "webpush", stub_webpush)

    # when / then
    for logged in logged_rows:
        service.subs = PushService(persist_path=copied_subs).subs
        event = logged["event"]
        payload = {
            "title": "{} detected".format(str(event.get("label", "")).title()),
            "body": "Front Door · {}%".format(int(float(event.get("score", 0)) * 100)),
            "tag": "detection",
            "url": "/events",
            "event_id": event["id"],
        }
        if event.get("thumb_url"):
            payload["image"] = event["thumb_url"]

        matching_count = logged["sent"] + logged["failed"] + logged["pruned"]
        outcomes[:] = (
            ["sent"] * logged["sent"]
            + ["failed"] * logged["failed"]
            + ["pruned"] * logged["pruned"]
        )

        with caplog.at_level("INFO", logger="app.services.push_service"):
            caplog.clear()
            sent = await service.send_matching(event, payload)

        replayed = [
            record.getMessage()
            for record in caplog.records
            if record.getMessage().startswith(
                "push fanout event={}".format(logged["event_id"])
            )
        ]
        assert replayed, "replay did not emit a fanout summary for logged event"
        replayed_match = FANOUT_RE.search(replayed[-1])
        assert replayed_match is not None

        assert sent == logged["sent"]
        assert int(replayed_match.group("sent")) == logged["sent"]
        assert int(replayed_match.group("filtered")) == logged["filtered"], (
            "FAIL: fanout filter parity drift for event_id={0}; "
            "logged sent+filtered={1}+{2}, replayed sent+filtered={3}+{4}, "
            "matching_count={5}"
        ).format(
            logged["event_id"],
            logged["sent"],
            logged["filtered"],
            replayed_match.group("sent"),
            replayed_match.group("filtered"),
            matching_count,
        )
        assert not outcomes
