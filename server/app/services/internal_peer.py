"""Shared direct-peer and reverse-proxy checks for host-only integrations."""
from __future__ import annotations

import ipaddress
from collections.abc import Mapping


_PROXY_HEADER_NAMES = frozenset({"forwarded", "via", "x-real-ip"})
_PROXY_HEADER_PREFIXES = ("x-forwarded-", "tailscale-")


def normalize_ip(value: str) -> str | None:
    """Return a canonical address, folding IPv4-mapped IPv6 to IPv4."""
    try:
        address = ipaddress.ip_address(value.strip())
    except (AttributeError, ValueError):
        return None
    if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped:
        address = address.ipv4_mapped
    return str(address)


def trusted_peer(host: str, configured: str) -> bool:
    candidate = normalize_ip(host)
    if candidate is None:
        return False
    allowed = {
        normalized
        for raw in configured.split(",")
        if (normalized := normalize_ip(raw)) is not None
    }
    return candidate in allowed


def has_proxy_marker(headers: Mapping[str, str]) -> bool:
    """True when a direct-only request carries a reverse-proxy marker."""
    for raw_name in headers.keys():
        name = str(raw_name).lower()
        if name in _PROXY_HEADER_NAMES:
            return True
        if any(name.startswith(prefix) for prefix in _PROXY_HEADER_PREFIXES):
            return True
    return False


def peer_class(host: str, configured: str) -> str:
    normalized = normalize_ip(host)
    if normalized is None:
        return "missing"
    if trusted_peer(normalized, configured):
        return "direct"
    if ipaddress.ip_address(normalized).is_loopback:
        return "loopback-other"
    return "remote"
