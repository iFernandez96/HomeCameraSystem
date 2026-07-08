import asyncio
import copy
import json
import logging
import os
import shutil
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

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
        reason="HOMECAM_LIVE_PUSH=1 not set; live push gateway prune test disabled",
    ),
]


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


def _with_dead_final_path_token(endpoint):
    parsed = urlsplit(endpoint)
    path_parts = parsed.path.rsplit("/", 1)
    if len(path_parts) == 1:
        dead_path = path_parts[0] + "dead"
    else:
        prefix, final_token = path_parts
        dead_path = prefix + "/" + final_token + "dead"
    return urlunsplit(
        (
            parsed.scheme,
            parsed.netloc,
            dead_path,
            parsed.query,
            parsed.fragment,
        )
    )


def _logged_gateway_outcomes(records):
    outcomes = []
    for record in records:
        message = record.getMessage()
        if not message.startswith("push to "):
            continue

        rest = message[len("push to ") :]
        if " transient error " in rest:
            host = rest.split(" transient error ", 1)[0]
            outcomes.append((host, None))
            continue

        host, separator, suffix = rest.partition(": ")
        if not separator:
            continue

        status_text = suffix.split(None, 1)[0]
        status = int(status_text) if status_text.isdigit() else None
        outcomes.append((host, status))
    return outcomes


@pytest.mark.asyncio
async def test_given_full_real_registry_copy_and_vapid_when_send_all_runs_live_then_only_404_410_are_pruned_and_logs_are_secret_safe(
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
    assert len(fixture_subs) == 8, (
        "FAIL: live prune fixture must be the full 8-sub registry copy; "
        "actual_count={0}"
    ).format(len(fixture_subs))

    original_count = len(raw_subs)
    original_hosts = sorted({urlsplit(sub["endpoint"]).netloc for sub in raw_subs})
    original_endpoints = [sub["endpoint"] for sub in raw_subs]

    dead_sub = copy.deepcopy(raw_subs[0])
    dead_sub["endpoint"] = _with_dead_final_path_token(dead_sub["endpoint"])
    assert dead_sub["endpoint"] != raw_subs[0]["endpoint"]
    assert urlsplit(dead_sub["endpoint"]).netloc == urlsplit(
        raw_subs[0]["endpoint"]
    ).netloc

    registry_subs = raw_subs + [dead_sub]
    copied_subs.write_text(json.dumps(registry_subs, indent=2) + "\n")

    monkeypatch.setattr(settings, "vapid_private_key_path", VAPID_PRIVATE)
    monkeypatch.setattr(settings, "vapid_public_key_path", VAPID_PUBLIC)

    service = PushService(persist_path=copied_subs)
    service.load_keys()
    assert service.private_pem is not None
    assert service._vapid_obj is not None
    assert len(service.subs) == original_count + 1

    payload = {
        "title": "HomeCam harness prune check",
        "body": "Live disposable-registry prune check.",
        "tag": "harness-prune",
    }

    # when
    with caplog.at_level(logging.INFO, logger="app.services.push_service"):
        sent = await asyncio.wait_for(
            service.send_all(payload),
            timeout=90,
        )

    # then
    persisted_subs = json.loads(copied_subs.read_text())
    outcomes = _logged_gateway_outcomes(caplog.records)
    dead_count = sum(1 for _host, status in outcomes if status in (404, 410))
    failed_count = len(outcomes)
    transient_or_non_dead_count = failed_count - dead_count
    expected_sent = len(registry_subs) - failed_count
    remaining_endpoints = [sub["endpoint"] for sub in service.subs]
    persisted_endpoints = [sub["endpoint"] for sub in persisted_subs]

    assert failed_count == 1, (
        "FAIL: live prune leg expected exactly one gateway failure from the "
        "synthetic dead subscription; hosts={0}; failures={1}; statuses={2}"
    ).format(
        ",".join(original_hosts),
        failed_count,
        ",".join(str(status) for _host, status in outcomes),
    )
    assert dead_count == 1, (
        "FAIL: live prune leg expected the one gateway failure to be a "
        "404/410 prune signal; failures={0}; dead={1}; statuses={2}; "
        "non_dead_failures={3}"
    ).format(
        failed_count,
        dead_count,
        ",".join(str(status) for _host, status in outcomes),
        transient_or_non_dead_count,
    )
    assert sent == expected_sent, (
        "FAIL: sent count did not match gateway-accepted sends; "
        "registry={0} failures={1} sent={2}"
    ).format(len(registry_subs), failed_count, sent)
    assert sent == original_count, (
        "FAIL: all live registry subscriptions should be accepted exactly once; "
        "live={0} sent={1} failures={2}"
    ).format(original_count, sent, failed_count)
    assert len(service.subs) == len(registry_subs) - 1, (
        "FAIL: in-memory prune count mismatch; registry={0} dead={1} "
        "remaining={2}"
    ).format(
        len(registry_subs),
        dead_count,
        len(service.subs),
    )
    assert len(persisted_subs) == len(registry_subs) - 1, (
        "FAIL: persisted prune count mismatch; registry={0} dead={1} "
        "persisted={2}"
    ).format(
        len(registry_subs),
        dead_count,
        len(persisted_subs),
    )
    assert remaining_endpoints == original_endpoints
    assert persisted_endpoints == original_endpoints
    assert dead_sub["endpoint"] not in remaining_endpoints
    assert dead_sub["endpoint"] not in persisted_endpoints
    assert len(service.subs) + dead_count == len(registry_subs)
    assert len(persisted_subs) == len(service.subs)

    log_text = "\n".join(record.getMessage() for record in caplog.records)
    leaked = [
        label
        for label, needle in _secret_needles(registry_subs)
        if isinstance(needle, str) and needle and needle in log_text
    ]
    assert not leaked, (
        "FAIL: live push prune logs leaked subscription secret material: {0} "
        "(log text withheld - inspect caplog under a debugger)"
    ).format(", ".join(leaked))
