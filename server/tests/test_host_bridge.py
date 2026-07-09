from app.services import host_bridge


def setup_function():
    host_bridge.reset_for_tests()


def test_given_live_pending_when_enqueue_again_then_existing_record_returned():
    # arrange
    first = host_bridge.enqueue("reboot", {}, "owner", now=100.0)

    # act
    second = host_bridge.enqueue("mediamtx", {}, "owner", now=101.0)

    # assert
    assert second["id"] == first["id"]
    assert second["kind"] == "reboot"


def test_given_stale_pending_when_enqueue_again_then_old_expires_and_new_created():
    # arrange
    first = host_bridge.enqueue("reboot", {}, "owner", now=100.0)

    # act
    second = host_bridge.enqueue(
        "mediamtx",
        {},
        "owner",
        now=221.0,
        max_pending_age_s=120.0,
    )

    # assert
    assert second["id"] != first["id"]
    assert second["kind"] == "mediamtx"
    assert host_bridge.history()[0]["id"] == first["id"]
    assert host_bridge.history()[0]["status"] == "expired"


def test_given_pending_record_when_peek_before_stale_bound_then_record_returned():
    # arrange
    rec = host_bridge.enqueue("mediamtx", {}, "owner", now=100.0)

    # act
    peeked = host_bridge.peek(150.0, max_pending_age_s=120.0)

    # assert
    assert peeked["id"] == rec["id"]
    assert peeked["status"] == "pending"


def test_given_stale_pending_when_peek_then_expired_and_hidden():
    # arrange
    rec = host_bridge.enqueue("reboot", {}, "owner", now=100.0)

    # act
    peeked = host_bridge.peek(221.0, max_pending_age_s=120.0)

    # assert
    assert peeked is None
    expired = host_bridge.get(rec["id"])
    assert expired["status"] == "expired"
    assert expired["detail"] == "expired before worker claim"
    assert host_bridge.history()[0]["id"] == rec["id"]


def test_given_pending_record_when_claimed_then_compare_and_set_once():
    # arrange
    rec = host_bridge.enqueue("nvargus", {}, "owner", now=100.0)

    # act
    first = host_bridge.claim(rec["id"], now=101.0)
    second = host_bridge.claim(rec["id"], now=102.0)
    wrong = host_bridge.claim("missing", now=103.0)

    # assert
    assert first == "claimed"
    assert second == "conflict"
    assert wrong == "unknown"
    assert host_bridge.get(rec["id"])["status"] == "running"
    assert host_bridge.get(rec["id"])["claimed_at"] == 101.0


def test_given_running_record_when_result_recorded_then_terminal_and_historied():
    # arrange
    rec = host_bridge.enqueue("logs", {"unit": "mediamtx"}, "owner", now=100.0)
    assert host_bridge.claim(rec["id"], now=101.0) == "claimed"

    # act
    ok = host_bridge.record_result(
        rec["id"],
        "done",
        "logs fetched",
        {"lines": ["normal"]},
        now=102.0,
    )

    # assert
    assert ok is True
    stored = host_bridge.get(rec["id"])
    assert stored["status"] == "done"
    assert stored["detail"] == "logs fetched"
    assert stored["result"] == {"lines": ["normal"]}
    assert stored["result_at"] == 102.0
    assert host_bridge.history()[0]["id"] == rec["id"]


def test_given_unknown_id_when_result_recorded_then_false():
    # arrange
    host_bridge.enqueue("logs", {}, "owner", now=100.0)

    # act
    ok = host_bridge.record_result("missing", "failed", "nope", None, now=101.0)

    # assert
    assert ok is False


def test_given_pending_record_when_result_recorded_then_tolerated():
    # arrange
    rec = host_bridge.enqueue("mediamtx", {}, "owner", now=100.0)

    # act
    ok = host_bridge.record_result(rec["id"], "failed", "skipped", None, now=101.0)

    # assert
    assert ok is True
    assert host_bridge.get(rec["id"])["status"] == "failed"


