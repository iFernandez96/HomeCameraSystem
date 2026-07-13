"""PR-103 HTTPS-only application and media signaling regression checks."""
from pathlib import Path

import yaml


ROOT = Path(__file__).resolve().parents[2]


def _read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_android_release_has_no_cleartext_or_lan_fallback():
    build = _read("android-wrapper/build.gradle")
    network = _read("android-wrapper/src/main/res/xml/network_security_config.xml")
    manifest = _read("android-wrapper/src/main/AndroidManifest.xml")
    activity = _read(
        "android-wrapper/src/main/java/com/example/homecamerasystem/MainActivity.java"
    )
    monitor = _read(
        "android-wrapper/src/main/java/com/example/homecamerasystem/JetsonHealthMonitor.java"
    )

    assert "HOMECAM_LAN_URL" not in build + activity + monitor
    assert 'android:usesCleartextTraffic="false"' in manifest
    assert 'cleartextTrafficPermitted="true"' not in network
    assert 'cleartextTrafficPermitted="false"' in network
    assert "MIXED_CONTENT_NEVER_ALLOW" in activity
    assert "MIXED_CONTENT_COMPATIBILITY_MODE" not in activity
    assert "loadLan" not in activity


def test_browser_media_signaling_never_constructs_a_direct_plaintext_listener():
    video = _read("client/src/lib/streamQuality.ts")
    audio = _read("client/src/lib/twoWayAudio.ts")

    assert "${location.hostname}:8889" not in video
    assert "${location.hostname}:8889" not in audio
    assert "${location.origin}/whep/${path}/whep" in video
    assert "${location.origin}/whep/talk/whip" in audio
    assert "${location.origin}/whep/listen/whep" in audio


def test_deployment_keeps_exact_origins_and_control_planes_on_loopback():
    mediamtx = yaml.safe_load(_read("deploy/mediamtx.yml"))
    compose = yaml.safe_load(_read("deploy/docker-compose.yml"))

    assert mediamtx["webrtcAllowOrigins"] == [
        "https://homecam.tail4a6525.ts.net",
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ]
    assert mediamtx["rtspAddress"] == "127.0.0.1:8554"
    assert mediamtx["webrtcAddress"] == "127.0.0.1:8889"
    assert mediamtx["webrtcLocalTCPAddress"] == ":8189"
    assert mediamtx["webrtcLocalUDPAddress"] == ":8189"
    assert compose["services"]["server"]["ports"] == ["127.0.0.1:8000:8000"]
