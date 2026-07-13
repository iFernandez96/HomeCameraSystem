"""PR-102 host-worker credential loading and attachment tests."""
from __future__ import annotations

import json
import sys
from unittest.mock import MagicMock

import pytest


sys.modules.setdefault("jetson_inference", MagicMock())
sys.modules.setdefault("jetson_utils", MagicMock())


class _Response:
    def __init__(self, body=b"{}"):
        self._body = body

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self):
        return self._body


def test_load_secret_accepts_only_32_byte_lowercase_hex(tmp_path):
    import worker_auth

    valid = tmp_path / "valid"
    valid.write_text(("ab" * 32) + "\n", encoding="ascii")
    assert worker_auth.load_secret(valid) == "ab" * 32

    for index, value in enumerate(("A" * 64, "a" * 63, "a" * 65, "not-hex")):
        path = tmp_path / str(index)
        path.write_text(value, encoding="ascii")
        with pytest.raises(ValueError):
            worker_auth.load_secret(path)
    with pytest.raises(OSError):
        worker_auth.load_secret(tmp_path / "missing")


def test_detect_requests_attach_exact_bearer_header(monkeypatch):
    import detect

    secret = "12" * 32
    captured = []

    def fake_urlopen(request, timeout):
        captured.append((request, timeout))
        return _Response(json.dumps({"ok": True}).encode("utf-8"))

    monkeypatch.setattr(detect.urllib.request, "urlopen", fake_urlopen)
    monkeypatch.setattr(detect, "_WORKER_AUTH_SECRET", secret)

    detect.post_event("http://127.0.0.1/event", {"id": "event-1"})
    detect.post_live_detection("http://127.0.0.1/live", [], "front_door")
    detect._request_json("http://127.0.0.1/config")

    assert len(captured) == 3
    for request, _timeout in captured:
        assert request.get_header("Authorization") == "Bearer " + secret


def test_audio_config_and_signal_posts_attach_exact_bearer(monkeypatch):
    import audio_watch
    import signal_retry

    secret = "34" * 32
    captured = []

    def fake_urlopen(request, timeout):
        captured.append(request)
        return _Response(b"{}")

    monkeypatch.setattr(audio_watch.urllib.request, "urlopen", fake_urlopen)
    monkeypatch.setattr(signal_retry.urllib.request, "urlopen", fake_urlopen)
    runtime = audio_watch.AudioRuntimeConfig()
    audio_watch.fetch_config("http://127.0.0.1/config", runtime, auth_secret=secret)
    signal_retry.post_signal(
        "http://127.0.0.1/signal", {"id": "signal-1"}, auth_secret=secret
    )

    assert len(captured) == 2
    assert all(
        request.get_header("Authorization") == "Bearer " + secret
        for request in captured
    )


def test_detection_refuses_start_before_signal_or_camera_setup(monkeypatch):
    import detect

    monkeypatch.setattr(
        detect.worker_auth,
        "load_secret",
        lambda _path: (_ for _ in ()).throw(OSError("missing")),
    )
    touched = []
    monkeypatch.setattr(detect.signal, "signal", lambda *_args: touched.append("signal"))

    with pytest.raises(SystemExit) as exc:
        detect.main()
    assert exc.value.code == 5
    assert touched == []


def test_audio_refuses_start_before_decoder_setup(monkeypatch):
    import audio_watch

    monkeypatch.setattr(
        audio_watch.worker_auth,
        "load_secret",
        lambda _path: (_ for _ in ()).throw(ValueError("invalid")),
    )
    touched = []
    monkeypatch.setattr(
        audio_watch,
        "_spawn_decoder",
        lambda *_args: touched.append("decoder"),
    )

    with pytest.raises(SystemExit) as exc:
        audio_watch.run()
    assert exc.value.code == 5
    assert touched == []