def test_given_history_over_limit_when_recording_results_then_keeps_newest_twenty():
    # arrange / act
    ids = []
    for i in range(25):
        rec = host_bridge.enqueue("mediamtx", {"i": i}, "owner", now=float(i))
        ids.append(rec["id"])
        assert host_bridge.record_result(rec["id"], "done", None, None, now=i + 0.5)

    # assert
    hist = host_bridge.history()
    assert len(hist) == 20
    assert hist[0]["id"] == ids[-1]
    assert hist[-1]["id"] == ids[-20]


def test_given_returned_records_when_mutated_then_store_is_not_mutated():
    # arrange
    rec = host_bridge.enqueue("logs", {"unit": "mediamtx"}, "owner", now=100.0)

    # act
    rec["args"]["unit"] = "bad"
    stored = host_bridge.get(rec["id"])

    # assert
    assert stored["args"] == {"unit": "mediamtx"}


def test_given_state_file_when_loaded_then_current_and_history_restore(tmp_path):
    # arrange
    path = tmp_path / "host_action.json"
    host_bridge.reset_for_tests(path)
    rec = host_bridge.enqueue("mediamtx", {}, "owner", now=100.0)
    assert host_bridge.record_result(rec["id"], "done", "ok", None, now=101.0)
    live = host_bridge.enqueue("reboot", {}, "owner", now=102.0)

    # act
    host_bridge.reset_for_tests(path)
    host_bridge.load(path)

    # assert
    assert host_bridge.latest()["id"] == live["id"]
    assert host_bridge.history()[0]["id"] == rec["id"]


def test_given_corrupt_state_file_when_loaded_then_store_starts_empty(tmp_path):
    # arrange
    path = tmp_path / "host_action.json"
    path.write_text("{not-json", encoding="utf-8")

    # act
    host_bridge.reset_for_tests(path)
    host_bridge.load(path)

    # assert
    assert host_bridge.latest() is None
    assert host_bridge.history() == []


def test_given_fresh_running_when_enqueue_again_then_in_flight_action_honored():
    # arrange — a claimed (running) record still within the running window.
    rec = host_bridge.enqueue("nvargus", {}, "owner", now=100.0)
    assert host_bridge.claim(rec["id"], now=101.0) == "claimed"

    # act — a second request arrives 30 s into the action (< 120 s window).
    second = host_bridge.enqueue("mediamtx", {}, "owner", now=131.0)

    # assert — the in-flight recovery is honored, not double-fired.
    assert second["id"] == rec["id"]
    assert second["status"] == "running"


def test_given_orphaned_running_when_enqueue_again_then_expired_and_new_created():
    """2026-07-09: a worker that dies between claim and result leaves a stuck
    `running` record. It must expire so the bridge isn't jammed forever
    (observed live: a mediamtx recovery restarted the worker mid-action, and
    the orphan blocked every later recovery + logs request)."""
    # arrange — claimed at t=101, then the worker "dies" (no result posted).
    rec = host_bridge.enqueue("mediamtx", {}, "owner", now=100.0)
    assert host_bridge.claim(rec["id"], now=101.0) == "claimed"

    # act — a new request well past the running window (claimed_at + 120 s).
    second = host_bridge.enqueue(
        "nvargus", {}, "owner", now=300.0, max_running_age_s=120.0
    )

    # assert — the orphan expired to history; the new request is live.
    assert second["id"] != rec["id"]
    assert second["kind"] == "nvargus"
    orphan = host_bridge.get(rec["id"])
    assert orphan["status"] == "expired"
    assert "died mid-action" in (orphan["detail"] or "")


def test_given_orphaned_running_when_peek_then_self_heals_to_expired():
    # arrange — a claimed record whose worker never reports back.
    rec = host_bridge.enqueue("nvargus", {}, "owner", now=100.0)
    assert host_bridge.claim(rec["id"], now=101.0) == "claimed"

    # act — the worker's own poll (peek) past the running window.
    peeked = host_bridge.peek(300.0, max_pending_age_s=120.0, max_running_age_s=120.0)

    # assert — nothing to hand out, and the orphan self-healed to expired so
    # the status route stops reporting a phantom `running`.
    assert peeked is None
    assert host_bridge.get(rec["id"])["status"] == "expired"
