"""Fail-closed MediaMTX v1.18 HTTP authorization policy."""
from __future__ import annotations

import ipaddress
from typing import Any

from ..config import settings
from .camera_registry import camera_registry
from .detection_config import detection_config
from .media_tokens import consume


def normalize_ip(value: str) -> str | None:
    """Return a canonical IP, folding IPv4-mapped IPv6 to IPv4."""
    try:
        address = ipaddress.ip_address(value.strip())
    except (AttributeError, ValueError):
        return None
    if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped:
        address = address.ipv4_mapped
    return str(address)


def trusted_callback_host(host: str) -> bool:
    candidate = normalize_ip(host)
    if candidate is None:
        return False
    configured = {
        normalized
        for raw in settings.mediamtx_auth_trusted_callers.split(",")
        if (normalized := normalize_ip(raw)) is not None
    }
    return candidate in configured


def video_paths() -> set[str]:
    paths: set[str] = set()
    for camera in camera_registry.cameras():
        paths.update(
            {
                camera.path,
                "{}_uhq".format(camera.path),
                "{}_lq".format(camera.path),
                "{}_uq".format(camera.path),
            }
        )
    return paths


def _loopback(value: str) -> bool:
    normalized = normalize_ip(value)
    if normalized is None:
        return False
    return ipaddress.ip_address(normalized).is_loopback


def authorize(payload: dict[str, Any]) -> bool:
    """Authorize an already schema-validated MediaMTX callback payload."""
    action = payload["action"]
    path = payload["path"]
    protocol = payload["protocol"]
    client_ip = payload["ip"]
    paths = video_paths()

    # Host-only GStreamer publishers/readers use RTSP. This covers the camera
    # publisher, adaptive transcoders, microphone publisher, speaker consumer,
    # and detection worker without opening an audio path to the LAN.
    if (
        protocol == "rtsp"
        and _loopback(client_ip)
        and action in {"publish", "read"}
        and path in paths.union({"talk", "listen"})
    ):
        return True

    # Video remains anonymously readable over WebRTC so the existing WHEP
    # live view is unchanged. Exact paths prevent regex/path confusion.
    if protocol == "webrtc" and action == "read" and path in paths:
        return True

    # Browser audio is the only remote publication/read surface. Re-check the
    # live privacy boundary here so an unused grant is revoked immediately if
    # settings changed after issuance.
    expected = {("publish", "talk"), ("read", "listen")}
    if protocol == "webrtc" and (action, path) in expected:
        token = payload.get("token")
        if not isinstance(token, str) or not consume(token, action, path):
            return False
        config = detection_config.get()
        if config.operating_mode == "privacy" or not config.audio_enabled:
            return False
        return True

    return False
