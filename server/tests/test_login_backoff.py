"""PR-104 persistent progressive login-backoff service tests."""
from __future__ import annotations

import sqlite3
from concurrent.futures import ThreadPoolExecutor

import pytest

from app.services import audit_db, login_backoff


@pytest.fixture
def backoff_db(tmp_path):
    path = tmp_path / "audit.db"
    audit_db.init_db(path)
    return path


def test_given_equivalent_accounts_and_addresses_when_normalized_then_keys_match():
    # arrange / act / assert
    assert login_backoff.normalize_account("  Ａlice ") == "alice"
    assert login_backoff.canonical_source_address("100.064.0.1") == "unknown"
    assert login_backoff.canonical_source_address("::ffff:100.64.0.1") == "100.64.0.1"
    assert login_backoff.canonical_source_address("fd7a:115c:a1e0::0001") == (
        "fd7a:115c:a1e0::1"
    )
    assert login_backoff.canonical_source_address(None) == "unknown"


def test_given_failure_counts_when_progressed_then_delay_is_bounded():
    # arrange / act / assert
    assert [login_backoff.backoff_seconds(n) for n in range(1, 10)] == [
        0,
        0,
        1,
        2,
        4,
        8,
        16,
        32,
        60,
    ]
    assert login_backoff.backoff_seconds(100) == login_backoff.MAX_BACKOFF_S


def test_given_three_failures_when_store_reopens_then_backoff_survives_restart(backoff_db):
    # arrange
    key = {
        "endpoint": login_backoff.LOGIN_ENDPOINT,
        "account_key": "alice",
        "source_addr": "100.64.0.10",
    }

    # act
    assert login_backoff.record_failure(backoff_db, now=100.0, **key) == 0
    assert login_backoff.record_failure(backoff_db, now=100.1, **key) == 0
    assert login_backoff.record_failure(backoff_db, now=100.2, **key) == 1
    # Every call opens a fresh SQLite connection, matching a new process after
    # restart rather than relying on in-memory state.
    after_restart = login_backoff.retry_after(backoff_db, now=100.3, **key)

    # assert
    assert after_restart == 1


def test_given_multiple_buckets_when_one_succeeds_then_only_that_bucket_clears(backoff_db):
    # arrange
    endpoint = login_backoff.LOGIN_ENDPOINT
    alice_phone = dict(endpoint=endpoint, account_key="alice", source_addr="100.64.0.1")
    alice_laptop = dict(endpoint=endpoint, account_key="alice", source_addr="100.64.0.2")
    bob_phone = dict(endpoint=endpoint, account_key="bob", source_addr="100.64.0.1")
    other_endpoint = dict(endpoint="POST /other", account_key="alice", source_addr="100.64.0.1")
    for key in (alice_phone, alice_laptop, bob_phone, other_endpoint):
        for _ in range(3):
            login_backoff.record_failure(backoff_db, now=200.0, **key)

    # act
    login_backoff.clear(backoff_db, **alice_phone)

    # assert
    assert login_backoff.retry_after(backoff_db, now=200.1, **alice_phone) == 0
    assert login_backoff.retry_after(backoff_db, now=200.1, **alice_laptop) == 1
    assert login_backoff.retry_after(backoff_db, now=200.1, **bob_phone) == 1
    assert login_backoff.retry_after(backoff_db, now=200.1, **other_endpoint) == 1


def test_given_stale_or_clock_rollback_state_when_checked_then_it_cannot_lock_forever(backoff_db):
    # arrange
    key = dict(
        endpoint=login_backoff.LOGIN_ENDPOINT,
        account_key="alice",
        source_addr="100.64.0.1",
    )
    for _ in range(9):
        login_backoff.record_failure(backoff_db, now=1000.0, **key)

    # act / assert
    assert login_backoff.retry_after(
        backoff_db,
        now=1000.0 + login_backoff.RESET_AFTER_S,
        **key,
    ) == 0
    for _ in range(3):
        login_backoff.record_failure(backoff_db, now=2000.0, **key)
    assert login_backoff.retry_after(backoff_db, now=1900.0, **key) == 0


def test_given_concurrent_failures_when_recorded_then_increment_is_atomic(backoff_db):
    # arrange
    key = dict(
        endpoint=login_backoff.LOGIN_ENDPOINT,
        account_key="alice",
        source_addr="100.64.0.1",
    )

    # act
    with ThreadPoolExecutor(max_workers=8) as pool:
        futures = [
            pool.submit(login_backoff.record_failure, backoff_db, now=3000.0, **key)
            for _ in range(8)
        ]
        for future in futures:
            future.result()

    # assert — eight serialized failures produce the 32-second rung.
    assert login_backoff.retry_after(backoff_db, now=3000.0, **key) == 32


def test_given_many_unknown_accounts_when_recorded_then_storage_is_bounded(
    backoff_db, monkeypatch
):
    # arrange
    monkeypatch.setattr(login_backoff, "MAX_BUCKETS", 3)

    # act
    for index in range(5):
        login_backoff.record_failure(
            backoff_db,
            endpoint=login_backoff.LOGIN_ENDPOINT,
            account_key="unknown-{}".format(index),
            source_addr="100.64.0.1",
            now=4000.0 + index,
        )

    # assert
    assert login_backoff.bucket_count(backoff_db) == 3


def test_given_legacy_audit_db_when_initialized_then_migration_preserves_events(tmp_path):
    # arrange
    path = tmp_path / "legacy-audit.db"
    audit_db.init_db(path)
    audit_db.insert_auth_event(
        path,
        ts=1.0,
        username="alice",
        action="login_fail",
        ua="test",
    )
    with sqlite3.connect(path) as conn:
        conn.execute("DROP TABLE login_backoff")
        conn.commit()

    # act
    audit_db.init_db(path)

    # assert
    assert len(audit_db.auth_events_between(path, since=0, until=2)) == 1
    assert login_backoff.bucket_count(path) == 0
