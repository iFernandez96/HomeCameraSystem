import json
import shutil
from pathlib import Path

import pytest

from server.tests.harness_push_gateway.fixture_loader import load_push_subscriptions


FIXTURE_DIR = (
    Path(__file__).resolve().parents[3]
    / ".jetson-snapshot"
    / "proof_fixtures"
    / "push"
)
PUSH_SUBS = FIXTURE_DIR / "push_subs.json"
VAPID_PRIVATE = FIXTURE_DIR / "vapid_private.pem"
VAPID_PUBLIC = FIXTURE_DIR / "vapid_public.pem"

pytestmark = pytest.mark.skipif(
    not (PUSH_SUBS.exists() and VAPID_PRIVATE.exists() and VAPID_PUBLIC.exists()),
    reason=(
        "no complete Jetson push fixture - capture "
        ".jetson-snapshot/proof_fixtures/push/push_subs.json, "
        "vapid_private.pem, and vapid_public.pem"
    ),
)


@pytest.mark.asyncio
async def test_given_real_copied_sub_and_loaded_vapid_when_fanout_sends_then_webpush_boundary_kwargs_match_contract(
    tmp_path,
    monkeypatch,
):
    # given
    from app.config import settings
    from app.services import push_service as push_service_module
    from app.services.push_service import PushService
    from py_vapid import Vapid

    copied_subs = tmp_path / "push_subs.json"
    shutil.copy2(PUSH_SUBS, copied_subs)
    fixture_subs = load_push_subscriptions(copied_subs)
    assert fixture_subs

    monkeypatch.setattr(settings, "vapid_private_key_path", VAPID_PRIVATE)
    monkeypatch.setattr(settings, "vapid_public_key_path", VAPID_PUBLIC)

    service = PushService(persist_path=copied_subs)
    service.load_keys()
    assert isinstance(service._vapid_obj, Vapid)

    captured_calls = []

    async def inline_to_thread(func, /, *args, **kwargs):
        return func(*args, **kwargs)

    def spy_webpush(*args, **kwargs):
        captured_calls.append((args, kwargs))
        return None

    monkeypatch.setattr(push_service_module.asyncio, "to_thread", inline_to_thread)
    monkeypatch.setattr(push_service_module, "webpush", spy_webpush)

    payload = {
        "title": "Person detected",
        "body": "Front Door · 91%",
        "tag": "detection",
        "url": "/events",
        "event_id": "harness_p9_event_001",
        "unread_count": 3,
        "image": "/snapshots/thumb_1700000000000.jpg",
    }

    # when
    sent = await service._fanout_to([service.subs[0]], payload)

    # then
    assert sent == 1
    assert len(captured_calls) == 1

    args, kwargs = captured_calls[0]
    assert args == ()
    assert kwargs["subscription_info"] == service.subs[0]
    assert kwargs["data"] == json.dumps(payload)
    assert isinstance(kwargs["vapid_private_key"], Vapid)
    assert kwargs["vapid_claims"] == {"sub": settings.vapid_subject}

    missing = []
    if "ttl" not in kwargs:
        missing.append("ttl")
    headers = kwargs.get("headers")
    if not isinstance(headers, dict) or headers.get("Urgency") != "normal":
        missing.append("headers.Urgency=normal")
    assert not missing, (
        "FAIL: webpush call boundary is missing explicit delivery kwargs: {0}; "
        "expected explicit integer ttl kwarg and headers.Urgency='normal'"
    ).format(", ".join(missing))
    assert isinstance(kwargs["ttl"], int)
    assert kwargs["headers"]["Urgency"] == "normal"
