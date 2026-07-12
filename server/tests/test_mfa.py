from __future__ import annotations

import sqlite3

from app.auth import mfa
from app.config import settings


def test_given_totp_secret_when_rfc_counter_code_is_checked_then_adjacent_window_is_accepted(tmp_path, monkeypatch):
    # arrange
    monkeypatch.setattr(settings, "mfa_key_path", tmp_path / "key.bin")
    secret = "JBSWY3DPEHPK3PXP"
    now = 1_700_000_000.0
    code = mfa._totp(secret, int(now // 30))

    # act / assert
    assert mfa.verify_totp(secret, code, now=now) is True
    assert mfa.verify_totp(secret, "000000", now=now) is False


def test_given_confirmed_setup_when_stored_then_secret_is_encrypted_and_recovery_is_one_use(tmp_path, monkeypatch):
    # arrange
    db = tmp_path / "users.db"
    sqlite3.connect(db).close()
    monkeypatch.setattr(settings, "mfa_key_path", tmp_path / "key.bin")
    setup = mfa.generate_setup("israel", now=1000.0)
    code = mfa._totp(setup["secret"], int(1001.0 // 30))

    # act
    assert mfa.confirm_setup(db, "israel", code, now=1001.0) is True
    recovery = setup["recovery_codes"][0]
    assert mfa.verify_login(db, "israel", recovery, now=1002.0) is True
    assert mfa.verify_login(db, "israel", recovery, now=1003.0) is False

    # assert
    with sqlite3.connect(db) as conn:
        stored = conn.execute("SELECT secret_cipher, recovery_hashes FROM user_mfa").fetchone()
    assert setup["secret"] not in stored[0]
    assert recovery.replace("-", "") not in stored[1]


def test_given_enabled_owner_when_login_has_no_code_then_server_requires_second_factor(
    client, monkeypatch
):
    # arrange
    setup = client.post("/api/auth/mfa/setup", json={"password": "testpass"})
    assert setup.status_code == 200, setup.text
    body = setup.json()
    code = mfa._totp(body["secret"], int(__import__("time").time() // 30))
    confirmed = client.post("/api/auth/mfa/confirm", json={"code": code})
    assert confirmed.status_code == 200, confirmed.text
    client.post("/api/auth/logout", json={})

    # act
    required = client.post(
        "/api/auth/login",
        json={"username": "testuser", "password": "testpass"},
    )
    success = client.post(
        "/api/auth/login",
        json={"username": "testuser", "password": "testpass", "otp_code": code},
    )

    # assert
    assert required.status_code == 428
    assert required.json() == {"detail": "second factor required"}
    assert success.status_code == 200, success.text


def test_given_wrong_current_password_when_setup_requested_then_no_secret_is_returned(client):
    response = client.post("/api/auth/mfa/setup", json={"password": "wrong"})
    assert response.status_code == 401
    assert "secret" not in response.text.lower()
