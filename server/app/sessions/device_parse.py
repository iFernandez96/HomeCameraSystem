"""Small, dependency-free user-agent labelling.

This is intentionally a hand-rolled best-effort parser. It produces human
labels for the sessions UI and must never be treated as a security boundary.
"""
from __future__ import annotations

import re


_MAX_SCAN_CHARS = 256


def _safe_ua(ua: str) -> str:
    return (ua or "")[:_MAX_SCAN_CHARS]


def _browser_label(ua: str) -> str:
    browser_matches = (
        ("Edg", "Edge"),
        ("OPR", "Opera"),
        ("Opera", "Opera"),
        ("Firefox", "Firefox"),
        ("FxiOS", "Firefox"),
        ("Chrome", "Chrome"),
        ("CriOS", "Chrome"),
        ("Safari", "Safari"),
    )
    for needle, label in browser_matches:
        if needle in ua:
            return label
    return "Unknown browser"


def _device_label(ua: str) -> str:
    pixel = re.search(r"\bPixel\s+(7|8)(?:\b|[^\w])", ua)
    if pixel:
        return "Pixel {}".format(pixel.group(1))
    if re.search(r"\bSM-[A-Z0-9]+", ua):
        return "Galaxy"
    if "iPhone" in ua:
        return "iPhone"
    if "iPad" in ua:
        return "iPad"

    os_matches = (
        ("Android", "Android"),
        ("Windows NT", "Windows"),
        ("Mac OS X", "Mac"),
        ("Linux", "Linux"),
        ("CrOS", "Chromebook"),
    )
    for needle, label in os_matches:
        if needle in ua:
            return label
    return "Unknown device"


def device_label(ua: str) -> str:
    """Return a human device label such as ``Chrome on Pixel 7``.

    Empty, non-string, non-ASCII, spoofed, or very large values are accepted and
    never raise. The raw UA is truncated to 256 chars before scanning, matching
    the auth audit event storage limit.
    """
    raw = _safe_ua(ua)  # type: ignore[arg-type]
    browser = _browser_label(raw)
    device = _device_label(raw)
    if browser == "Unknown browser" and device == "Unknown device":
        return "Unknown device"
    return "{} on {}".format(browser, device)

