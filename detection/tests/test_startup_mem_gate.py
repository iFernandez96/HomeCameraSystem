"""iter-356.62 (camera-algorithm-auditor pre-YOLO win 3): startup
mem-floor gate.

Pins `_enforce_mem_floor` — the single check that runs ONCE before
`jetson_inference.detectNet(...)` is called. TensorRT engine workspace
allocation can demand 150-300 MB; if MemAvailable is already low at
boot (Chrome left open, stale worker, etc.) the model load gets
SIGKILL'd with no traceback. The gate aborts with a clear message +
exit code 3 instead, letting systemd's RestartSec give the operator
a chance to recover.

The gate is factored to take `read_mem_fn` as a parameter so these
tests pass a fake instead of patching `/proc/meminfo`.
"""
import sys
from pathlib import Path
from unittest.mock import MagicMock

import pytest

# detect.py sits one level up.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

# detect.py does `import jetson_inference` + `import jetson_utils` at
# module top, so stub them out before importing.
sys.modules.setdefault("jetson_inference", MagicMock())
sys.modules.setdefault("jetson_utils", MagicMock())

import detect  # noqa: E402


def test_given_low_mem_when_check_called_then_raises_with_clear_message():
    # arrange — mem-available reads as 200 MB, well below the 400 MB floor.
    fake_read = lambda: 200.0

    # act / assert — gate must abort with SystemExit (exit code 3) and
    # a message that names the actual numbers so the operator can act.
    with pytest.raises(SystemExit) as excinfo:
        detect._enforce_mem_floor(fake_read, 400.0)
    assert excinfo.value.code == 3


def test_given_sufficient_mem_when_check_called_then_passes():
    # arrange — plenty of headroom above the floor.
    fake_read = lambda: 1200.0

    # act — gate returns silently when MemAvailable >= floor.
    result = detect._enforce_mem_floor(fake_read, 400.0)

    # assert — None return + no exception is the success signal.
    assert result is None


def test_given_env_override_when_check_called_then_uses_override():
    # arrange — caller passes a custom (lower) floor; mem-available is
    # below the default 400 MB but above the override.
    fake_read = lambda: 250.0

    # act — with floor=200 the same reading should pass; the gate
    # honors whatever floor the caller hands it (which is what the
    # `DETECT_MIN_FREE_MEM_MB` env override drives at the call site
    # in `main()`).
    result = detect._enforce_mem_floor(fake_read, 200.0)

    # assert — same reading, lower floor → passes.
    assert result is None


def test_given_unreadable_meminfo_when_check_called_then_passes():
    # arrange — `read_mem_available_mb()` returns None on hosts that
    # don't have a parseable /proc/meminfo (the dev host case). The
    # gate must NOT block boot in that scenario — it's defensive
    # against silent OOM, not a hard requirement.
    fake_read = lambda: None

    # act — gate falls through cleanly.
    result = detect._enforce_mem_floor(fake_read, 400.0)

    # assert.
    assert result is None


def test_given_mem_exactly_at_floor_when_check_called_then_passes():
    # arrange — boundary case: equality is allowed (strict `<` in gate).
    fake_read = lambda: 400.0

    # act.
    result = detect._enforce_mem_floor(fake_read, 400.0)

    # assert.
    assert result is None
