import json
import logging
import shutil
from pathlib import Path
from urllib.parse import urlsplit

import pytest


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


class _GatewayFailureResponse:
    status_code = 503
    text = "synthetic gateway failure"


@pytest.mark.asyncio
async def test_given_real_copied_subs_when_one_send_fails_then_warning_logs_are_secret_redacted(
    tmp_path,
    caplog,
    monkeypatch,
):
    # given
    from app.services import push_service as push_service_module
    from app.services.push_service import PushService
    from pywebpush import WebPushException

    copied_subs = tmp_path / "push_subs.json"
    shutil.copy2(PUSH_SUBS, copied_subs)
    raw_subs = json.loads(copied_subs.read_text())
    service = PushService(persist_path=copied_subs)
    service.private_pem = b"fake-pem"

    failing_endpoint = service.subs[0]["endpoint"]
    failing_host = urlsplit(failing_endpoint).netloc
    failed_once = False

    async def inline_to_thread(func, /, *args, **kwargs):
        return func(*args, **kwargs)

    def fake_webpush(subscription_info, **_kwargs):
        nonlocal failed_once
        if not failed_once:
            failed_once = True
            raise WebPushException(
                "synthetic gateway failure",
                response=_GatewayFailureResponse(),
            )
        return None
    monkeypatch.setattr(push_service_module, "webpush", fake_webpush)
    monkeypatch.setattr(push_service_module.asyncio, "to_thread", inline_to_thread)

    # when
    with caplog.at_level(logging.WARNING, logger="app.services.push_service"):
        sent = await service.send_all({"title": "harness p3"})

    # then
    assert sent == len(service.subs) - 1
    warned_or_errored = [
        record.getMessage()
        for record in caplog.records
        if record.levelno >= logging.WARNING
    ]
    log_text = "\n".join(warned_or_errored)
    assert failing_host in log_text

    secret_needles = []
    for index, sub in enumerate(raw_subs):
        parsed = urlsplit(sub["endpoint"])
        endpoint_secret = parsed.path
        if parsed.query:
            endpoint_secret = endpoint_secret + "?" + parsed.query
        secret_needles.append(("endpoint_path[{0}]".format(index), endpoint_secret))
        secret_needles.append(("p256dh[{0}]".format(index), sub["keys"]["p256dh"]))
        secret_needles.append(("auth[{0}]".format(index), sub["keys"]["auth"]))
        secret_needles.append(
            (
                "subscription_json[{0}]".format(index),
                json.dumps(sub, sort_keys=True, separators=(",", ":")),
            )
        )

    leaked = [
        label
        for label, needle in secret_needles
        if isinstance(needle, str) and needle and needle in log_text
    ]
    # Labels only in the failure message — echoing the log text here would
    # dump the leaked secret into pytest output, the exact thing this pins.
    assert not leaked, (
        "FAIL: push failure logs leaked subscription secret material: {0} "
        "(log text withheld — inspect caplog under a debugger)"
    ).format(", ".join(leaked))
