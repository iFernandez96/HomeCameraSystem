"""Unit tests for the minimal sd_notify client.

Run from `detection/`:
    /tmp/homecam-venv/bin/python -m pytest tests/test_sdnotify.py -q
"""
import socket
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import sdnotify  # noqa: E402


def _reset():
    """Clear the module-level address cache between tests."""
    sdnotify._resolved = False
    sdnotify._addr = None


def test_given_no_notify_socket_then_calls_are_noops(monkeypatch):
    # arrange
    monkeypatch.delenv("NOTIFY_SOCKET", raising=False)
    _reset()
    # act + assert — never raises, reports disabled, returns False.
    assert sdnotify.enabled() is False
    assert sdnotify.ready() is False
    assert sdnotify.watchdog() is False


def test_given_a_notify_socket_then_ready_and_watchdog_datagrams_are_sent(
    tmp_path, monkeypatch
):
    # arrange — a real datagram socket standing in for systemd's.
    sock_path = str(tmp_path / "notify.sock")
    srv = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
    srv.bind(sock_path)
    srv.settimeout(2.0)
    monkeypatch.setenv("NOTIFY_SOCKET", sock_path)
    _reset()
    try:
        # act + assert — READY=1 then WATCHDOG=1 land on the socket.
        assert sdnotify.enabled() is True
        assert sdnotify.ready() is True
        assert srv.recvfrom(64)[0] == b"READY=1"
        assert sdnotify.watchdog() is True
        assert srv.recvfrom(64)[0] == b"WATCHDOG=1"
    finally:
        srv.close()


def test_given_abstract_socket_path_then_leading_at_becomes_nul(monkeypatch):
    # arrange — systemd uses the abstract namespace ('@' → leading NUL).
    monkeypatch.setenv("NOTIFY_SOCKET", "@/org/freedesktop/systemd1/notify")
    _reset()
    # act
    sdnotify._resolve()
    # assert
    assert sdnotify._addr == "\0/org/freedesktop/systemd1/notify"
