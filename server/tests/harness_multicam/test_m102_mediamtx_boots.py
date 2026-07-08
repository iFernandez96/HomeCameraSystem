import socket
import urllib.request

import pytest

from server.tests.harness_multicam.fixtures import (
    MEDIAMTX_SKIP_REASON,
    mediamtx_available,
)


pytestmark = pytest.mark.skipif(
    not mediamtx_available(),
    reason=MEDIAMTX_SKIP_REASON,
)


def _assert_tcp_connects(port: int) -> None:
    with socket.create_connection(("127.0.0.1", port), timeout=1.0):
        pass


def test_given_local_mediamtx_binary_when_booted_then_api_and_ports_respond(
    mediamtx_server,
):
    with urllib.request.urlopen(
        f"{mediamtx_server.api_base}/v3/config/global/get",
        timeout=1.0,
    ) as response:
        assert response.status == 200

    _assert_tcp_connects(mediamtx_server.rtsp_port)
    _assert_tcp_connects(mediamtx_server.webrtc_port)
