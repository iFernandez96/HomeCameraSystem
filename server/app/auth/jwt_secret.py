"""HS256 JWT signing secret — load-or-generate (iter-178, Auth Plan Phase 1).

The secret is 32 cryptographically-random bytes stored at
`settings.jwt_secret_path` (default `/app/secrets/jwt_secret.bin` in
the container, sharing the `homecam-secrets` Docker volume with VAPID
+ push_subs + detection_config). Phase 3's `tokens.py` will load via
`load_or_generate(...)` once at module import and keep the bytes in
memory for the process lifetime; Phase 7 documents that
`rm /app/secrets/jwt_secret.bin && docker compose restart server`
regenerates the secret and invalidates all sessions (the operator's
hard logout / kill-switch).

Mirrors the iter-170 VAPID tolerant-load pattern:
- Missing file: generate, write atomically, chmod 0o600, log info.
- Unreadable file (permission flip, half-mounted volume): log warn,
  generate fresh, write. The lifespan continues — auth becomes
  unavailable but the rest of the server starts.
- Wrong-size file (corrupted, truncated): log warn, regenerate.
- Healthy file: read, return.

Atomic write via `.tmp` + `os.replace`, mirrors push_subs / VAPID
patterns. Mode 0o600 set BEFORE the rename (iter-169 Security S1
chmod-after-replace race fix lives here too — write the temp file
0o600, then atomic-rename in place).
"""
from __future__ import annotations

import logging
import os
import secrets
from pathlib import Path


log = logging.getLogger(__name__)


# 32 bytes = 256 bits of entropy = HS256 key length recommended by
# RFC 7518 §3.2 ("the size of the HMAC key MUST be at least the size
# of the underlying hash function output, which is 32 bytes for SHA-
# 256"). We don't go higher because PyJWT silently truncates anyway.
_SECRET_LEN = 32


def load_or_generate(path: Path) -> bytes:
    """Return the JWT signing secret, regenerating on the path if
    missing or unhealthy. Caller is expected to call this ONCE at
    module import (Phase 3 `tokens.py`); subsequent calls re-read
    the file — fine for tests, wasteful in prod. The bytes are NOT
    cached here.

    Never raises. On unrecoverable filesystem errors (parent dir
    can't be created, write fails after retry), logs a warning and
    returns a freshly-generated in-memory secret — auth tokens
    issued during that session will work but won't survive a
    container restart. Operator can fix the disk situation and
    restart later.
    """
    if path.exists():
        try:
            data = path.read_bytes()
        except OSError as e:
            log.warning(
                "JWT secret at %s exists but unreadable (%s: %s) — "
                "regenerating; ALL active sessions invalidated (every "
                "issued token now fails signature verification, forcing "
                "a re-login)",
                path,
                type(e).__name__,
                e,
            )
            return _generate_and_write(path)
        if len(data) == _SECRET_LEN:
            return data
        log.warning(
            "JWT secret at %s has wrong size (%d bytes; expected %d) — "
            "regenerating; ALL active sessions invalidated (every issued "
            "token now fails signature verification, forcing a re-login)",
            path,
            len(data),
            _SECRET_LEN,
        )
    return _generate_and_write(path)


def rotate(path: Path) -> bytes:
    """Persist a fresh secret or fail instead of claiming invalidation.

    Restore uses this stricter seam: an in-memory-only key would invalidate
    tokens for one process but silently change again on restart, so successful
    recovery requires the new key bytes to be durable before it returns.
    """
    new_secret = _generate_and_write(path)
    try:
        persisted = path.read_bytes()
    except OSError as exc:
        raise OSError("rotated JWT secret could not be read back") from exc
    if persisted != new_secret or len(persisted) != _SECRET_LEN:
        raise OSError("rotated JWT secret did not persist atomically")
    return new_secret


def _generate_and_write(path: Path) -> bytes:
    """Mint a fresh 32-byte secret, atomically write it 0o600.
    Returns the bytes regardless of whether the write succeeded — a
    failed write is logged but not fatal so the server still boots
    (the in-memory secret is valid for this process's lifetime).
    """
    new_secret = secrets.token_bytes(_SECRET_LEN)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(path.suffix + ".tmp")
        # Open with mode 0o600 from the start to avoid the
        # chmod-after-write race (iter-169 Security S1 finding).
        # `os.open(...)` lets us pass mode in the create call.
        fd = os.open(
            tmp,
            os.O_WRONLY | os.O_CREAT | os.O_TRUNC,
            0o600,
        )
        try:
            os.write(fd, new_secret)
        finally:
            os.close(fd)
        os.replace(tmp, path)
        log.info("JWT secret generated at %s", path)
    except OSError as e:
        log.warning(
            "JWT secret write to %s failed (%s: %s) — using in-memory "
            "secret for this process; tokens won't survive restart, and "
            "the NEXT restart will mint yet another secret, invalidating "
            "ALL active sessions (forced re-login). Fix the disk/perms "
            "and restart to make the secret durable",
            path,
            type(e).__name__,
            e,
        )
    return new_secret
