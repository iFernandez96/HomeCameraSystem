import contextlib
import os
import socket
import subprocess
import shutil
import sqlite3
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path

import pytest


REPO_ROOT = Path(__file__).resolve().parents[3]
EVENTS_DB = REPO_ROOT / ".jetson-snapshot" / "db" / "events.sqlite"
MEDIAMTX_SKIP_REASON = (
    "download a mediamtx release binary and set HOMECAM_MEDIAMTX_BIN"
)


def copy_events_db(tmp_path: Path) -> Path:
    target = tmp_path / "events.sqlite"
    shutil.copy2(EVENTS_DB, target)
    return target


def camera_counts(db_path: Path = EVENTS_DB) -> dict[str, int]:
    with sqlite3.connect(db_path) as conn:
        rows = conn.execute(
            "SELECT camera_id, COUNT(*) FROM events GROUP BY camera_id"
        ).fetchall()
    return {str(camera_id): int(count) for camera_id, count in rows}


def sample_front_door_ids(db_path: Path = EVENTS_DB, *, limit: int = 10) -> list[str]:
    with sqlite3.connect(db_path) as conn:
        rows = conn.execute(
            "SELECT id FROM events WHERE camera_id = 'front_door' "
            "ORDER BY ts DESC LIMIT ?",
            (limit,),
        ).fetchall()
    return [str(row[0]) for row in rows]


@dataclass(frozen=True)
class MediaMtxServer:
    process: subprocess.Popen
    rtsp_port: int
    webrtc_port: int
    api_port: int
    config_path: Path

    @property
    def api_base(self) -> str:
        return f"http://127.0.0.1:{self.api_port}"

    @property
    def rtsp_url(self) -> str:
        return f"rtsp://127.0.0.1:{self.rtsp_port}/synth"

    @property
    def whep_url(self) -> str:
        return f"http://127.0.0.1:{self.webrtc_port}/synth/whep"


def find_mediamtx_binary() -> str:
    configured = os.getenv("HOMECAM_MEDIAMTX_BIN")
    if configured:
        path = Path(configured)
        if path.is_file() and os.access(path, os.X_OK):
            return str(path)
        pytest.skip(MEDIAMTX_SKIP_REASON)
    found = shutil.which("mediamtx")
    if found:
        return found
    pytest.skip(MEDIAMTX_SKIP_REASON)


def mediamtx_available() -> bool:
    configured = os.getenv("HOMECAM_MEDIAMTX_BIN")
    if configured:
        path = Path(configured)
        return path.is_file() and os.access(path, os.X_OK)
    return shutil.which("mediamtx") is not None


def find_ffmpeg_binary() -> str:
    found = shutil.which("ffmpeg")
    if not found:
        pytest.skip("ffmpeg binary not found on PATH")
    return found


def ffmpeg_available() -> bool:
    return shutil.which("ffmpeg") is not None


def free_tcp_port() -> int:
    with contextlib.closing(socket.socket(socket.AF_INET, socket.SOCK_STREAM)) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def wait_for_http(url: str, *, timeout_s: float = 8.0) -> bytes:
    deadline = time.monotonic() + timeout_s
    last_error: Exception | None = None
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=0.5) as response:
                return response.read()
        except (OSError, urllib.error.URLError) as exc:
            last_error = exc
            time.sleep(0.1)
    raise AssertionError(f"timed out waiting for {url}: {last_error}")


def terminate_process(proc: subprocess.Popen, *, timeout_s: float = 5.0) -> None:
    if proc.poll() is not None:
        return
    proc.terminate()
    try:
        proc.wait(timeout=timeout_s)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait(timeout=timeout_s)


def start_mediamtx(tmp_path: Path) -> MediaMtxServer:
    mediamtx = find_mediamtx_binary()
    rtsp_port = free_tcp_port()
    webrtc_port = free_tcp_port()
    api_port = free_tcp_port()
    config_path = tmp_path / "mediamtx.yml"
    config_path.write_text(
        "\n".join(
            [
                "logLevel: info",
                "logDestinations: [stdout]",
                "api: yes",
                f"apiAddress: 127.0.0.1:{api_port}",
                f"rtspAddress: 127.0.0.1:{rtsp_port}",
                f"webrtcAddress: 127.0.0.1:{webrtc_port}",
                "webrtcEncryption: no",
                # v1.18+ key (production runs v1.18.0; pre-1.18 binaries
                # reject the plural spelling — match versions, not keys)
                "webrtcAllowOrigins: ['*']",
                "rtmp: no",
                "hls: no",
                "srt: no",
                "paths:",
                "  synth:",
                "    source: publisher",
                "",
            ]
        ),
        encoding="utf-8",
    )
    process = subprocess.Popen(
        [mediamtx, str(config_path)],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    server = MediaMtxServer(
        process=process,
        rtsp_port=rtsp_port,
        webrtc_port=webrtc_port,
        api_port=api_port,
        config_path=config_path,
    )
    try:
        wait_for_http(f"{server.api_base}/v3/config/global/get")
    except Exception:
        terminate_process(process)
        raise
    return server


@pytest.fixture
def mediamtx_server(tmp_path):
    server = start_mediamtx(tmp_path)
    try:
        yield server
    finally:
        terminate_process(server.process)


@pytest.fixture
def ffmpeg_testsrc_publisher(mediamtx_server):
    ffmpeg = find_ffmpeg_binary()
    process = subprocess.Popen(
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
            mediamtx_server.rtsp_url,
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    try:
        yield process
    finally:
        terminate_process(process)
