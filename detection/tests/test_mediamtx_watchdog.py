"""Unit tests for MediaMtxWatchdog.

Run from `detection/`:
    python -m pytest tests/test_mediamtx_watchdog.py -q

The watchdog module is pure stdlib so these tests don't pull in
jetson_inference / jetson_utils — they can run on the dev host.
"""
import sys
from pathlib import Path

# detect.py / mediamtx_watchdog.py sit one level up.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from mediamtx_watchdog import MediaMtxWatchdog  # noqa: E402


def test_does_not_fire_below_threshold():
    w = MediaMtxWatchdog(fail_threshold=5, cooldown_s=10.0)
    for _ in range(4):
        w.on_capture_fail()
    assert w.should_restart(now=100.0) is False


def test_fires_at_exact_threshold():
    w = MediaMtxWatchdog(fail_threshold=5, cooldown_s=10.0)
    for _ in range(5):
        w.on_capture_fail()
    assert w.should_restart(now=100.0) is True


def test_capture_ok_resets_failures():
    w = MediaMtxWatchdog(fail_threshold=3, cooldown_s=10.0)
    w.on_capture_fail()
    w.on_capture_fail()
    w.on_capture_ok()
    w.on_capture_fail()
    assert w.should_restart(now=100.0) is False


def test_cooldown_blocks_immediate_refire():
    w = MediaMtxWatchdog(fail_threshold=3, cooldown_s=60.0)
    for _ in range(3):
        w.on_capture_fail()
    assert w.should_restart(now=0.0) is True
    w.mark_restarted(now=0.0)
    # Failures keep coming during the cooldown — no second kick.
    for _ in range(10):
        w.on_capture_fail()
    assert w.should_restart(now=30.0) is False


def test_fires_again_after_cooldown_expires():
    w = MediaMtxWatchdog(fail_threshold=3, cooldown_s=60.0)
    for _ in range(3):
        w.on_capture_fail()
    w.mark_restarted(now=0.0)
    # Past the cooldown, accumulate another burst and we kick again.
    for _ in range(3):
        w.on_capture_fail()
    assert w.should_restart(now=70.0) is True


def test_given_failures_when_mark_restarted_then_failures_persist_post_iter_300():
    """iter-300 fix: pre-iter-300 mark_restarted reset failures to 0,
    leaving a 60 s blind window if the kick didn't recover the stream
    (had to re-accumulate to threshold AFTER cooldown). Post-fix:
    only on_capture_ok (a real frame received) clears the tally."""
    # arrange
    w = MediaMtxWatchdog(fail_threshold=3, cooldown_s=60.0)
    for _ in range(3):
        w.on_capture_fail()

    # act
    w.mark_restarted(now=10.0)

    # assert
    assert w.failures == 3, "iter-300: tally must persist past mark_restarted"
    assert w.restart_count == 1


def test_given_failed_recovery_when_cooldown_expires_then_watchdog_refires_immediately():
    """iter-300: with the failures tally now persisting past
    mark_restarted, a second restart can fire as soon as the cooldown
    expires — no need to re-accumulate 30 more failures (which on the
    Nano is another 60 s of stalled stream). Halves the failed-
    recovery dead window."""
    # arrange
    w = MediaMtxWatchdog(fail_threshold=3, cooldown_s=60.0)
    for _ in range(3):
        w.on_capture_fail()
    w.mark_restarted(now=0.0)
    # Stream still broken; one more failure inside the cooldown.
    w.on_capture_fail()

    # act + assert
    assert w.should_restart(now=30.0) is False, "still in cooldown"
    # iter-300 win: at the cooldown boundary, we're already eligible
    # to refire because failures (now 4) is still above threshold.
    # Pre-iter-300 we'd be at failures=1 here and would need to wait
    # another 60 s for re-accumulation.
    assert w.should_restart(now=61.0) is True


def test_restart_count_increments():
    # arrange
    w = MediaMtxWatchdog(fail_threshold=3, cooldown_s=60.0)
    for _ in range(3):
        w.on_capture_fail()

    # act
    w.mark_restarted(now=0.0)
    # iter-300: failures persist past mark_restarted, so we don't need
    # to re-accumulate to fire again past cooldown.
    w.mark_restarted(now=70.0)

    # assert
    assert w.restart_count == 2
