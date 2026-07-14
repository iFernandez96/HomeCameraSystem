from __future__ import annotations

import importlib.util
from pathlib import Path


def _observer():
    path = Path(__file__).resolve().parents[2] / "deploy/observer/homecam-observer.py"
    spec = importlib.util.spec_from_file_location("homecam_observer", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_observer_requires_two_failures_and_notifies_each_transition_once():
    observer = _observer()

    assert observer.transition(0, False, False) == (1, False, None)
    assert observer.transition(1, False, False) == (2, True, "offline")
    assert observer.transition(2, True, False) == (3, True, None)
    assert observer.transition(3, True, True) == (0, False, "recovered")
    assert observer.transition(0, False, True) == (0, False, None)
