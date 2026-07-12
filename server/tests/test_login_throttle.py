from app.auth.login_throttle import LoginThrottle


def test_given_fewer_than_limit_failures_when_checked_then_login_is_allowed():
    # arrange
    now = [100.0]
    throttle = LoginThrottle(failure_limit=3, clock=lambda: now[0])

    # act
    throttle.record_failure("Alice", "10.0.0.1")
    throttle.record_failure("alice", "10.0.0.1")

    # assert
    assert throttle.retry_after(" alice ", "10.0.0.1") == 0


def test_given_limit_reached_when_checked_then_exponential_backoff_is_bounded():
    # arrange
    now = [100.0]
    throttle = LoginThrottle(
        failure_limit=2,
        base_block_s=2,
        max_block_s=4,
        clock=lambda: now[0],
    )

    # act / assert
    throttle.record_failure("alice", "10.0.0.1")
    throttle.record_failure("alice", "10.0.0.1")
    assert throttle.retry_after("alice", "10.0.0.1") == 2
    now[0] += 2
    throttle.record_failure("alice", "10.0.0.1")
    assert throttle.retry_after("alice", "10.0.0.1") == 4
    now[0] += 4
    throttle.record_failure("alice", "10.0.0.1")
    assert throttle.retry_after("alice", "10.0.0.1") == 4


def test_given_success_when_same_key_checked_then_failure_history_is_cleared():
    # arrange
    throttle = LoginThrottle(failure_limit=1)
    throttle.record_failure("alice", "10.0.0.1")

    # act
    throttle.record_success("alice", "10.0.0.1")

    # assert
    assert throttle.retry_after("alice", "10.0.0.1") == 0


def test_given_many_distinct_attack_keys_when_recorded_then_table_stays_bounded():
    # arrange
    throttle = LoginThrottle(failure_limit=1, max_keys=2)

    # act
    throttle.record_failure("one", "10.0.0.1")
    throttle.record_failure("two", "10.0.0.2")
    throttle.record_failure("three", "10.0.0.3")

    # assert — oldest key was evicted; newer abusive keys remain blocked.
    assert throttle.retry_after("one", "10.0.0.1") == 0
    assert throttle.retry_after("two", "10.0.0.2") > 0
    assert throttle.retry_after("three", "10.0.0.3") > 0


def test_given_failure_window_elapsed_when_checked_then_old_failures_do_not_lock_account():
    # arrange
    now = [100.0]
    throttle = LoginThrottle(failure_limit=1, window_s=10, clock=lambda: now[0])
    throttle.record_failure("alice", "10.0.0.1")

    # act
    now[0] += 11

    # assert
    assert throttle.retry_after("alice", "10.0.0.1") == 0

