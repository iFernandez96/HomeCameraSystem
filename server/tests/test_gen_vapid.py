"""Tests for the VAPID keypair generator script."""
from __future__ import annotations

import stat


def test_gen_vapid_writes_pem_files_and_secures_private(tmp_path, monkeypatch):
    from app.config import settings
    from app.scripts import gen_vapid

    priv = tmp_path / "priv.pem"
    pub = tmp_path / "pub.pem"
    monkeypatch.setattr(settings, "vapid_private_key_path", priv)
    monkeypatch.setattr(settings, "vapid_public_key_path", pub)

    gen_vapid.main()

    assert priv.exists()
    assert pub.exists()

    priv_text = priv.read_bytes()
    pub_text = pub.read_bytes()
    assert priv_text.startswith(b"-----BEGIN PRIVATE KEY-----")
    assert pub_text.startswith(b"-----BEGIN PUBLIC KEY-----")

    # Private key must not be world / group readable.
    mode = stat.S_IMODE(priv.stat().st_mode)
    assert mode & 0o077 == 0


def test_keys_are_loadable_by_push_service(tmp_path, monkeypatch):
    """End-to-end: generate keys, point PushService at them, expect a valid b64 key."""
    from app.config import settings
    from app.scripts import gen_vapid
    from app.services.push_service import PushService

    priv = tmp_path / "priv.pem"
    pub = tmp_path / "pub.pem"
    monkeypatch.setattr(settings, "vapid_private_key_path", priv)
    monkeypatch.setattr(settings, "vapid_public_key_path", pub)

    gen_vapid.main()

    svc = PushService()
    svc.load_keys()
    assert svc.private_pem is not None
    assert svc.public_key_b64 is not None
    # URL-safe base64 of an uncompressed P-256 point ⇒ 65 raw bytes ⇒ 87 chars.
    assert len(svc.public_key_b64) == 87
    assert all(c.isalnum() or c in "-_" for c in svc.public_key_b64)
