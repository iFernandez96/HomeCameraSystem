from __future__ import annotations

import asyncio
import os
import subprocess
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import httpx
import pytest
import yaml


def _payload(
    *,
    action: str = "read",
    path: str = "cam",
    protocol: str = "webrtc",
    token: str = "",
    ip: str = "198.51.100.20",
):
    return {
        "user": "",
        "password": "",
        "token": token,
        "ip": ip,
        "action": action,
        "path": path,
        "protocol": protocol,
        "id": "session-1",
        "query": "",
    }


async def _callback(monkeypatch, payload, *, peer="172.18.0.1"):
    from app.config import settings
    from app.main import app

    monkeypatch.setattr(
        settings,
        "mediamtx_auth_trusted_callers",
        "127.0.0.1,::1,172.18.0.1",
    )
    transport = httpx.ASGITransport(app=app, client=(peer, 12345))
    async with httpx.AsyncClient(
        transport=transport, base_url="http://homecam.test"
    ) as client:
        return await client.post("/api/_internal/mediamtx-auth", json=payload)


def test_token_is_opaque_scoped_one_time_and_expires():
    from app.services import media_tokens

    token, expires = media_tokens.issue("publish", "talk", now=100.0)
    assert expires == 160.0
    assert ":" not in token
    assert token not in repr(media_tokens._GRANTS)
    assert not media_tokens.consume(token, "read", "listen", now=101.0)
    assert media_tokens.consume(token, "publish", "talk", now=101.0)
    assert not media_tokens.consume(token, "publish", "talk", now=101.0)

    expired, _ = media_tokens.issue("read", "listen", now=200.0)
    assert not media_tokens.consume(expired, "read", "listen", now=260.0)


def test_one_time_token_has_exactly_one_concurrent_winner():
    from app.services import media_tokens

    token, _ = media_tokens.issue("publish", "talk")
    with ThreadPoolExecutor(max_workers=16) as pool:
        results = list(
            pool.map(
                lambda _index: media_tokens.consume(token, "publish", "talk"),
                range(32),
            )
        )
    assert results.count(True) == 1
    assert results.count(False) == 31


def test_callback_trust_is_exact_and_normalizes_ipv4_mapped_ipv6(monkeypatch):
    from app.config import settings
    from app.services.mediamtx_auth import trusted_callback_host

    monkeypatch.setattr(
        settings,
        "mediamtx_auth_trusted_callers",
        "127.0.0.1,::1,172.18.0.1",
    )
    assert trusted_callback_host("::ffff:172.18.0.1")
    assert trusted_callback_host("::1")
    assert not trusted_callback_host("172.18.0.3")
    assert not trusted_callback_host("172.18.0.1.attacker.invalid")


def test_policy_allows_only_exact_video_and_loopback_rtsp_paths():
    from app.services.mediamtx_auth import authorize

    assert authorize(_payload(action="read", path="cam", protocol="webrtc"))
    assert not authorize(
        _payload(action="read", path="cam_extra", protocol="webrtc")
    )
    assert not authorize(
        _payload(action="publish", path="cam", protocol="webrtc")
    )
    for path in ("cam", "cam_uhq", "cam_lq", "cam_uq", "talk", "listen"):
        assert authorize(
            _payload(
                action="publish",
                path=path,
                protocol="rtsp",
                ip="127.0.0.1",
            )
        )
        assert not authorize(
            _payload(
                action="publish",
                path=path,
                protocol="rtsp",
                ip="192.0.2.4",
            )
        )
    assert not authorize(
        _payload(
            action="read", path="listen", protocol="webrtc", ip="127.0.0.1"
        )
    )


@pytest.mark.asyncio
async def test_callback_consumes_audio_token_once(monkeypatch):
    from app.services import media_tokens
    from app.services.detection_config import detection_config

    detection_config.config.audio_enabled = True
    token, _ = media_tokens.issue("publish", "talk")
    payload = _payload(action="publish", path="talk", token=token)
    first = await _callback(monkeypatch, payload)
    second = await _callback(monkeypatch, payload)
    assert first.status_code == 204 and first.content == b""
    assert second.status_code == 401 and second.content == b""


@pytest.mark.asyncio
async def test_callback_rechecks_privacy_and_revokes_unused_grant(monkeypatch):
    from app.services import media_tokens
    from app.services.detection_config import detection_config

    detection_config.config.audio_enabled = True
    token, _ = media_tokens.issue("read", "listen")
    detection_config.config.operating_mode = "privacy"
    denied = await _callback(
        monkeypatch,
        _payload(action="read", path="listen", token=token),
    )
    assert denied.status_code == 401
    detection_config.config.operating_mode = "home"
    reused = await _callback(
        monkeypatch,
        _payload(action="read", path="listen", token=token),
    )
    assert reused.status_code == 401


