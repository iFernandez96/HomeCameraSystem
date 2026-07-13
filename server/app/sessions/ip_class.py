"""Dependency-free caller IP classification for session display.

The ``cellular`` bucket means "globally-routable public internet". At layer 3
we cannot distinguish a mobile carrier from any other public source, so UI copy
should surface this as "Cellular / public".

Callers pass ``request.client.host`` after Uvicorn has honored proxy headers
only from the explicit production allowlist.  Tailscale Serve terminates HTTPS
on the host and Docker forwards its loopback request through the fixed HomeCam
gateway; application code must never parse ``X-Forwarded-For`` itself.
"""
from __future__ import annotations

from ipaddress import ip_address, ip_network


_TAILSCALE_V4 = ip_network("100.64.0.0/10")
_TAILSCALE_V6 = ip_network("fd7a:115c:a1e0::/48")


def ip_class(remote_addr: str | None) -> str:
    """Classify an address as ``lan``, ``tailscale``, ``cellular``, or ``other``."""
    try:
        addr = ip_address(remote_addr or "")
    except ValueError:
        return "other"

    if addr in _TAILSCALE_V4 or addr in _TAILSCALE_V6:
        return "tailscale"
    if addr.is_private or addr.is_loopback or addr.is_link_local:
        return "lan"
    if addr.is_global:
        return "cellular"
    return "other"
