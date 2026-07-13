"""PR-104 proxy-hop and canonical client-address boundary tests."""
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient
from uvicorn.middleware.proxy_headers import ProxyHeadersMiddleware

from app.services.login_backoff import canonical_source_address


TRUSTED_HOPS = "127.0.0.1,::1,172.30.0.1"


def _proxy_test_app():
    inner = FastAPI()

    @inner.get("/peer")
    async def peer(request: Request):
        host = request.client.host if request.client else None
        return {
            "host": host,
            "canonical": canonical_source_address(host),
            "scheme": request.url.scheme,
        }

    return ProxyHeadersMiddleware(inner, trusted_hosts=TRUSTED_HOPS)


def test_given_fixed_docker_gateway_when_tailscale_forwards_then_client_is_adopted():
    # arrange
    client = TestClient(
        _proxy_test_app(),
        client=("172.30.0.1", 50000),
        base_url="http://homecam.test",
    )

    # act
    response = client.get(
        "/peer",
        headers={
            "X-Forwarded-For": "100.64.10.20",
            "X-Forwarded-Proto": "https",
        },
    )

    # assert
    assert response.json() == {
        "host": "100.64.10.20",
        "canonical": "100.64.10.20",
        "scheme": "https",
    }


def test_given_caller_supplied_xff_when_tailscale_appends_then_nearest_untrusted_peer_wins():
    # arrange: Tailscale Serve appends its authenticated source to an existing
    # caller header.  Uvicorn must walk from the trusted Docker hop outward and
    # stop at that nearest untrusted peer, not accept the caller's leftmost IP.
    client = TestClient(
        _proxy_test_app(),
        client=("172.30.0.1", 50000),
        base_url="http://homecam.test",
    )

    # act
    response = client.get(
        "/peer",
        headers={
            "X-Forwarded-For": "203.0.113.9, 100.64.10.20",
            "X-Forwarded-Proto": "https",
        },
    )

    # assert
    assert response.json() == {
        "host": "100.64.10.20",
        "canonical": "100.64.10.20",
        "scheme": "https",
    }


def test_given_untrusted_peer_when_it_spoofs_headers_then_socket_peer_wins():
    # arrange
    client = TestClient(
        _proxy_test_app(),
        client=("172.30.0.99", 50000),
        base_url="http://homecam.test",
    )

    # act
    response = client.get(
        "/peer",
        headers={
            "X-Forwarded-For": "100.64.10.20",
            "X-Forwarded-Proto": "https",
        },
    )

    # assert
    assert response.json() == {
        "host": "172.30.0.99",
        "canonical": "172.30.0.99",
        "scheme": "http",
    }
