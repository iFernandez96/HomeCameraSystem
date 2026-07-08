from pathlib import Path
from urllib.parse import urlsplit

import pytest

from server.tests.harness_push_gateway.fixture_loader import (
    host_summary,
    load_push_subscriptions,
)


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


def test_given_real_push_fixture_when_parsed_then_rows_are_well_formed_and_secret_safe():
    # arrange / act
    subs = load_push_subscriptions(PUSH_SUBS)
    summaries = host_summary(subs)

    # assert
    assert len(subs) == 8
    assert summaries == [
        ("updates.push.services.mozilla.com", 7),
        ("web.push.apple.com", 1),
    ]

    for sub in subs:
        parsed = urlsplit(sub.endpoint)
        assert parsed.scheme == "https"
        assert parsed.netloc in {host for host, _count in summaries}
        assert parsed.path
        assert set(sub.keys) == {"auth", "p256dh"}
        assert all(isinstance(value, str) and value for value in sub.keys.values())
        assert sub.expiration_time is None or isinstance(sub.expiration_time, (int, float))
        assert sub.filters is None or isinstance(sub.filters, dict)
        assert isinstance(sub.user_id, str) and sub.user_id

    failure_output = repr(summaries)
    assert "p256dh" not in failure_output
    assert "auth" not in failure_output
    assert all(urlsplit(sub.endpoint).path not in failure_output for sub in subs)
    assert all(value not in failure_output for sub in subs for value in sub.keys.values())
