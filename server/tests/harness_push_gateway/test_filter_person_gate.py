import json
import shutil
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
async def test_given_real_copied_subs_with_person_filters_when_send_matching_runs_then_only_matching_subs_reach_fanout(
    tmp_path,
    monkeypatch,
):
    # given
    from app.services.push_service import PushService

    copied_subs = tmp_path / "push_subs.json"
    shutil.copy2(PUSH_SUBS, copied_subs)
    fixture_subs = load_push_subscriptions(copied_subs)
    assert len(fixture_subs) >= 3

    event_person_name = "alice"
    non_matching_person_name = "bob"
    raw_subs = json.loads(copied_subs.read_text())
    for index, sub in enumerate(raw_subs):
        sub["filters"] = {
            "cameras": None,
            "person_names": (
                [event_person_name]
                if index == 0
                else [non_matching_person_name]
                if index == 1
                else None
            ),
            "schedule_window": None,
        }
    copied_subs.write_text(json.dumps(raw_subs))

    service = PushService(persist_path=copied_subs)
    captured_fanout_subs = []

    async def spy_fanout_to(self, subs, payload):
        captured_fanout_subs.extend(subs)
        return len(subs)

    monkeypatch.setattr(PushService, "_fanout_to", spy_fanout_to)

    event = {
        "id": "harness_p7_event_001",
        "camera_id": "front_door",
        "person_name": event_person_name,
        "ts": 1_700_000_000,
    }
    payload = {"title": "harness p7"}

    # when
    sent = await service.send_matching(event, payload)

    # then
    captured_indexes = [
        next(index for index, candidate in enumerate(service.subs) if candidate is sub)
        for sub in captured_fanout_subs
    ]
    expected_indexes = [
        index for index in range(len(service.subs)) if index != 1
    ]
    assert sent == len(expected_indexes)
    assert captured_indexes == expected_indexes, (
        "FAIL: person filters did not gate subscriptions before fanout; "
        "expected matching subscription indexes {0}, got {1}"
    ).format(expected_indexes, captured_indexes)
