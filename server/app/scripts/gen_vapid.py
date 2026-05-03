"""Generate a VAPID keypair for Web Push.

Run: python -m app.scripts.gen_vapid

Writes the keys to the paths configured in .env (default: ./vapid_private.pem
and ./vapid_public.pem). Prints the URL-safe base64 public key that the
browser uses as `applicationServerKey`.
"""

from __future__ import annotations

import base64
import os

from cryptography.hazmat.backends import default_backend
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec

from ..config import settings


def _atomic_write_secret(path, data: bytes, mode: int) -> None:
    """iter-264 (security-auditor C1): pre-create the file with the
    target permission bits via ``os.open(..., O_CREAT, mode)`` so the
    private key is never world-readable, even momentarily, between
    write and chmod. Mirrors the iter-178
    ``jwt_secret._generate_and_write`` pattern.

    Pre-iter-264 the path was ``write_bytes`` (uses the process umask,
    typically 0o644 inside the container) followed by ``chmod 0o600``.
    A co-resident process under the docker-mounted host could
    race-snapshot the private VAPID PEM during initial generation.
    Window is microseconds but fires on every fresh deploy.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    fd = os.open(str(tmp), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, mode)
    try:
        os.write(fd, data)
    finally:
        os.close(fd)
    os.replace(tmp, path)


def main() -> None:
    private_key = ec.generate_private_key(ec.SECP256R1(), default_backend())
    public_key = private_key.public_key()

    priv_pem = private_key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    )
    pub_pem = public_key.public_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    )

    settings.vapid_public_key_path.parent.mkdir(parents=True, exist_ok=True)
    # Public key: 0o644 (the browser fetches it; world-readable is fine).
    _atomic_write_secret(settings.vapid_public_key_path, pub_pem, 0o644)
    # Private key: 0o600 from the moment the file appears on disk —
    # never widens the window for a co-resident process to read.
    _atomic_write_secret(settings.vapid_private_key_path, priv_pem, 0o600)

    raw = public_key.public_bytes(
        encoding=serialization.Encoding.X962,
        format=serialization.PublicFormat.UncompressedPoint,
    )
    pub_b64 = base64.urlsafe_b64encode(raw).decode().rstrip("=")

    print(f"private key: {settings.vapid_private_key_path}")
    print(f"public key:  {settings.vapid_public_key_path}")
    print(f"public b64:  {pub_b64}")


if __name__ == "__main__":
    main()
