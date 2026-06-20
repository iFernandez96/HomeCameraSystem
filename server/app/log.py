"""Shared logging helpers for the FastAPI server (in-container, py3.11).

Convention (see docs/logging_plan.md):
  * The root handler is configured once in ``main.py`` (level from the
    ``HOMECAM_LOG_LEVEL`` env var). Each module does
    ``log = logging.getLogger(__name__)``.
  * Use ``%s`` lazy interpolation, NEVER f-strings — so level-gating
    actually skips the string formatting when the level is disabled,
    and so the shape matches the py3.6 detection worker's habit.
  * Reserve ``.error()`` / ``.exception()`` for genuine 500-class
    failures (DB read failed, write OSError, startup-step abort, ZIP
    build crash). Use ``.warning()`` for security-relevant rejections
    (auth / RBAC) and degraded-but-handled paths. Pass
    ``exc_info=True`` (or use ``.exception()``) whenever an exception
    object is in scope and the failure is unexpected.

These helpers are optional sugar to keep the high-frequency shapes
(auth rejections, once-per-process warnings) consistent across modules.
"""
import logging
import time


def auth_rejected(logger, method, path, reason, sub=None, cookie_present=None):
    """Emit the standard WARNING line for an auth/RBAC rejection.

    Tailnet exposure makes auth-rejection a security signal, so these
    stay at WARNING (survives a production WARNING level).

    NEVER pass token / cookie bytes or passwords as ``reason`` — pass a
    short reason token ("no cookie", "expired", "kind mismatch",
    "role denied", "user row gone"). ``sub`` is the subject claim (a
    username, already in the DB — safe to log); ``cookie_present`` is a
    bool so "server down" vs "no session" vs "bad session" are
    distinguishable.
    """
    logger.warning(
        "auth rejected on %s %s: %s (sub=%r cookie_present=%s)",
        method,
        path,
        reason,
        sub,
        cookie_present,
    )


class RateLimitedLog:
    """A once-per-window log gate for hot paths, mirroring the
    ``event_bus._sub_overflow_warned`` / ``push_service._persist_warned``
    once-flag idiom but with a re-arm window so a *sustained* failure
    is not a single line then silence.

    Usage::

        _persist_gate = RateLimitedLog(60.0)
        if _persist_gate.should_log():
            log.warning("events_db persist failed on %s: %s", path, exc)

    Not thread-safe to the millisecond; the worst case under a race is
    one extra line, which is harmless for a log gate.

    `clock` is injectable (defaults to ``time.monotonic``) so tests can
    drive a fake clock WITHOUT monkeypatching the global ``time``
    module — patching ``time.monotonic`` globally corrupts asyncio's
    event-loop clock and breaks every subsequent async test.
    """

    def __init__(self, window_s, clock=time.monotonic):
        self._window_s = window_s
        self._clock = clock
        self._last = 0.0

    def should_log(self):
        now = self._clock()
        if now - self._last >= self._window_s:
            self._last = now
            return True
        return False
