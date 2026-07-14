"""TOTP and one-use recovery codes for privileged HomeCam accounts."""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
import sqlite3
import struct
import threading
import time
from pathlib import Path
from urllib.parse import quote

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from ..config import settings


_SCHEMA = """
CREATE TABLE IF NOT EXISTS user_mfa (
    username        TEXT PRIMARY KEY,
    secret_cipher   TEXT NOT NULL,
    recovery_hashes TEXT NOT NULL,
    enabled_at      REAL NOT NULL
);
"""
_pending: dict[str, dict] = {}
_pending_lock = threading.Lock()
_key_lock = threading.Lock()
_PENDING_TTL_S = 10 * 60


def init_db(path: Path) -> None:
    with sqlite3.connect(path) as conn:
        conn.executescript(_SCHEMA)
        conn.commit()


def _key() -> bytes:
    with _key_lock:
        path = settings.mfa_key_path
        try:
            value = path.read_bytes()
            if len(value) == 32:
                return value
        except OSError:
            pass
        value = secrets.token_bytes(32)
        path.parent.mkdir(parents=True, exist_ok=True)
        temp = path.with_suffix(path.suffix + ".tmp")
        fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        try:
            os.write(fd, value)
            os.fsync(fd)
        finally:
            os.close(fd)
        os.replace(temp, path)
        return value


def _encrypt(username: str, secret: str) -> str:
    nonce = secrets.token_bytes(12)
    cipher = AESGCM(_key()).encrypt(nonce, secret.encode("ascii"), username.encode("utf-8"))
    return base64.urlsafe_b64encode(nonce + cipher).decode("ascii")


def _decrypt(username: str, value: str) -> str | None:
    try:
        raw = base64.urlsafe_b64decode(value.encode("ascii"))
        plain = AESGCM(_key()).decrypt(raw[:12], raw[12:], username.encode("utf-8"))
        return plain.decode("ascii")
    except Exception:
        return None


def _recovery_hash(code: str) -> str:
    normalized = code.replace("-", "").strip().upper().encode("ascii", "ignore")
    return hmac.new(_key(), b"recovery\0" + normalized, hashlib.sha256).hexdigest()


def generate_setup(username: str, now: float | None = None) -> dict:
    now = time.time() if now is None else now
    secret = base64.b32encode(secrets.token_bytes(20)).decode("ascii").rstrip("=")
    recovery_codes = [
        "{}-{}".format(code[:6], code[6:])
        for code in (
            base64.b32encode(secrets.token_bytes(8)).decode("ascii").rstrip("=")[:12]
            for _ in range(8)
        )
    ]
    with _pending_lock:
        _pending[username] = {
            "secret": secret,
            "recovery_hashes": [_recovery_hash(code) for code in recovery_codes],
            "expires_at": now + _PENDING_TTL_S,
        }
    return {
        "secret": secret,
        "provisioning_uri": "otpauth://totp/HomeCam:{}?secret={}&issuer=HomeCam".format(
            quote(username, safe=""), secret,
        ),
        "recovery_codes": recovery_codes,
        "expires_in_s": _PENDING_TTL_S,
    }


def _totp(secret: str, counter: int, digits: int = 6) -> str:
    padded = secret + "=" * ((8 - len(secret) % 8) % 8)
    key = base64.b32decode(padded.encode("ascii"), casefold=True)
    digest = hmac.new(key, struct.pack(">Q", counter), hashlib.sha1).digest()
    offset = digest[-1] & 0x0F
    value = struct.unpack(">I", digest[offset:offset + 4])[0] & 0x7FFFFFFF
    return str(value % (10 ** digits)).zfill(digits)


def verify_totp(secret: str, code: str, now: float | None = None) -> bool:
    if not isinstance(code, str) or len(code.strip()) != 6 or not code.strip().isdigit():
        return False
    now = time.time() if now is None else now
    counter = int(now // 30)
    return any(
        hmac.compare_digest(_totp(secret, counter + drift), code.strip())
        for drift in (-1, 0, 1)
    )


def confirm_setup(path: Path, username: str, code: str, now: float | None = None) -> bool:
    now = time.time() if now is None else now
    with _pending_lock:
        row = _pending.get(username)
        if row is None or row["expires_at"] < now:
            _pending.pop(username, None)
            return False
        if not verify_totp(row["secret"], code, now):
            return False
        _pending.pop(username, None)
    init_db(path)
    with sqlite3.connect(path) as conn:
        conn.execute(
            "INSERT OR REPLACE INTO user_mfa "
            "(username, secret_cipher, recovery_hashes, enabled_at) VALUES (?, ?, ?, ?)",
            (
                username,
                _encrypt(username, row["secret"]),
                json.dumps(row["recovery_hashes"], separators=(",", ":")),
                now,
            ),
        )
        conn.commit()
    return True


def enabled(path: Path, username: str) -> bool:
    init_db(path)
    with sqlite3.connect(path) as conn:
        row = conn.execute(
            "SELECT 1 FROM user_mfa WHERE username = ?", (username,)
        ).fetchone()
        return row is not None


def verify_login(path: Path, username: str, code: str, now: float | None = None) -> bool:
    init_db(path)
    with sqlite3.connect(path) as conn:
        # Serialize read-and-consume so the same recovery code cannot win two
        # concurrent login requests before either update commits.
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute(
            "SELECT secret_cipher, recovery_hashes FROM user_mfa WHERE username = ?",
            (username,),
        ).fetchone()
        if row is None:
            return True
        secret = _decrypt(username, row[0])
        if secret is not None and verify_totp(secret, code, now):
            return True
        candidate = _recovery_hash(code)
        try:
            hashes = json.loads(row[1])
        except (TypeError, ValueError):
            hashes = []
        match = next((value for value in hashes if hmac.compare_digest(value, candidate)), None)
        if match is None:
            return False
        hashes.remove(match)
        conn.execute(
            "UPDATE user_mfa SET recovery_hashes = ? WHERE username = ?",
            (json.dumps(hashes, separators=(",", ":")), username),
        )
        conn.commit()
        return True


def disable(path: Path, username: str) -> bool:
    init_db(path)
    with sqlite3.connect(path) as conn:
        cur = conn.execute("DELETE FROM user_mfa WHERE username = ?", (username,))
        conn.commit()
        return cur.rowcount > 0
