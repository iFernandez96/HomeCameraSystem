"""Centralized logging setup for the Jetson-host detection worker.

Python 3.6 compatible (JetPack 4.x): NO f-strings, walrus, PEP-604
unions, PEP-585 generics, `match`, or `from __future__ import
annotations`. Pinned by tests/test_py36_compat.py.

Two logging regimes coexist in the worker (see docs/logging_plan.md):
  * stdlib ``logging`` in the leaf libs (face_recog/recognizer.py,
    face_recog/detector.py, memory_guard.py, thermal_guard.py,
    mediamtx_watchdog.py). Before this module, those records were
    dropped on the floor because detect.py never called basicConfig,
    so the root logger had no handler and `log.warning(...)` went
    nowhere.
  * ``print("[tag] ...", flush=True)`` breadcrumbs in the hot-loop
    modules (detect.py, recording.py, preroll.py, tracks.py) that were
    deliberately kept logger-light to avoid a logging dependency in the
    inference path.

``configure()`` (called first thing in ``detect.py`` ``main()``)
installs a single root handler so BOTH regimes land in journald
(``homecam-detect.service``) with one timestamped format.  ``emit()``
is an EPIPE-safe stdout breadcrumb for the hot-loop modules that stay
logger-light: a broken pipe (journald rotating, or the unit stopping)
must never crash the inference loop.
"""
import logging
import os
import sys

_configured = False


def configure():
    """Install the root logging handler. Idempotent (safe to call more
    than once; only the first call wins). Level comes from the
    ``DETECT_LOG_LEVEL`` env var (default ``INFO``) so an operator can
    flip to ``DEBUG`` during triage without a code change. Call once,
    first thing in ``main()``, BEFORE any worker thread spawns."""
    global _configured
    if _configured:
        return
    level_name = os.getenv("DETECT_LOG_LEVEL", "INFO")
    level = getattr(logging, level_name.upper(), logging.INFO)
    # `stream=sys.stdout` so journald captures it under the systemd
    # unit; basicConfig is a no-op if the root already has handlers,
    # hence the `_configured` guard to make our intent explicit.
    logging.basicConfig(
        level=level,
        format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
        stream=sys.stdout,
    )
    _configured = True


def emit(prefix, msg):
    """EPIPE-safe stdout breadcrumb for the hot-loop modules that stay
    logger-light. Mirrors the historical ``print("[tag] ...",
    flush=True)`` shape but swallows ``OSError`` (broken pipe) so a
    logging call can never crash the inference loop. ``prefix`` is the
    bracket tag (e.g. ``"recording"`` -> ``[recording] ...``)."""
    try:
        print("[" + prefix + "] " + msg, flush=True)
    except OSError:
        # Broken pipe / closed stdout while the unit is stopping. A log
        # line must never be the thing that kills the worker.
        pass


def get_logger(name):
    """Convenience wrapper so call sites import one module. Equivalent
    to ``logging.getLogger(name)``."""
    return logging.getLogger(name)
