"""Pure session revocation and last-seen throttle decisions."""
from __future__ import annotations


DEFAULT_LAST_SEEN_THROTTLE_S = 60.0


def is_revoked(jti: str, revoked_ts: float | None, now: float) -> bool:
    """Return whether a revocation timestamp is currently in effect."""
    return revoked_ts is not None and revoked_ts <= now


def should_write_last_seen(
    prev_last_seen: float,
    now: float,
    throttle_s: float = DEFAULT_LAST_SEEN_THROTTLE_S,
) -> bool:
    """Return whether a last-seen write has passed the throttle window."""
    return now - prev_last_seen >= throttle_s

