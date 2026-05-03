"""Tests for the iter-106 GZip middleware.

Pin: clients that opt in via `Accept-Encoding: gzip` get a gzipped
response, the security headers from iter-103 still apply, and small
responses fall through uncompressed.
"""
import json

from fastapi.testclient import TestClient


def _seed_history(client: TestClient, n: int) -> None:
    """Push enough events to make /api/events?limit=N a >1 KB JSON
    payload so it crosses the GZip middleware's minimum_size threshold."""
    payload = {
        "label": "person",
        "score": 0.91,
        "boxes": [
            {
                "x": 0.1, "y": 0.2, "w": 0.3, "h": 0.4,
                "label": "person", "score": 0.91,
            }
        ],
        "camera_id": "cam1",
    }
    for _ in range(n):
        client.post("/api/_internal/event", json=payload)


def test_large_events_response_is_gzipped(client: TestClient):
    _seed_history(client, 30)
    r = client.get("/api/events?limit=30", headers={"Accept-Encoding": "gzip"})
    assert r.status_code == 200
    assert r.headers.get("content-encoding") == "gzip"
    # `httpx` (TestClient's transport) transparently decompresses, so
    # the parsed body is a normal JSON list — what matters here is the
    # encoding header and the compressed bytes-on-the-wire ratio.
    body = r.json()
    assert isinstance(body, list)
    assert len(body) >= 30


def test_small_status_response_is_not_gzipped(client: TestClient):
    """The /api/status payload is well under 1 KB. Compressing it would
    waste CPU on every poll without saving meaningful bandwidth."""
    r = client.get("/api/status", headers={"Accept-Encoding": "gzip"})
    assert r.status_code == 200
    # No content-encoding because we're below the minimum_size threshold.
    assert "content-encoding" not in {k.lower() for k in r.headers.keys()}


def test_gzipped_response_still_carries_security_headers(client: TestClient):
    """iter-103's middleware wraps the gzip-compressed response — the
    X-* headers must still be present on a gzipped 200."""
    _seed_history(client, 30)
    r = client.get("/api/events?limit=30", headers={"Accept-Encoding": "gzip"})
    assert r.headers.get("content-encoding") == "gzip"
    assert r.headers.get("x-content-type-options") == "nosniff"
    assert r.headers.get("x-frame-options") == "DENY"
    assert r.headers.get("referrer-policy") == "same-origin"


def test_no_accept_encoding_means_no_gzip(client: TestClient):
    """Clients that don't advertise gzip support get the raw response.
    The worker's stdlib `urllib.request` falls in this bucket — its
    POST handlers parse the JSON synchronously and don't expect a
    `Content-Encoding: gzip` body."""
    _seed_history(client, 30)
    # TestClient (httpx) auto-adds Accept-Encoding by default; force it
    # off explicitly via identity to mimic urllib's behaviour.
    r = client.get(
        "/api/events?limit=30",
        headers={"Accept-Encoding": "identity"},
    )
    assert r.status_code == 200
    assert r.headers.get("content-encoding") in (None, "identity")
    # Body is plain JSON; can be parsed without decompression.
    parsed = json.loads(r.content.decode("utf-8"))
    assert isinstance(parsed, list)
