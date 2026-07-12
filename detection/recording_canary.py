#!/usr/bin/env python3
"""Low-load end-to-end recording canary for the Jetson host.

The canary reads the existing MediaMTX RTSP publication (it never opens
libargus or the physical camera), stream-copies six seconds to the real
recordings filesystem, fully decodes that MP4, then deletes every owned
temporary.  A compact result is POSTed to the FastAPI internal endpoint for
durable status, UI display, and transition alerts.

Python 3.6 compatible: this runs on the JetPack host outside Docker.
"""
import json
import os
import shutil
import re
import subprocess
import sys
import time
import urllib.request


_TEMP_PREFIX = ".recording-canary-"
_TEMP_SUFFIX = ".mp4.tmp"
_WRITE_PREFIX = ".recording-canary-write-"


def _safe_unlink(path):
    try:
        os.unlink(path)
        return True
    except FileNotFoundError:
        return True
    except OSError:
        return False


def cleanup_owned_temps(recordings_dir):
    """Delete only exact canary-owned temp shapes; never touch event clips."""
    ok = True
    try:
        names = os.listdir(recordings_dir)
    except OSError:
        return False
    for name in names:
        is_video_temp = name.startswith(_TEMP_PREFIX) and name.endswith(_TEMP_SUFFIX)
        is_write_temp = name.startswith(_WRITE_PREFIX) and name.endswith(".tmp")
        if not (is_video_temp or is_write_temp):
            continue
        if not _safe_unlink(os.path.join(recordings_dir, name)):
            ok = False
    return ok


def _mount_info(path, mounts_path="/proc/mounts"):
    best = None
    target = os.path.realpath(path)
    try:
        with open(mounts_path, "r") as handle:
            for line in handle:
                parts = line.split()
                if len(parts) < 4:
                    continue
                mountpoint = parts[1].replace("\\040", " ")
                real_mount = os.path.realpath(mountpoint)
                if target == real_mount or target.startswith(real_mount.rstrip("/") + "/"):
                    if best is None or len(real_mount) > len(best[0]):
                        best = (real_mount, parts[0], parts[2], parts[3].split(","))
    except OSError:
        return {"filesystem": None, "read_only": None, "device": None}
    if best is None:
        return {"filesystem": None, "read_only": None, "device": None}
    return {
        "filesystem": best[2],
        "read_only": "ro" in best[3],
        "device": best[1] if best[1].startswith("/dev/") else None,
    }


def _smart_status(device, runner):
    binary = shutil.which("smartctl")
    if not binary or not device:
        return "unavailable"
    device = re.sub(r"p[0-9]+$", "", device)
    device = re.sub(r"^(/dev/[shv]d[a-z]+)[0-9]+$", r"\1", device)
    try:
        result = runner(
            [binary, "-H", device],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=10,
        )
    except (OSError, subprocess.TimeoutExpired):
        return "unavailable"
    output = (result.stdout or b"").decode("utf-8", "replace").upper()
    if "FAILED" in output:
        return "failed"
    if "PASSED" in output or "SMART HEALTH STATUS: OK" in output:
        return "healthy"
    return "unavailable"


def _probe_write(recordings_dir, clock):
    path = os.path.join(recordings_dir, _WRITE_PREFIX + str(os.getpid()) + ".tmp")
    started = clock()
    try:
        with open(path, "wb") as handle:
            handle.write(b"0" * 4096)
            handle.flush()
            os.fsync(handle.fileno())
        elapsed_ms = max(0.0, (clock() - started) * 1000.0)
        return True, round(elapsed_ms, 1)
    except OSError:
        return False, None
    finally:
        _safe_unlink(path)


def _storage_snapshot(recordings_dir, runner, clock):
    mount = _mount_info(recordings_dir)
    writable, write_ms = _probe_write(recordings_dir, clock)
    try:
        stats = os.statvfs(recordings_dir)
        free_bytes = int(stats.f_bavail * stats.f_frsize)
    except OSError:
        free_bytes = None
    return {
        "writable": writable,
        "filesystem": mount["filesystem"],
        "read_only": mount["read_only"],
        "smart_status": _smart_status(mount["device"], runner),
        "free_bytes": free_bytes,
        "write_probe_ms": write_ms,
    }


