"""Bounded external cellular WHEP observer state.

Client reports are authenticated and advisory. They can raise an alert when
the Jetson-local probe is healthy, but this module intentionally has no camera
or recovery dependency: an external-only failure can never restart hardware.
"""
from __future__ import annotations

import threading


_LOCK = threading.Lock()
_STATE: dict[str, float | int | str] = {
    "last_ok_ts": 0.0,
    "last_report_ts": 0.0,
    "ttff_ms": 0.0,
    "consecutive_failures": 0,
    "rung": "",
    "result": "not_reported",
}


def record(rung: str, result: str, observed_at: float, ttff_ms: float = 0.0) -> None:
    with _LOCK:
        _STATE["last_report_ts"] = float(observed_at)
        _STATE["rung"] = rung
        _STATE["result"] = result
        if result == "first_frame":
            _STATE["last_ok_ts"] = float(observed_at)
            _STATE["ttff_ms"] = max(0.0, float(ttff_ms))
            _STATE["consecutive_failures"] = 0
        else:
            _STATE["consecutive_failures"] = min(
                1000, int(_STATE["consecutive_failures"]) + 1
            )


def snapshot() -> dict[str, float | int | str]:
    with _LOCK:
        return dict(_STATE)


def reset_for_tests() -> None:
    with _LOCK:
        _STATE.update({
            "last_ok_ts": 0.0,
            "last_report_ts": 0.0,
            "ttff_ms": 0.0,
            "consecutive_failures": 0,
            "rung": "",
            "result": "not_reported",
        })
