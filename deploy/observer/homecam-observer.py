#!/usr/bin/env python3
"""Independent HomeCam reachability observer for a non-Jetson host.

Run this on a router, NAS, or always-on computer. It probes both configured
origins and sends a small generic webhook only on confirmed offline/recovery
transitions. No HomeCam cookie, frame, event id, or recording leaves the LAN.
"""
from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Optional, Tuple

URLS = [value.rstrip("/") for value in os.getenv("HOMECAM_OBSERVER_URLS", "").split(",") if value.strip()]
WEBHOOK = os.getenv("HOMECAM_OBSERVER_WEBHOOK", "").strip()
STATE_PATH = Path(os.getenv("HOMECAM_OBSERVER_STATE", "~/.local/state/homecam-observer.json")).expanduser()
INTERVAL_S = max(15, int(os.getenv("HOMECAM_OBSERVER_INTERVAL_S", "30")))


def reachable(base: str) -> bool:
    try:
        request = urllib.request.Request(base + "/healthz", headers={"Accept": "application/json"})
        with urllib.request.urlopen(request, timeout=5) as response:
            return response.status == 200
    except (OSError, urllib.error.URLError, ValueError):
        return False


def notify(state: str) -> None:
    if not WEBHOOK:
        return
    body = json.dumps({"v": 1, "system": "HomeCam", "state": state, "ts": int(time.time())}).encode()
    request = urllib.request.Request(WEBHOOK, data=body, headers={"Content-Type": "application/json"}, method="POST")
    try:
        urllib.request.urlopen(request, timeout=8).close()
    except (OSError, urllib.error.URLError, ValueError):
        pass


def read_state() -> dict:
    try:
        value = json.loads(STATE_PATH.read_text())
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}


def write_state(value: dict) -> None:
    STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    temp = STATE_PATH.with_suffix(".tmp")
    temp.write_text(json.dumps(value, separators=(",", ":")))
    os.chmod(temp, 0o600)
    temp.replace(STATE_PATH)


def transition(failures: int, offline: bool, ok: bool) -> Tuple[int, bool, Optional[str]]:
    """Apply two-probe hysteresis and return an optional notification state."""
    if ok:
        return 0, False, "recovered" if offline else None
    failures += 1
    if failures >= 2 and not offline:
        return failures, True, "offline"
    return failures, offline, None


def main() -> int:
    if not URLS:
        raise SystemExit("HOMECAM_OBSERVER_URLS must contain at least one private HomeCam origin")
    state = read_state()
    failures = int(state.get("failures", 0))
    offline = bool(state.get("offline", False))
    while True:
        ok = any(reachable(url) for url in URLS)
        now = int(time.time())
        failures, offline, notification = transition(failures, offline, ok)
        if notification:
            notify(notification)
        write_state({"v": 1, "checked_at": now, "reachable": ok, "failures": failures, "offline": offline})
        time.sleep(INTERVAL_S)


if __name__ == "__main__":
    raise SystemExit(main())
