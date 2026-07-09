"""JWT issue + decode helpers (iter-181, Auth Plan Phase 3).

Two token kinds:

- ``access``  — short TTL (``settings.access_token_ttl_s``, default
                15 min). Carried in the ``homecam_access`` cookie;
                consumed by ``/api/auth/me`` today, by every
                gated ``/api/*`` route from Phase 5 (iter-183).
- ``refresh`` — long TTL (``settings.refresh_token_ttl_s``, default
                7 days). Carried in the ``homecam_refresh`` cookie;
                consumed only by ``/api/auth/refresh`` to mint a
                fresh access token (and a fresh refresh, sliding
                window).

Both signed HS256 with the secret loaded via
``jwt_secret.load_or_generate(settings.jwt_secret_path)``. The
secret is read at every issue/decode rather than cached at module
import — fast (~0.1 ms file read on Jetson eMMC) and side-steps
the test-isolation footgun where one test's tmp_path secret would
poison another test's decode. Login isn't a hot path; this trade
is fine.

Claims:

- ``sub``  — username (string)
- ``kind`` — ``'access'`` or ``'refresh'``; pinned so a refresh
             token can't be presented as an access token (and vice
             versa).
- ``iat``  — issued-at (int unix seconds)
- ``exp``  — expires-at (int unix seconds)
- ``jti``  — opaque unique token id used by the sessions store; the
             JWT bytes themselves are never stored.

A wrong-kind token decodes successfully at the PyJWT level (its
signature is valid), so ``decode`` re-checks ``kind`` itself and
raises ``InvalidToken``. Callers map that to 401.

The hard-logout escape hatch documented in ``auth_plan_iter177.md``
is ``rm /app/secrets/jwt_secret.bin && docker compose restart
server`` — a fresh secret invalidates every issued token in one
shot. No server-side blocklist (per the plan's Section 3
anti-rec #21).
"""
from __future__ import annotations

import logging
import time
import uuid
from typing import Literal

import jwt

from ..config import settings
from . import jwt_secret


log = logging.getLogger(__name__)


_ALGORITHM = "HS256"

TokenKind = Literal["access", "refresh"]


class InvalidToken(Exception):
    """Raised on any decode failure: bad signature, expired, missing
    or wrong ``kind``, malformed JSON. Caller maps to 401."""


def _get_secret() -> bytes:
    return jwt_secret.load_or_generate(settings.jwt_secret_path)


def issue(
    username: str,
    kind: TokenKind,
    *,
    role: str = "admin",
    now: float | None = None,
    jti: str | None = None,
) -> str:
    """Mint a token with the configured TTL for its kind. ``now`` is
    a test seam — production callers omit it and we use ``time.time()``.

    iter-192 (Feature #3 RBAC foundation): ``role`` is now part of the
    claims. The login route passes ``role=user["role"]`` from the
    users_db row; ``decode`` returns it on the claims dict; future
    iters add a ``require_role(role)`` dep factory that gates
    specific routes (control/* → owner; events read → family OK).
    Default ``"admin"`` matches today's seeded users so iter-192 is
    backwards-compatible: existing tokens without a ``role`` claim
    are treated as admin via ``claims.get('role', 'admin')`` at the
    consumer site.
    """
    if now is None:
        now = time.time()
    iat = int(now)
    if kind == "access":
        ttl = settings.access_token_ttl_s
    elif kind == "refresh":
        ttl = settings.refresh_token_ttl_s
    else:
        raise ValueError("unknown token kind: {!r}".format(kind))
    payload = {
        "sub": username,
        "kind": kind,
        "role": role,
        "iat": iat,
        "exp": iat + ttl,
        "jti": jti if jti is not None else uuid.uuid4().hex,
    }
    return jwt.encode(payload, _get_secret(), algorithm=_ALGORITHM)


def decode(token: str, *, kind: TokenKind) -> dict:
    """Verify signature + expiry, then enforce ``kind``. Returns the
    claims dict on success; raises ``InvalidToken`` on any failure.

    PyJWT raises ``ExpiredSignatureError`` on expiry and
    ``InvalidTokenError`` on signature/format problems — both
    inherit from ``InvalidTokenError`` so the single ``except`` here
    catches the lot.
    """
    try:
        claims = jwt.decode(token, _get_secret(), algorithms=[_ALGORITHM])
    except jwt.ExpiredSignatureError as e:
        # Most benign + most common decode failure (idle session past
        # TTL). DEBUG so triage can see it without noise at INFO. The
        # *type name* is the discriminator (expired vs bad-sig vs
        # malformed) — never log the token bytes themselves.
        log.debug(
            "token decode rejected: expired (%s) [expected kind=%s]",
            type(e).__name__,
            kind,
        )
        raise InvalidToken(str(e)) from e
    except jwt.InvalidTokenError as e:
        # Bad signature / malformed structure / unknown alg. DEBUG the
        # PyJWT exception TYPE so an operator triaging at DEBUG can tell
        # a tampered/forged token (InvalidSignatureError) apart from a
        # truncated one (DecodeError). Token bytes are NEVER logged.
        log.debug(
            "token decode rejected: %s [expected kind=%s]",
            type(e).__name__,
            kind,
        )
        raise InvalidToken(str(e)) from e
    if claims.get("kind") != kind:
        # Signature is VALID but the kind claim is wrong — a refresh
        # token presented as access (or vice versa). PyJWT considers
        # this token "valid"; this branch is the load-bearing re-check
        # (pinned by test_decode_rejects_kind_mismatch_*). It is the
        # anomalous case (a correctly-signed token used in the wrong
        # slot), so WARN — `sub` is safe to log (a username already in
        # the DB); the token bytes are not.
        log.warning(
            "token kind mismatch: got %r expected %r (sub=%r)",
            claims.get("kind"),
            kind,
            claims.get("sub"),
        )
        raise InvalidToken("token kind mismatch (expected {!r})".format(kind))
    return claims
