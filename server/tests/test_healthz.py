"""iter-195: /healthz liveness endpoint.

Closes both:
- iter-169 carry-forward "healthcheck-no-actor" (operator now has
  a defined liveness surface; docker-compose healthcheck reacts
  via `restart: unless-stopped` on container exit).
- A bug iter-184 silently introduced: the previous healthcheck hit
  `/api/status` which became auth-gated, so a cookieless curl probe
  would 401 forever and the container would auto-mark unhealthy
  after deploy.

The route MUST stay anonymous (no auth gate) and at root (NOT under
`/api/*`) — Docker / K8s probes don't speak browser cookies.
"""
from __future__ import annotations

from fastapi.testclient import TestClient


def test_healthz_returns_200_anonymously(client_anon: TestClient):
    """No cookie required — root-level route, NOT gated."""
    r = client_anon.get("/healthz")
    assert r.status_code == 200


def test_healthz_returns_ok_true(client_anon: TestClient):
    """Body shape pinned: docker-compose healthcheck uses curl -fsS
    (fail on non-2xx, silent, show errors), so the body content
    doesn't strictly matter — but pinning the shape protects
    future operators who write fancier probes against drift."""
    r = client_anon.get("/healthz")
    assert r.json() == {"ok": True}


def test_healthz_content_type_is_json(client_anon: TestClient):
    r = client_anon.get("/healthz")
    assert r.headers.get("content-type", "").startswith("application/json")


def test_healthz_works_when_authed_too(client: TestClient):
    """The default `client` fixture is auto-authed (iter-184). Pin
    that the auth cookie doesn't accidentally break /healthz —
    a cookie-presented request to an ungated route should pass
    cleanly through the middleware stack."""
    r = client.get("/healthz")
    assert r.status_code == 200
