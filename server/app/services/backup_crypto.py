from __future__ import annotations

import hashlib
import os
from pathlib import Path
from typing import Iterable

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import x25519
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.primitives.kdf.hkdf import HKDF


_MAGIC = b"HCBKAE01"
_EPHEMERAL_KEY_BYTES = 32
_NONCE_BYTES = 12
_TAG_BYTES = 16
_HEADER_BYTES = len(_MAGIC) + _EPHEMERAL_KEY_BYTES + _NONCE_BYTES
_CHUNK_BYTES = 1024 * 1024
_KDF_INFO = b"HomeCameraSystem encrypted backup envelope v1"


class BackupCryptoError(RuntimeError):
    """Typed fail-closed error for backup key and envelope failures."""


def generate_recovery_keypair(
    *,
    private_key_path: Path,
    public_key_path: Path,
) -> None:
    """Generate an X25519 recovery pair with a private 0600 key file."""
    if private_key_path.exists() or public_key_path.exists():
        raise FileExistsError("backup recovery key path already exists")
    private_key = x25519.X25519PrivateKey.generate()
    private_payload = private_key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    )
    public_payload = private_key.public_key().public_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    )
    _atomic_write(private_key_path, private_payload, mode=0o600)
    _atomic_write(public_key_path, public_payload, mode=0o644)


def recipient_fingerprint(public_key_path: Path) -> str:
    public_key = _load_public_key(public_key_path)
    raw = public_key.public_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PublicFormat.Raw,
    )
    return hashlib.sha256(raw).hexdigest()


def encrypt_chunks_to_file(
    chunks: Iterable[bytes],
    *,
    recipient_public_key_path: Path,
    output_path: Path,
) -> None:
    """Stream authenticated ciphertext to a private temporary file."""
    recipient = _load_public_key(recipient_public_key_path)
    ephemeral = x25519.X25519PrivateKey.generate()
    ephemeral_public = ephemeral.public_key().public_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PublicFormat.Raw,
    )
    recipient_public = recipient.public_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PublicFormat.Raw,
    )
    nonce = os.urandom(_NONCE_BYTES)
    header = _MAGIC + ephemeral_public + nonce
    key = _derive_key(
        ephemeral.exchange(recipient),
        nonce=nonce,
        ephemeral_public=ephemeral_public,
        recipient_public=recipient_public,
    )
    encryptor = Cipher(algorithms.AES(key), modes.GCM(nonce)).encryptor()
    encryptor.authenticate_additional_data(header)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(
        output_path,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL,
        0o600,
    )
    try:
        _write_all(fd, header)
        for chunk in chunks:
            if not isinstance(chunk, bytes):
                raise TypeError("backup encryption chunks must be bytes")
            if chunk:
                _write_all(fd, encryptor.update(chunk))
        _write_all(fd, encryptor.finalize())
        _write_all(fd, encryptor.tag)
        os.fsync(fd)
    except Exception:
        try:
            os.close(fd)
        finally:
            _unlink_quiet(output_path)
        raise
    else:
        os.close(fd)


def decrypt_file(
    encrypted_path: Path,
    *,
    recovery_private_key_path: Path,
    output_path: Path,
) -> None:
    """Authenticate and stream-decrypt one envelope, deleting failures."""
    private_key = _load_private_key(recovery_private_key_path)
    total_size = encrypted_path.stat().st_size
    if total_size <= _HEADER_BYTES + _TAG_BYTES:
        raise BackupCryptoError("encrypted backup is truncated")

    output_path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(
        output_path,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL,
        0o600,
    )
    try:
        with encrypted_path.open("rb") as source:
            header = source.read(_HEADER_BYTES)
            if len(header) != _HEADER_BYTES or not header.startswith(_MAGIC):
                raise BackupCryptoError("encrypted backup header is invalid")
            ephemeral_raw = header[len(_MAGIC):len(_MAGIC) + _EPHEMERAL_KEY_BYTES]
            nonce = header[-_NONCE_BYTES:]
            source.seek(total_size - _TAG_BYTES)
            tag = source.read(_TAG_BYTES)
            source.seek(_HEADER_BYTES)

            try:
                ephemeral_public = x25519.X25519PublicKey.from_public_bytes(
                    ephemeral_raw
                )
            except ValueError as exc:
                raise BackupCryptoError("encrypted backup recipient header is invalid") from exc
            recipient_public = private_key.public_key().public_bytes(
                encoding=serialization.Encoding.Raw,
                format=serialization.PublicFormat.Raw,
            )
            key = _derive_key(
                private_key.exchange(ephemeral_public),
                nonce=nonce,
                ephemeral_public=ephemeral_raw,
                recipient_public=recipient_public,
            )
            decryptor = Cipher(
                algorithms.AES(key),
                modes.GCM(nonce, tag),
            ).decryptor()
            decryptor.authenticate_additional_data(header)
            remaining = total_size - _HEADER_BYTES - _TAG_BYTES
            while remaining:
                chunk = source.read(min(_CHUNK_BYTES, remaining))
                if not chunk:
                    raise BackupCryptoError("encrypted backup ciphertext is truncated")
                remaining -= len(chunk)
                _write_all(fd, decryptor.update(chunk))
            try:
                _write_all(fd, decryptor.finalize())
            except InvalidTag as exc:
                raise BackupCryptoError(
                    "encrypted backup authentication failed"
                ) from exc
        os.fsync(fd)
    except Exception:
        try:
            os.close(fd)
        finally:
            _unlink_quiet(output_path)
        raise
    else:
        os.close(fd)


def _derive_key(
    shared_secret: bytes,
    *,
    nonce: bytes,
    ephemeral_public: bytes,
    recipient_public: bytes,
) -> bytes:
    return HKDF(
        algorithm=hashes.SHA256(),
        length=32,
        salt=nonce,
        info=_KDF_INFO + ephemeral_public + recipient_public,
    ).derive(shared_secret)


def _load_public_key(path: Path) -> x25519.X25519PublicKey:
    try:
        key = serialization.load_pem_public_key(path.read_bytes())
    except (OSError, ValueError, TypeError) as exc:
        raise BackupCryptoError("backup recipient public key is unavailable") from exc
    if not isinstance(key, x25519.X25519PublicKey):
        raise BackupCryptoError("backup recipient key is not X25519")
    return key


def _load_private_key(path: Path) -> x25519.X25519PrivateKey:
    try:
        if path.stat().st_mode & 0o077:
            raise BackupCryptoError(
                "backup recovery private key permissions are too broad"
            )
        key = serialization.load_pem_private_key(path.read_bytes(), password=None)
    except BackupCryptoError:
        raise
    except (OSError, ValueError, TypeError) as exc:
        raise BackupCryptoError("backup recovery private key is unavailable") from exc
    if not isinstance(key, x25519.X25519PrivateKey):
        raise BackupCryptoError("backup recovery key is not X25519")
    return key


def _atomic_write(path: Path, payload: bytes, *, mode: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    try:
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
        try:
            _write_all(fd, payload)
            os.fsync(fd)
        finally:
            os.close(fd)
        os.replace(tmp, path)
        os.chmod(path, mode)
    except Exception:
        _unlink_quiet(tmp)
        raise


def _write_all(fd: int, payload: bytes) -> None:
    view = memoryview(payload)
    written = 0
    while written < len(view):
        count = os.write(fd, view[written:])
        if count <= 0:
            raise OSError("short write while writing encrypted backup")
        written += count


def _unlink_quiet(path: Path) -> None:
    try:
        path.unlink()
    except OSError:
        pass