def _post_json(url, payload, timeout=10):
    body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return 200 <= response.status < 300


def _run_command(args, timeout, runner):
    try:
        return runner(
            args,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            timeout=timeout,
        ), None
    except subprocess.TimeoutExpired:
        return None, "timeout"
    except OSError:
        return None, "exec_failed"


def run_canary(
    recordings_dir,
    rtsp_url,
    result_url,
    runner=subprocess.run,
    post_result=_post_json,
    clock=time.time,
):
    checked_at = clock()
    started = time.monotonic()
    temp_path = os.path.join(
        recordings_dir,
        _TEMP_PREFIX + str(os.getpid()) + _TEMP_SUFFIX,
    )
    result = {
        "v": 1,
        "status": "failed",
        "checked_at": checked_at,
        "stage": "storage",
        "reason": "storage_unavailable",
        "sample_bytes": None,
        "elapsed_ms": None,
        "storage": None,
    }
    try:
        os.makedirs(recordings_dir, exist_ok=True)
        if not cleanup_owned_temps(recordings_dir):
            result.update(stage="cleanup", reason="cleanup_failed")
        else:
            storage = _storage_snapshot(recordings_dir, runner, time.monotonic)
            result["storage"] = storage
            if storage["read_only"] is True:
                result["reason"] = "storage_read_only"
            elif not storage["writable"]:
                result["reason"] = "storage_not_writable"
            else:
                capture_args = [
                    "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error",
                    "-rtsp_transport", "tcp", "-i", rtsp_url,
                    "-t", "6", "-an", "-c:v", "copy", "-movflags", "+faststart",
                    "-f", "mp4", "-y", temp_path,
                ]
                capture, capture_error = _run_command(capture_args, 25, runner)
                if capture_error == "timeout":
                    result.update(stage="capture", reason="capture_timeout")
                elif capture_error or capture.returncode != 0:
                    result.update(stage="capture", reason="capture_failed")
                else:
                    try:
                        sample_bytes = os.path.getsize(temp_path)
                    except OSError:
                        sample_bytes = 0
                    result["sample_bytes"] = sample_bytes
                    if sample_bytes < 1024:
                        result.update(stage="capture", reason="capture_empty")
                    else:
                        decode_args = [
                            "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error",
                            "-xerror", "-i", temp_path, "-map", "0:v:0",
                            "-f", "null", "-",
                        ]
                        decode, decode_error = _run_command(decode_args, 30, runner)
                        if decode_error == "timeout":
                            result.update(stage="decode", reason="decode_timeout")
                        elif decode_error or decode.returncode != 0:
                            result.update(stage="decode", reason="decode_failed")
                        else:
                            result.update(status="ok", stage="complete", reason="playable")
    except OSError:
        result.update(status="failed", stage="storage", reason="storage_unavailable")

    # Cleanup must finish BEFORE reporting success. A success status is proof
    # of both a decoded sample and an artifact-free exit.
    removed = _safe_unlink(temp_path)
    swept = cleanup_owned_temps(recordings_dir)
    if not removed or not swept:
        result.update(status="failed", stage="cleanup", reason="cleanup_failed")
    return _finish(result, result_url, post_result, started)


def _finish(result, result_url, post_result, started):
    result["elapsed_ms"] = round(max(0.0, (time.monotonic() - started) * 1000.0), 1)
    try:
        reported = bool(post_result(result_url, result))
    except Exception:
        reported = False
    if not reported:
        sys.stderr.write("recording canary: result report failed\n")
        return 2
    if result["status"] == "ok":
        sys.stdout.write("recording canary: playable sample verified and cleaned\n")
        return 0
    sys.stderr.write(
        "recording canary: failed stage={} reason={}\n".format(
            result["stage"], result["reason"],
        )
    )
    return 1


def main():
    recordings_dir = os.environ.get("RECORDINGS_DIR", "/srv/homecam-media/recordings")
    rtsp_url = os.environ.get("CANARY_RTSP_URL", "rtsp://127.0.0.1:8554/cam")
    result_url = os.environ.get(
        "CANARY_RESULT_URL",
        "http://127.0.0.1:8000/api/_internal/recording-assurance",
    )
    return run_canary(recordings_dir, rtsp_url, result_url)


if __name__ == "__main__":
    sys.exit(main())
