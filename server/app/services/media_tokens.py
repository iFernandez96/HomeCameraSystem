"""Short-lived, one-use grants for MediaMTX WebRTC sessions.

Only SHA-256 digests are retained in memory. Raw bearer values are returned to
the authenticated caller once and are never persisted or logged.
"""
from __future__ import annotations

import hashlib
import secrets
import threading
import time
from dataclasses import dataclass
from typing import Literal

MediaAction = Literal["publish", "read"]
MediaPath = str

TOKEN_TTL_S = 60.0
MAX_OUTSTANDING_TOKENS = 128
_LOCK = threading.Lock()


@dataclass(frozen=True)
class _Grant:
    action: MediaAction
    path: MediaPath
    expires_ts: float


_GRANTS: dict[str, _Grant] = {}


class MediaTokenUnavailable(RuntimeError):
    pass


def _digest(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _purge_expired(now: float) -> None:
    for digest, grant in list(_GRANTS.items()):
        if grant.expires_ts <= now:
            _GRANTS.pop(digest, None)


def issue(
    action: MediaAction,
    path: MediaPath,
    *,
    now: float | None = None,
) -> tuple[str, float]:
    """Issue one opaque bearer grant, bounded to sixty seconds."""
    current = time.time() if now is None else float(now)
    with _LOCK:
        _purge_expired(current)
        if len(_GRANTS) >= MAX_OUTSTANDING_TOKENS:
            raise MediaTokenUnavailable("too many outstanding media grants")
        # token_urlsafe's alphabet deliberately excludes ':'; MediaMTX v1.18
        # otherwise interprets a Bearer value containing ':' as user/password.
        token = secrets.token_urlsafe(32)
        expires_ts = current + TOKEN_TTL_S
        _GRANTS[_digest(token)] = _Grant(action, path, expires_ts)
        return token, expires_ts


def consume(
    token: str,
    action: MediaAction,
    path: MediaPath,
    *,
    now: float | None = None,
) -> bool:
    """Atomically validate and consume a correctly scoped bearer grant."""
    if not token or len(token) > 256:
        return False
    current = time.time() if now is None else float(now)
    digest = _digest(token)
    with _LOCK:
        _purge_expired(current)
        grant = _GRANTS.get(digest)
        if (
            grant is None
            or grant.action != action
            or grant.path != path
            or grant.expires_ts <= current
        ):
            return False
        _GRANTS.pop(digest, None)
        return True


def reset_for_tests() -> None:
    with _LOCK:
        _GRANTS.clear()
