import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from presence import PresenceTracker  # noqa: E402
from shadow_presence import ShadowPresenceRunner  # noqa: E402


def test_shadow_ledgers_presence_decision_with_shadow_tag():
    rows = []
    runner = ShadowPresenceRunner(
        PresenceTracker(),
        lambda tag, fields: rows.append((tag, fields)),
        lambda msg: None,
        enabled=True,
    )

    assert runner.observe(
        "person:front_door", (0, 0, 10, 10), 100.0, 8.0, 20.0, 5.0,
    ) is True

    assert rows == [("presence", {
        "transition": "emit",
        "key": "person:front_door",
        "reason": "emit",
        "iou": None,
        "emit": True,
        "shadow": True,
    })]


def test_shadow_tracker_exception_is_swallowed_counted_and_warned_once():
    class RaisingTracker(object):
        def should_emit_with_decision(self, *_args, **_kwargs):
            raise RuntimeError("shadow boom")

    warnings = []
    active = PresenceTracker()
    runner = ShadowPresenceRunner(
        RaisingTracker(),
        lambda tag, fields: (_ for _ in ()).throw(AssertionError("no ledger")),
        warnings.append,
        enabled=True,
        clock=lambda: 10.0,
        warn_interval_s=60.0,
    )

    active_emit, active_decision = active.should_emit_with_decision(
        "person:front_door", (0, 0, 10, 10), 100.0, 8.0, 20.0, 5.0,
    )
    assert active_emit is True
    assert active_decision["reason"] == "emit"

    assert runner.observe(
        "person:front_door", (0, 0, 10, 10), 100.0, 8.0, 20.0, 5.0,
    ) is False
    assert runner.observe(
        "person:front_door", (0, 0, 10, 10), 101.0, 8.0, 20.0, 5.0,
    ) is False

    assert runner.errors == 2
    assert len(warnings) == 1
    assert "shadow presence failed (errors=1): RuntimeError: shadow boom" in warnings[0]
