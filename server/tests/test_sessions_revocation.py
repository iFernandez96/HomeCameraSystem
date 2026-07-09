from __future__ import annotations

from app.sessions.revocation import is_revoked, should_write_last_seen


def test_given_no_revoked_timestamp_when_checked_then_session_is_not_revoked():
    # arrange
    revoked_ts = None
    now = 100.0

    # act
    revoked = is_revoked("jti-1", revoked_ts, now)

    # assert
    assert revoked is False


def test_given_revoked_timestamp_equal_to_now_when_checked_then_session_is_revoked():
    # arrange
    revoked_ts = 100.0
    now = 100.0

    # act
    revoked = is_revoked("jti-1", revoked_ts, now)

    # assert
    assert revoked is True


def test_given_revoked_timestamp_before_now_when_checked_then_session_is_revoked():
    # arrange
    revoked_ts = 99.0
    now = 100.0

    # act
    revoked = is_revoked("jti-1", revoked_ts, now)

    # assert
    assert revoked is True


def test_given_future_revoked_timestamp_when_checked_then_session_is_not_yet_revoked():
    # arrange
    revoked_ts = 101.0
    now = 100.0

    # act
    revoked = is_revoked("jti-1", revoked_ts, now)

    # assert
    assert revoked is False


def test_given_last_seen_younger_than_throttle_when_checked_then_skip_write():
    # arrange
    prev_last_seen = 100.0
    now = 159.999
    throttle_s = 60.0

    # act
    should_write = should_write_last_seen(prev_last_seen, now, throttle_s)

    # assert
    assert should_write is False


def test_given_last_seen_exactly_at_throttle_when_checked_then_write():
    # arrange
    prev_last_seen = 100.0
    now = 160.0
    throttle_s = 60.0

    # act
    should_write = should_write_last_seen(prev_last_seen, now, throttle_s)

    # assert
    assert should_write is True


def test_given_last_seen_older_than_default_throttle_when_checked_then_write():
    # arrange
    prev_last_seen = 100.0
    now = 161.0

    # act
    should_write = should_write_last_seen(prev_last_seen, now)

    # assert
    assert should_write is True

