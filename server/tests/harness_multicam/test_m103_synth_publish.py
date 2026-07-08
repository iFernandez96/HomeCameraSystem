import json
import time
import urllib.request

import pytest

from server.tests.harness_multicam.fixtures import (
    MEDIAMTX_SKIP_REASON,
    ffmpeg_available,
    mediamtx_available,
)


pytestmark = pytest.mark.skipif(
    not mediamtx_available() or not ffmpeg_available(),
    reason=f"{MEDIAMTX_SKIP_REASON}; ffmpeg must also be on PATH",
)


def _synth_is_published(payload: dict) -> bool:
    for item in payload.get("items", []):
        name = str(item.get("name") or item.get("confName"))
        if name != "synth":
            continue
        if item.get("ready") is True or item.get("sourceReady") is True:
            return True
        source = item.get("source")
        if isinstance(source, dict) and source:
            return True
        if isinstance(source, str) and source:
            return True
    return False


def test_given_ffmpeg_testsrc_when_published_then_mediamtx_exposes_synth_path(
    mediamtx_server,
    ffmpeg_testsrc_publisher,
):
    deadline = time.monotonic() + 10.0
    last_payload: dict = {}
    while time.monotonic() < deadline:
        assert ffmpeg_testsrc_publisher.poll() is None
        with urllib.request.urlopen(
            f"{mediamtx_server.api_base}/v3/paths/list",
            timeout=1.0,
        ) as response:
            last_payload = json.loads(response.read().decode("utf-8"))
        if _synth_is_published(last_payload):
            break
        time.sleep(0.2)

    assert _synth_is_published(last_payload), last_payload
