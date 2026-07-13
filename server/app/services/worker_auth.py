"""File-backed authentication for the host-side detection workers."""
from __future__ import annotations

import hmac
import logging
import re
from pathlib import Path
from typing import NoReturn

from fastapi import Request

from ..config import settings
from ..log import RateLimitedLog
from .internal_peer import has_proxy_marker, peer_class, trusted_peer


log = logging.getLogger(__name__)
_SECRET_RE = re.compile(rb"^[0-9a-f]{64}$")
_secret: bytes | None = None
_AUTH_LOG_GATES = {
    category: RateLimitedLog(60.0)
    for category in (
        "untrusted_peer",
        "proxied",
        "missing",
        "malformed",
        "invalid",
        "unconfigured",
    )
}


class WorkerAuthRejected(Exception):
    def __init__(self, status_code: int):
        super().__init__(status_code)
        self.status_code = status_code


def load_secret(path: Path | None = None) -> bool:
    """Load the configured secret once. Failure disables worker routes only."""
    global _secret
    secret_path = path or settings.worker_auth_secret_path
    try:
        with secret_path.open("rb") as handle:
            raw = handle.read(67)
    except OSError as exc:
        _secret = None
        log.error(
            "worker authentication unavailable: category=unconfigured error_type=%s",
            type(exc).__name__,
        )
        return False
    if raw.endswith(b"\r\n"):
        candidate = raw[:-2]
    elif raw.endswith(b"\n"):
        candidate = raw[:-1]
    else:
        candidate = raw
    if len(raw) > 66 or _SECRET_RE.fullmatch(candidate) is None:
        _secret = None
        log.error("worker authentication unavailable: category=unconfigured error_type=invalid_secret")
        return False
    _secret = candidate
    return True


def reset_for_tests(secret: bytes | None = None) -> None:
    global _secret
    _secret = secret


def _reject(request: Request, category: str, status_code: int) -> NoReturn:
    gate = _AUTH_LOG_GATES[category]
    if gate.should_log():
        peer = request.client.host if request.client is not None else ""
        log.warning(
            "worker authentication rejected: method=%s route=%s source=%s category=%s",
            request.method,
            request.url.path,
            peer_class(peer, settings.worker_auth_trusted_callers),
            category,
        )
    raise WorkerAuthRejected(status_code)


async def require_worker(request: Request) -> None:
    """Require a direct host peer and one exact bearer credential."""
    peer = request.client.host if request.client is not None else ""
    if has_proxy_marker(request.headers):
        _reject(request, "proxied", 403)
    if not trusted_peer(peer, settings.worker_auth_trusted_callers):
        _reject(request, "untrusted_peer", 403)
    if _secret is None:
        _reject(request, "unconfigured", 503)

    values = request.headers.getlist("authorization")
    if not values:
        _reject(request, "missing", 401)
    if len(values) != 1:
        _reject(request, "malformed", 401)
    parts = values[0].split(" ", 1)
    if len(parts) != 2 or parts[0].lower() != "bearer":
        _reject(request, "malformed", 401)
    try:
        candidate = parts[1].encode("ascii")
    except UnicodeEncodeError:
        _reject(request, "malformed", 401)
    if _SECRET_RE.fullmatch(candidate) is None:
        _reject(request, "malformed", 401)
    if not hmac.compare_digest(candidate, _secret):
        _reject(request, "invalid", 401)
