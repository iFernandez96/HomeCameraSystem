"""Minimal sd_notify client — systemd service liveness, no dependencies.

Used so the detection worker can run under `Type=notify` + `WatchdogSec=`:
the worker sends READY=1 once it's actually up (model loaded + camera open),
then WATCHDOG=1 on every main-loop iteration. If the LOOP hangs (a true
deadlock — distinct from a capture wedge, which the escalating
mediamtx_watchdog already handles), the pings stop and systemd restarts the
unit. Persisted watchdog escalation state means the restart resumes recovery.

Pure stdlib socket — no `python-systemd` dependency (JetPack 4.x has none) and
nothing to import on the dev host. A no-op when `$NOTIFY_SOCKET` is unset (run
outside systemd, in tests, or on the dev machine), so callers can ping
unconditionally.

Must stay Python-3.6 compatible (JetPack 4.x host). No f-strings that matter,
PEP-604 unions, walrus, or match.
"""
import logging
import os
import socket

log = logging.getLogger(__name__)

# Cache the resolved socket address once; None means "not under systemd notify"
# (or setup failed) → every call is a cheap no-op.
_addr = None
_resolved = False


def _resolve():
    global _addr, _resolved
    _resolved = True
    raw = os.environ.get("NOTIFY_SOCKET")
    if not raw:
        return
    # systemd uses an abstract namespace socket when the path starts with '@'.
    if raw.startswith("@"):
        _addr = "\0" + raw[1:]
    else:
        _addr = raw


def _send(state):
    """Best-effort datagram to the notify socket. Never raises — a liveness
    ping must not be able to crash the worker it's protecting."""
    if not _resolved:
        _resolve()
    if _addr is None:
        return False
    sock = None
    try:
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
        sock.sendto(state.encode("utf-8"), _addr)
        return True
    except (OSError, socket.error) as e:
        # Log once-ish at DEBUG — a failed ping is non-fatal (systemd will
        # restart on the missed watchdog, which is the intended fallback).
        log.debug("sd_notify %r failed: %s", state, e)
        return False
    finally:
        if sock is not None:
            try:
                sock.close()
            except OSError:
                pass


def ready():
    """Tell systemd the service finished starting (Type=notify). Sending this
    only AFTER the model + camera are up means the long TRT load doesn't count
    against WatchdogSec."""
    return _send("READY=1")


def watchdog():
    """Keep-alive ping (WATCHDOG=1). Call once per main-loop iteration."""
    return _send("WATCHDOG=1")


def enabled():
    """True when running under a systemd notify socket."""
    if not _resolved:
        _resolve()
    return _addr is not None
