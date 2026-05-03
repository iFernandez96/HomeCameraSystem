"""Tests for the 1 MB request-body cap.

Pin both directions: legitimate small bodies pass, oversized ones
get 413 before they hit the route handler.
"""
import json

from fastapi.testclient import TestClient

from app.main import MAX_REQUEST_BODY_BYTES


def test_normal_body_passes(client: TestClient):
    payload = {
        "label": "person",
        "score": 0.91,
        "boxes": [{"x": 0.1, "y": 0.2, "w": 0.3, "h": 0.4,
                   "label": "person", "score": 0.91}],
        "camera_id": "cam1",
    }
    r = client.post("/api/_internal/event", json=payload)
    assert r.status_code == 200, r.text


def test_oversized_body_rejected_with_413(client: TestClient):
    # Build a body larger than the cap. We use raw bytes so the
    # boxed Pydantic validation never gets the chance to run — the
    # middleware should short-circuit on Content-Length alone.
    big = b"x" * (MAX_REQUEST_BODY_BYTES + 1)
    r = client.post(
        "/api/_internal/event",
        content=big,
        headers={"Content-Type": "application/json"},
    )
    assert r.status_code == 413
    assert "exceeds" in r.text


def test_just_under_cap_passes(client: TestClient):
    # Construct a body whose JSON-serialized length is just below
    # the cap. Pydantic will reject the unknown shape with 422 —
    # what matters here is that the *middleware* lets it through
    # (anything other than 413).
    big_str = "a" * (MAX_REQUEST_BODY_BYTES - 200)
    payload = {"label": "x" * 64, "score": 0.5, "boxes": [],
               "camera_id": "cam1", "decoy": big_str}
    body = json.dumps(payload).encode("utf-8")
    assert len(body) <= MAX_REQUEST_BODY_BYTES
    r = client.post(
        "/api/_internal/event",
        content=body,
        headers={"Content-Type": "application/json"},
    )
    assert r.status_code != 413


def test_missing_content_length_falls_through(client: TestClient):
    # When Content-Length is absent (e.g. chunked transfer), the
    # guard can't pre-check size; the request proceeds and any
    # body-size enforcement is left to downstream layers. Verify
    # we don't accidentally 413 on a normal request that happens
    # to ship without Content-Length.
    payload = {"label": "person", "score": 0.5,
               "boxes": [{"x": 0, "y": 0, "w": 0.1, "h": 0.1,
                          "label": "person", "score": 0.5}],
               "camera_id": "cam1"}
    body = json.dumps(payload).encode("utf-8")
    r = client.post(
        "/api/_internal/event",
        content=body,
        headers={"Content-Type": "application/json"},
    )
    assert r.status_code == 200, r.text


def test_garbage_content_length_falls_through(client: TestClient):
    # If Content-Length is non-numeric (broken client), we treat as
    # missing rather than 413. Defends against a benign bug; an
    # attacker could just lie about a small value anyway.
    r = client.post(
        "/api/_internal/heartbeat",
        content=b"{}",
        headers={"Content-Type": "application/json", "Content-Length": "abc"},
    )
    # The handler accepts the empty heartbeat; what we care about is
    # the request was NOT 413'd.
    assert r.status_code != 413


# --- iter-194 (iter-169 Minor S2 closure): chunked-transfer rejection ----


def test_chunked_transfer_encoding_rejected_with_411(client: TestClient):
    """iter-194 (iter-169 Minor S2): pre-iter-194 a malicious client
    could send `Transfer-Encoding: chunked` (no Content-Length) to
    bypass the body-cap and stream an arbitrarily large body before
    the route's Pydantic schema saw it. Rejected outright now —
    411 Length Required is the spec-correct status."""
    r = client.post(
        "/api/_internal/event",
        content=b"{}",
        headers={
            "Content-Type": "application/json",
            "Transfer-Encoding": "chunked",
        },
    )
    assert r.status_code == 411
    assert "chunked" in r.text.lower()


def test_chunked_transfer_rejected_case_insensitively(client: TestClient):
    """Header values should be matched case-insensitively per RFC."""
    r = client.post(
        "/api/_internal/event",
        content=b"{}",
        headers={
            "Content-Type": "application/json",
            "Transfer-Encoding": "Chunked",
        },
    )
    assert r.status_code == 411


def test_chunked_in_compound_transfer_encoding_rejected(client: TestClient):
    """Per RFC 7230 multiple TE codings can be comma-separated
    (e.g. `gzip, chunked`). Reject if `chunked` appears anywhere."""
    r = client.post(
        "/api/_internal/event",
        content=b"{}",
        headers={
            "Content-Type": "application/json",
            "Transfer-Encoding": "gzip, chunked",
        },
    )
    assert r.status_code == 411


def test_normal_request_without_transfer_encoding_passes(client: TestClient):
    """Sanity: the chunked rejection MUST NOT break normal traffic.
    Most clients (browser fetch, urllib in the worker) never set
    Transfer-Encoding for typical bodies."""
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
    r = client.post("/api/_internal/event", json=payload)
    assert r.status_code == 200
