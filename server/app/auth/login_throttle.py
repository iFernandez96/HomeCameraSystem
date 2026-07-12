"""Bounded, application-level throttling for password login attempts.

This is deliberately scoped to ``POST /api/auth/login`` rather than a global
rate-limiting middleware.  The deployment has several high-frequency internal
and media-control routes where a generic limiter would be both dangerous and
misleading.  Login is the abuse boundary that performs an expensive Argon2
verification, so it gets a small in-process gate keyed by normalized username
and the trusted socket peer address.

The table is bounded to prevent an unauthenticated caller from growing server
memory without limit.  State is intentionally process-local: a restart clears
backoff rather than risking a persistent lockout of the household owner.
"""
from __future__ import annotations

import math
import time
from collections import OrderedDict, deque
from dataclasses import dataclass, field
from typing import Callable, Deque


@dataclass
class _Entry:
    failures: Deque[float] = field(default_factory=deque)
    blocked_until: float = 0.0


class LoginThrottle:
    def __init__(
        self,
        *,
        failure_limit: int = 5,
        window_s: float = 300.0,
        base_block_s: float = 2.0,
        max_block_s: float = 60.0,
        max_keys: int = 2048,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        if failure_limit < 1 or max_keys < 1:
            raise ValueError("failure_limit and max_keys must be positive")
        self._failure_limit = failure_limit
        self._window_s = window_s
        self._base_block_s = base_block_s
        self._max_block_s = max_block_s
        self._max_keys = max_keys
        self._clock = clock
        self._entries: OrderedDict[tuple[str, str], _Entry] = OrderedDict()

    @staticmethod
    def _key(username: str, remote_addr: str | None) -> tuple[str, str]:
        return (username.strip().casefold(), remote_addr or "?")

    def _prune_entry(self, entry: _Entry, now: float) -> None:
        cutoff = now - self._window_s
        while entry.failures and entry.failures[0] <= cutoff:
            entry.failures.popleft()
        if entry.blocked_until <= now and not entry.failures:
            entry.blocked_until = 0.0

    def retry_after(self, username: str, remote_addr: str | None) -> int:
        """Return whole seconds until another password attempt is allowed."""
        key = self._key(username, remote_addr)
        entry = self._entries.get(key)
        if entry is None:
            return 0
        now = self._clock()
        self._prune_entry(entry, now)
        if not entry.failures and entry.blocked_until <= now:
            self._entries.pop(key, None)
            return 0
        self._entries.move_to_end(key)
        return max(0, int(math.ceil(entry.blocked_until - now)))

    def record_failure(self, username: str, remote_addr: str | None) -> None:
        key = self._key(username, remote_addr)
        now = self._clock()
        entry = self._entries.get(key)
        if entry is None:
            if len(self._entries) >= self._max_keys:
                self._entries.popitem(last=False)
            entry = _Entry()
            self._entries[key] = entry
        self._prune_entry(entry, now)
        entry.failures.append(now)
        self._entries.move_to_end(key)
        excess = len(entry.failures) - self._failure_limit
        if excess >= 0:
            block_s = min(self._max_block_s, self._base_block_s * (2 ** excess))
            entry.blocked_until = max(entry.blocked_until, now + block_s)

    def record_success(self, username: str, remote_addr: str | None) -> None:
        self._entries.pop(self._key(username, remote_addr), None)

    def clear(self) -> None:
        """Test/reset seam. Production normally lets entries expire."""
        self._entries.clear()

