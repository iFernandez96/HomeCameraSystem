"""Unit tests for the uvicorn-access log filter.

Pin the suppression rules so a refactor doesn't accidentally start
flooding the journal again. The filter operates on the *formatted*
log message (uvicorn's access-log format) — we synthesize records
matching that shape rather than spinning up uvicorn for the test.
"""
import logging

from app.main import _SuppressNoisyAccess


def _make_record(msg: str) -> logging.LogRecord:
    return logging.LogRecord(
        name="uvicorn.access",
        level=logging.INFO,
        pathname=__file__,
        lineno=0,
        msg=msg,
        args=(),
        exc_info=None,
    )


def test_drops_status_polling():
    f = _SuppressNoisyAccess()
    rec = _make_record('127.0.0.1:1234 - "GET /api/status HTTP/1.1" 200 OK')
    assert f.filter(rec) is False


def test_drops_heartbeat_post():
    f = _SuppressNoisyAccess()
    rec = _make_record('172.18.0.1:5678 - "POST /api/_internal/heartbeat HTTP/1.1" 200 OK')
    assert f.filter(rec) is False


def test_suppresses_worker_event_post():
    f = _SuppressNoisyAccess()
    rec = _make_record('172.18.0.1:5678 - "POST /api/_internal/event HTTP/1.1" 200 OK')
    assert f.filter(rec) is False


def test_drops_detection_config_get_polling():
    """The worker polls GET /api/detection/config every 30 s — that's
    routine chatter, not interesting events. Suppress (iter-120)."""
    f = _SuppressNoisyAccess()
    rec = _make_record('10.0.0.50:1234 - "GET /api/detection/config HTTP/1.1" 200 OK')
    assert f.filter(rec) is False


def test_keeps_detection_config_patch():
    """A PATCH to /api/detection/config is the user editing detection
    settings via the UI — interesting, must NOT be suppressed even
    though we drop the matching GET polling chatter."""
    f = _SuppressNoisyAccess()
    rec = _make_record('10.0.0.50:1234 - "PATCH /api/detection/config HTTP/1.1" 200 OK')
    assert f.filter(rec) is True


def test_keeps_push_subscribe():
    f = _SuppressNoisyAccess()
    rec = _make_record('10.0.0.50:1234 - "POST /api/push/subscribe HTTP/1.1" 200 OK')
    assert f.filter(rec) is True


def test_keeps_status_with_different_method():
    """Only GET /api/status is the polling chatter — if someone POSTs
    or DELETEs /api/status that's interesting and should log. (Status
    is GET-only today, but lock the filter shape now.)"""
    f = _SuppressNoisyAccess()
    rec = _make_record('10.0.0.50:1234 - "DELETE /api/status HTTP/1.1" 405')
    assert f.filter(rec) is True


def test_does_not_match_prefix_requests():
    """A path with `status` as a prefix of something else shouldn't
    accidentally suppress it. We match `/api/status ` (trailing
    space — uvicorn's format includes the space before HTTP version)."""
    f = _SuppressNoisyAccess()
    rec = _make_record('10.0.0.50:1234 - "GET /api/status-page HTTP/1.1" 404')
    assert f.filter(rec) is True


def test_drops_every_shared_clip_bearer_request_line():
    f = _SuppressNoisyAccess()
    token = "opaque-share-token-that-must-not-enter-journald"
    for method, status in (("GET", 200), ("HEAD", 405), ("DELETE", 405)):
        rec = _make_record(
            '10.0.0.50:1234 - "{} /api/shared/{} HTTP/1.1" {}'.format(
                method, token, status
            )
        )
        assert f.filter(rec) is False


def test_keeps_non_token_shared_prefix_lookalike():
    f = _SuppressNoisyAccess()
    rec = _make_record(
        '10.0.0.50:1234 - "GET /api/shared HTTP/1.1" 404'
    )
    assert f.filter(rec) is True
