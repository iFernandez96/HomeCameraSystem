import time
from unittest.mock import AsyncMock

import pytest

from app.config import settings
from app.services import daily_digest, events_db
from app.services.detection_config import detection_config
from app.services.event_bus import make_detection_event


@pytest.mark.asyncio
async def test_digest_sends_once_after_configured_time(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "digest_state_path", tmp_path / "digest.json")
    detection_config.update(daily_digest_enabled=True, daily_digest_time="00:00")
    event = make_detection_event(label="person", score=0.9, boxes=[])
    events_db.insert_event(settings.events_db_path, event)
    send = AsyncMock(return_value=1)
    monkeypatch.setattr(daily_digest.push_service, "send_all", send)

    now = time.time()
    assert await daily_digest.send_if_due(now) is True
    assert await daily_digest.send_if_due(now) is False
    payload = send.call_args.args[0]
    assert payload["title"] == "Today's camera digest"
    assert "1 person" in payload["body"]
    assert payload["silent"] is True


@pytest.mark.asyncio
async def test_disabled_digest_never_sends(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "digest_state_path", tmp_path / "digest.json")
    detection_config.update(daily_digest_enabled=False)
    send = AsyncMock(return_value=1)
    monkeypatch.setattr(daily_digest.push_service, "send_all", send)

    assert await daily_digest.send_if_due(time.time()) is False
    send.assert_not_called()
