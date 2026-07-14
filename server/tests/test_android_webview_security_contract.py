from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def test_android_wrapper_pins_encrypted_origin_without_cleartext_fallback():
    gradle = (ROOT / "android-wrapper" / "build.gradle").read_text()
    network = (
        ROOT
        / "android-wrapper"
        / "src"
        / "main"
        / "res"
        / "xml"
        / "network_security_config.xml"
    ).read_text()
    monitor = (
        ROOT
        / "android-wrapper"
        / "src"
        / "main"
        / "java"
        / "com"
        / "example"
        / "homecamerasystem"
        / "JetsonHealthMonitor.java"
    ).read_text()

    assert 'HOMECAM_URL", "\\"https://' in gradle
    assert "HOMECAM_LAN_URL" not in gradle
    assert 'cleartextTrafficPermitted="true"' not in network
    assert "HOMECAM_LAN_URL" not in monitor


def test_android_webview_rejects_untrusted_origins_and_privileged_access():
    activity = (
        ROOT
        / "android-wrapper"
        / "src"
        / "main"
        / "java"
        / "com"
        / "example"
        / "homecamerasystem"
        / "MainActivity.java"
    ).read_text()

    assert "if (isTrustedHomeCamUri(uri)) return false;" in activity
    assert "openExternalUri(uri);" in activity
    assert "setAcceptThirdPartyCookies(webView, false)" in activity
    assert "setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW)" in activity
    assert "setAllowContentAccess(false)" in activity
    assert "setAllowFileAccess(false)" in activity
    assert "addJavascriptInterface" not in activity
    assert "injectNativeStatus(view);" in activity
