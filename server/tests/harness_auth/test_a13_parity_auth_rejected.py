from __future__ import annotations

import logging
import re
import time
from dataclasses import dataclass
from pathlib import Path

import pytest

from app.auth import tokens
from app.auth.dependencies import COOKIE_ACCESS

from server.tests.harness_auth.scratch_server import scratch_auth_server


JETSON_LOG = Path(".jetson-snapshot/logs/homecam-server-app.log")


@dataclass(frozen=True)
class AuthRejectedShape:
    method: str
    route: str
    reason: str
    cookie_present: bool


_AUTH_REJECTED_RE = re.compile(
    r"auth rejected on (?P<method>\S+) (?P<route>\S+): "
    r"(?P<reason>.*?) \(sub=.*? cookie_present=(?P<cookie_present>True|False)\)"
)


def _captured_rest_auth_rejections() -> list[AuthRejectedShape]:
    shapes: set[AuthRejectedShape] = set()
    for line in JETSON_LOG.read_text(encoding="utf-8").splitlines():
        match = _AUTH_REJECTED_RE.search(line)
        if not match:
            continue

        method = match.group("method")
        if method == "WS":
            # TODO(A13-ws-parity): WS auth_rejected replay needs the full app
            # handshake path; A10 owns the browser-backed leg.
            continue

        shapes.add(
            AuthRejectedShape(
                method=method,
                route=match.group("route"),
                reason=match.group("reason"),
                cookie_present=match.group("cookie_present") == "True",
            )
        )
    return sorted(shapes, key=lambda shape: (shape.reason, shape.cookie_present, shape.method, shape.route))


def _auth_rejected_messages(caplog) -> list[str]:
    return [
        record.getMessage()
        for record in caplog.records
        if record.levelno == logging.WARNING
        and "auth rejected on GET /api/harness/protected:" in record.getMessage()
    ]


def _parity_plane(message: str) -> tuple[str, bool]:
    match = _AUTH_REJECTED_RE.search(message)
    assert match is not None
    # Route path, method, logger, and timestamps are deployment-specific here:
    # this parity leg pins the emitted reason string plus cookie_present flag.
    return (match.group("reason"), match.group("cookie_present") == "True")


@pytest.mark.skipif(not JETSON_LOG.exists(), reason="Jetson auth log capture is absent")
def test_given_captured_jetson_rest_auth_rejections_when_replayed_against_scratch_auth_gate_then_reason_and_cookie_flag_match(
    scratch_auth_server,
    caplog,
):
    # Given: distinct REST auth_rejected shapes captured from the real Jetson log.
    captured_shapes = _captured_rest_auth_rejections()
    assert captured_shapes

    captured_parity = {
        (shape.reason, shape.cookie_present)
        for shape in captured_shapes
        if shape.reason in {"invalid/expired: Signature has expired", "no cookie"}
    }
    assert captured_parity == {
        ("invalid/expired: Signature has expired", True),
        ("no cookie", False),
    }

    server = scratch_auth_server
    past = time.time() - server.access_token_ttl_s - 1
    expired_access = tokens.issue(
        server.user.username,
        "access",
        role=server.user.role,
        now=past,
    )

    # When: each production rejection scenario is reconstructed against the
    # scratch server's real auth dependency on an auth-gated route.
    server.client.cookies.clear()
    server.client.cookies.set(COOKIE_ACCESS, expired_access)
    with caplog.at_level(logging.WARNING):
        expired_response = server.client.get("/api/harness/protected")
    assert expired_response.status_code == 401

    server.client.cookies.clear()
    with caplog.at_level(logging.WARNING):
        no_cookie_response = server.client.get("/api/harness/protected")
    assert no_cookie_response.status_code == 401

    # Then: the scratch WARN lines match the production parity plane exactly.
    scratch_parity = {_parity_plane(message) for message in _auth_rejected_messages(caplog)}
    assert scratch_parity == captured_parity