@pytest.mark.asyncio
async def test_callback_rejects_untrusted_source_and_never_echoes_credentials(
    monkeypatch, caplog
):
    sentinel = "SENTINEL-MEDIAMTX-CREDENTIAL-DO-NOT-LOG"
    untrusted = await _callback(
        monkeypatch,
        _payload(token=sentinel),
        peer="172.18.0.3",
    )
    assert untrusted.status_code == 403 and untrusted.content == b""

    malformed = _payload(token=sentinel * 20)
    rejected = await _callback(monkeypatch, malformed)
    assert rejected.status_code == 401 and rejected.content == b""
    assert sentinel not in rejected.text
    assert sentinel not in caplog.text


def test_media_token_endpoint_gates_audio_privacy_and_owner_talk(client):
    from app.auth import users_db
    from app.config import settings
    from app.services.detection_config import detection_config

    disabled = client.post(
        "/api/security/media-token", json={"action": "read", "path": "listen"}
    )
    assert disabled.status_code == 409

    detection_config.config.audio_enabled = True
    detection_config.config.operating_mode = "privacy"
    privacy = client.post(
        "/api/security/media-token", json={"action": "read", "path": "listen"}
    )
    assert privacy.status_code == 409

    detection_config.config.operating_mode = "home"
    talk = client.post(
        "/api/security/media-token", json={"action": "publish", "path": "talk"}
    )
    assert talk.status_code == 200
    assert set(talk.json()) == {"token", "expires_ts"}
    assert ":" not in talk.json()["token"]
    assert 55 <= talk.json()["expires_ts"] - time.time() <= 60

    invalid = client.post(
        "/api/security/media-token", json={"action": "publish", "path": "listen"}
    )
    assert invalid.status_code == 422

    assert users_db.update_role(settings.users_db_path, "testuser", "family")
    family_talk = client.post(
        "/api/security/media-token", json={"action": "publish", "path": "talk"}
    )
    family_listen = client.post(
        "/api/security/media-token", json={"action": "read", "path": "listen"}
    )
    assert family_talk.status_code == 403
    assert family_listen.status_code == 200


def test_mediamtx_v118_security_config_is_fail_closed():
    root = Path(__file__).resolve().parents[2]
    config = yaml.safe_load((root / "deploy" / "mediamtx.yml").read_text())
    assert config["authMethod"] == "http"
    assert config["authHTTPAddress"] == (
        "http://127.0.0.1:8000/api/_internal/mediamtx-auth"
    )
    assert config["authHTTPExclude"] == []
    assert config["webrtcTrustedProxies"] == ["127.0.0.1/32", "::1/128"]
    assert config["rtspAddress"] == "127.0.0.1:8554"
    assert config["rtspTransports"] == ["tcp"]
    assert config["webrtcAddress"] == "127.0.0.1:8889"
    assert config["paths"]["talk"]["runOnReadyRestart"] is False
    service = (root / "deploy" / "systemd" / "mediamtx.service").read_text()
    assert "EnvironmentFile=-/etc/homecam/mediamtx.env" in service


def test_speaker_hook_requires_marker_and_explicit_device(tmp_path):
    root = Path(__file__).resolve().parents[2]
    script = root / "deploy" / "run-talk-speaker.sh"
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    invoked = tmp_path / "invoked"
    fake_gst = fake_bin / "gst-launch-1.0"
    fake_gst.write_text(
        "#!/usr/bin/env bash\nprintf '%s' \"$*\" > \"$HOMECAM_TEST_INVOKED\"\n",
        encoding="utf-8",
    )
    fake_gst.chmod(0o755)
    env = os.environ.copy()
    env.update(
        {
            "PATH": "{}:{}".format(fake_bin, env.get("PATH", "")),
            "HOMECAM_TEST_INVOKED": str(invoked),
        }
    )
    env.pop("HOMECAM_SPEAKER_ENABLE_FILE", None)
    env.pop("HOMECAM_SPEAKER_DEVICE", None)
    disabled = subprocess.run(["bash", str(script)], env=env, check=False)
    assert disabled.returncode == 0 and not invoked.exists()

    marker = tmp_path / "speaker-enabled"
    marker.touch()
    env["HOMECAM_SPEAKER_ENABLE_FILE"] = str(marker)
    missing_device = subprocess.run(["bash", str(script)], env=env, check=False)
    assert missing_device.returncode == 78 and not invoked.exists()

    env["HOMECAM_SPEAKER_DEVICE"] = "plughw:CARD=Device,DEV=0"
    enabled = subprocess.run(["bash", str(script)], env=env, check=False)
    assert enabled.returncode == 0
    assert "alsasink device=plughw:CARD=Device,DEV=0" in invoked.read_text()
