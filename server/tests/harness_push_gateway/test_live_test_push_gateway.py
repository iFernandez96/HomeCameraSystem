import asyncio
import json
import logging
import os
import shutil
from pathlib import Path
from urllib.parse import urlsplit

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

pytestmark = [
    pytest.mark.skipif(
        not (PUSH_SUBS.exists() and VAPID_PRIVATE.exists() and VAPID_PUBLIC.exists()),
        reason=(
            "no complete Jetson push fixture - capture "
            ".jetson-snapshot/proof_fixtures/push/push_subs.json, "
            "vapid_private.pem, and vapid_public.pem"
        ),
    ),
    pytest.mark.skipif(
        os.environ.get("HOMECAM_LIVE_PUSH") != "1",
        reason="HOMECAM_LIVE_PUSH=1 not set; live push gateway test disabled",
    ),
]


def _newest_subscription_index(subs):
    def recency_key(indexed_sub):
        index, sub = indexed_sub
        expiration_time = sub.expiration_time
        if isinstance(expiration_time, (int, float)):
            return (1, expiration_time, index)
        return (0, index)

    index, _sub = max(enumerate(subs), key=recency_key)
    return index


def _secret_needles(raw_subs):
    needles = []
    for index, sub in enumerate(raw_subs):
        parsed = urlsplit(sub["endpoint"])
        endpoint_secret = parsed.path
        if parsed.query:
            endpoint_secret = endpoint_secret + "?" + parsed.query
        needles.append(("endpoint_path[{0}]".format(index), endpoint_secret))
        needles.append(("p256dh[{0}]".format(index), sub["keys"]["p256dh"]))
        needles.append(("auth[{0}]".format(index), sub["keys"]["auth"]))
        needles.append(
            (
                "subscription_json[{0}]".format(index),
                json.dumps(sub, sort_keys=True, separators=(",", ":")),
            )
        )
    return needles


@pytest.mark.asyncio
async def test_given_real_copied_registry_and_vapid_when_single_live_test_push_sends_then_one_success_no_prune_and_logs_are_secret_safe(
    tmp_path,
    caplog,
    monkeypatch,
):
    # given
    from app.config import settings
    from app.services.push_service import PushService

    copied_subs = tmp_path / "push_subs.json"
    shutil.copy2(PUSH_SUBS, copied_subs)
    raw_subs = json.loads(copied_subs.read_text())
    fixture_subs = load_push_subscriptions(copied_subs)
    assert fixture_subs

    newest_index = _newest_subscription_index(fixture_subs)

    monkeypatch.setattr(settings, "vapid_private_key_path", VAPID_PRIVATE)
    monkeypatch.setattr(settings, "vapid_public_key_path", VAPID_PUBLIC)

    service = PushService(persist_path=copied_subs)
    service.load_keys()
    assert service.private_pem is not None
    assert service._vapid_obj is not None

    selected_sub = service.subs[newest_index]
    original_count = len(service.subs)
    payload = {
        "title": "HomeCam harness test push",
        "body": "Live harness gateway check from disposable registry copy.",
        "tag": "harness-test",
    }

    # when
    with caplog.at_level(logging.INFO, logger="app.services.push_service"):
        sent = await asyncio.wait_for(
            service._fanout_to([selected_sub], payload),
            timeout=60,
        )

    # then
    assert sent == 1
    assert len(service.subs) == original_count
    assert len(json.loads(copied_subs.read_text())) == original_count

    log_text = "\n".join(record.getMessage() for record in caplog.records)
    leaked = [
        label
        for label, needle in _secret_needles(raw_subs)
        if isinstance(needle, str) and needle and needle in log_text
    ]
    assert not leaked, (
        "FAIL: live push logs leaked subscription secret material: {0} "
        "(log text withheld - inspect caplog under a debugger)"
    ).format(", ".join(leaked))
