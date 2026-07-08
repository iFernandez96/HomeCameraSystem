import json
import shutil
import time
from pathlib import Path

import pytest

from server.tests.harness_push_gateway.fixture_loader import load_push_subscriptions


PUSH_SUBS = (
    Path(__file__).resolve().parents[3]
    / ".jetson-snapshot"
    / "proof_fixtures"
    / "push"
    / "push_subs.json"
)

pytestmark = pytest.mark.skipif(
    not PUSH_SUBS.exists(),
    reason="no Jetson push subscriptions fixture - capture .jetson-snapshot/proof_fixtures/push/push_subs.json",
)


@pytest.mark.asyncio
async def test_given_real_copied_subs_with_schedule_windows_when_send_matching_runs_then_only_in_window_subs_reach_fanout(
    tmp_path,
    monkeypatch,
):
    # given
    from app.services.push_service import PushService

    copied_subs = tmp_path / "push_subs.json"
    shutil.copy2(PUSH_SUBS, copied_subs)
    fixture_subs = load_push_subscriptions(copied_subs)
    assert len(fixture_subs) >= 2

    event_ts = time.mktime((2024, 1, 2, 12, 0, 0, 0, 0, -1))
    raw_subs = json.loads(copied_subs.read_text())
    for index, sub in enumerate(raw_subs):
        sub["filters"] = {
            "cameras": None,
            "person_names": None,
            "schedule_window": (
                {"start": "09:00", "end": "17:00"}
                if index == 0
                else {"start": "22:00", "end": "23:00"}
            ),
        }
    copied_subs.write_text(json.dumps(raw_subs))

    service = PushService(persist_path=copied_subs)
    captured_fanout_subs = []

    async def spy_fanout_to(self, subs, payload):
        captured_fanout_subs.extend(subs)
        return len(subs)

    monkeypatch.setattr(PushService, "_fanout_to", spy_fanout_to)

    event = {
        "id": "harness_p8_event_001",
        "camera_id": "front_door",
        "person_name": None,
        "ts": event_ts,
    }
    payload = {"title": "harness p8"}

    # when
    sent = await service.send_matching(event, payload)

    # then
    captured_indexes = [
        next(index for index, candidate in enumerate(service.subs) if candidate is sub)
        for sub in captured_fanout_subs
    ]
    assert sent == 1
    assert captured_indexes == [0], (
        "FAIL: schedule_window filters did not gate subscriptions before fanout; "
        "expected only in-window subscription indexes [0], got {0}"
    ).format(captured_indexes)
