"""Tests for the SPA catch-all and its path-traversal guard.

These tests are conditional on the client build existing on disk; if you haven't
run `npm run build` they skip with a hint.
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient


def _dist_or_skip() -> None:
    from app.config import settings

    if not settings.client_dist.exists():
        pytest.skip("client/dist not built — run `npm run build` in client/")


def test_spa_serves_index_at_root(client: TestClient):
    _dist_or_skip()
    r = client.get("/")
    assert r.status_code == 200
    body = r.content.lower()
    assert b"<html" in body or b"<!doctype" in body


def test_spa_returns_index_for_unknown_path(client: TestClient):
    _dist_or_skip()
    r = client.get("/events")
    assert r.status_code == 200
    body = r.content.lower()
    assert b"<html" in body or b"<!doctype" in body


def test_spa_serves_existing_file_under_dist(client: TestClient):
    _dist_or_skip()
    from app.config import settings

    candidate = settings.client_dist / "manifest.webmanifest"
    if not candidate.exists():
        pytest.skip("expected build artifact not present")
    r = client.get("/manifest.webmanifest")
    assert r.status_code == 200


def test_spa_blocks_path_traversal_via_encoded_dotdot(client: TestClient):
    """%2E%2E segments must not escape client_dist; the guard should fall back to index."""
    _dist_or_skip()
    # URL-encoded `../../../../etc/passwd` — TestClient/httpx should pass these
    # through without normalising the dot-segments.
    r = client.get("/%2E%2E/%2E%2E/%2E%2E/%2E%2E/etc/passwd")
    assert r.status_code == 200
    assert b"root:" not in r.content
    body = r.content.lower()
    assert b"<html" in body or b"<!doctype" in body


def test_spa_blocks_absolute_path_traversal(client: TestClient):
    """Even with a clearly-malicious path, we must not return /etc/passwd."""
    _dist_or_skip()
    r = client.get("/..%2F..%2F..%2F..%2Fetc%2Fpasswd")
    assert r.status_code == 200
    assert b"root:" not in r.content
