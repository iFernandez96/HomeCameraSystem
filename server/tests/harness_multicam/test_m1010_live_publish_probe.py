import os
import re
import shutil
import socket
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path

import pytest

from server.tests.harness_multicam.fixtures import terminate_process


REPO_ROOT = Path(__file__).resolve().parents[3]
MEDIAMTX_CONFIG = REPO_ROOT / "deploy" / "mediamtx.yml"
SCRATCH_PATH = "proofprobe"
LIVE_HOSTS = ("homecam.tail4a6525.ts.net", "jetson")
TOTAL_TIMEOUT_S = 29.0


pytestmark = pytest.mark.skipif(
    os.getenv("HOMECAM_LIVE_MULTICAM") != "1" or shutil.which("ffmpeg") is None,
    reason="set HOMECAM_LIVE_MULTICAM=1 and install ffmpeg to run live multicam probe",
)


class Deadline:
    def __init__(self, timeout_s: float) -> None:
        self.expires_at = time.monotonic() + timeout_s

    def remaining(self) -> float:
        return max(0.1, self.expires_at - time.monotonic())

    def expired(self) -> bool:
        return time.monotonic() >= self.expires_at


def _top_level_port(config_text: str, key: str) -> int:
    match = re.search(rf"(?m)^{re.escape(key)}:\s*:([0-9]+)\s*$", config_text)
    assert match, f"{MEDIAMTX_CONFIG} must define top-level {key}"
    return int(match.group(1))


def _configured_paths(config_text: str) -> dict[str, list[str]]:
    paths: dict[str, list[str]] = {}
    current_path: str | None = None
    in_paths = False

    for raw_line in config_text.splitlines():
        line = raw_line.split("#", 1)[0].rstrip()
        if not line.strip():
            continue
        indent = len(line) - len(line.lstrip(" "))
        stripped = line.strip()

        if indent == 0:
            in_paths = stripped == "paths:"
            current_path = None
            continue
        if not in_paths:
            continue
        if indent == 2 and stripped.endswith(":"):
            current_path = stripped[:-1]
            paths[current_path] = []
            continue
        if indent >= 4 and current_path is not None:
            paths[current_path].append(stripped)

    return paths


def _path_allows_unauthenticated_publish(path_lines: list[str]) -> bool:
    has_publisher_source = any(line == "source: publisher" for line in path_lines)
    has_auth_gate = any(
        line.startswith(
            (
                "publishUser:",
                "publishPass:",
                "publishIPs:",
                "readUser:",
                "readPass:",
                "readIPs:",
            )
        )
        for line in path_lines
    )
    return has_publisher_source and not has_auth_gate


def _assert_live_config_allows_scratch_publish(config_text: str) -> None:
    paths = _configured_paths(config_text)
    scratch_lines = paths.get(SCRATCH_PATH)
    wildcard_lines = paths.get("all_others")

    if scratch_lines is not None and _path_allows_unauthenticated_publish(
        scratch_lines
    ):
        return
    if wildcard_lines is not None and _path_allows_unauthenticated_publish(
        wildcard_lines
    ):
        return

    configured = ", ".join(paths) if paths else "none"
    pytest.skip(
        f"{MEDIAMTX_CONFIG} config gate: unauthenticated scratch publish to "
        f"{SCRATCH_PATH!r} is not allowed; paths are {configured}, with no "
        "'proofprobe' or 'all_others' publisher path"
    )


def _tcp_connects(host: str, port: int, timeout_s: float) -> bool:
    try:
        with socket.create_connection((host, port), timeout=timeout_s):
            return True
    except OSError:
        return False


def _reachable_live_host(rtsp_port: int, webrtc_port: int) -> str:
    for host in LIVE_HOSTS:
        if _tcp_connects(host, rtsp_port, 2.0) and _tcp_connects(host, webrtc_port, 2.0):
            return host
    pytest.skip(
        "live Jetson MediaMTX is not reachable at "
        f"{LIVE_HOSTS[0]} or LAN host {LIVE_HOSTS[1]} on RTSP :{rtsp_port} "
        f"and WHEP :{webrtc_port}"
    )


def _whep_status(url: str, timeout_s: float) -> int:
    request = urllib.request.Request(url, method="GET")
    try:
        with urllib.request.urlopen(request, timeout=timeout_s) as response:
            response.read(1)
            return int(response.status)
    except urllib.error.HTTPError as exc:
        exc.read()
        return int(exc.code)


def _wait_for_whep_non_404(url: str, publisher: subprocess.Popen, deadline: Deadline):
    last_status: int | str | None = None
    while not deadline.expired():
        assert publisher.poll() is None, "ffmpeg publisher exited before WHEP appeared"
        try:
            last_status = _whep_status(url, min(1.0, deadline.remaining()))
            if last_status != 404:
                return
        except urllib.error.URLError as exc:
            last_status = str(exc)
        time.sleep(0.25)
    raise AssertionError(f"{url} stayed unreadable; last WHEP result={last_status!r}")


def _wait_for_whep_404(url: str, deadline: Deadline) -> None:
    last_status: int | str | None = None
    while not deadline.expired():
        try:
            last_status = _whep_status(url, min(1.0, deadline.remaining()))
            if last_status == 404:
                return
        except urllib.error.URLError as exc:
            last_status = str(exc)
        time.sleep(0.25)
    raise AssertionError(f"{url} stayed readable after publisher stop; last={last_status!r}")


def _start_testsrc_publisher(ffmpeg: str, rtsp_url: str) -> subprocess.Popen:
    return subprocess.Popen(
        [
            ffmpeg,
            "-hide_banner",
            "-loglevel",
            "warning",
            "-re",
            "-f",
            "lavfi",
            "-i",
            "testsrc=size=320x240:rate=10",
            "-an",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-tune",
            "zerolatency",
            "-pix_fmt",
            "yuv420p",
            "-f",
            "rtsp",
            "-rtsp_transport",
            "tcp",
            rtsp_url,
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )


def test_given_live_mediamtx_when_scratch_testsrc_published_then_whep_appears_and_disappears():
    deadline = Deadline(TOTAL_TIMEOUT_S)
    config_text = MEDIAMTX_CONFIG.read_text(encoding="utf-8")
    rtsp_port = _top_level_port(config_text, "rtspAddress")
    webrtc_port = _top_level_port(config_text, "webrtcAddress")
    _assert_live_config_allows_scratch_publish(config_text)
    host = _reachable_live_host(rtsp_port, webrtc_port)

    ffmpeg = shutil.which("ffmpeg")
    assert ffmpeg is not None
    rtsp_url = f"rtsp://{host}:{rtsp_port}/{SCRATCH_PATH}"
    whep_url = f"http://{host}:{webrtc_port}/{SCRATCH_PATH}/whep"
    publisher = _start_testsrc_publisher(ffmpeg, rtsp_url)

    try:
        _wait_for_whep_non_404(whep_url, publisher, deadline)
        terminate_process(publisher, timeout_s=min(3.0, deadline.remaining()))
        _wait_for_whep_404(whep_url, deadline)
    finally:
        terminate_process(publisher, timeout_s=min(3.0, deadline.remaining()))
