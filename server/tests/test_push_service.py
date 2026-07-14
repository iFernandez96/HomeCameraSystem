"""Direct unit tests for PushService — webpush is mocked."""
from __future__ import annotations

import json
from unittest.mock import MagicMock, patch

import pytest

from app.services.push_service import PushService


@pytest.fixture
def service(tmp_path) -> PushService:
    """Fresh PushService with persistence pointed at a tmp file so tests
    don't leak state across each other or pick up a stale ./push_subs.json
    from the working directory."""
    return PushService(persist_path=tmp_path / "subs.json")


def test_add_dedupes_by_endpoint(service: PushService):
    sub = {"endpoint": "https://push/x", "keys": {"p256dh": "a", "auth": "b"}}
    service.add(sub)
    service.add(sub)
    assert len(service.subs) == 1


def test_add_accepts_distinct_endpoints(service: PushService):
    service.add({"endpoint": "a", "keys": {}})
    service.add({"endpoint": "b", "keys": {}})
    assert len(service.subs) == 2


def test_remove_returns_true_when_endpoint_present(service: PushService):
    service.add({"endpoint": "a", "keys": {}})
    assert service.remove("a") is True
    assert service.subs == []


def test_remove_returns_false_when_endpoint_unknown(service: PushService):
    service.add({"endpoint": "a", "keys": {}})
    assert service.remove("nope") is False
    assert len(service.subs) == 1


async def test_send_all_returns_zero_when_no_keys_loaded(service: PushService):
    service.add({"endpoint": "x", "keys": {"p256dh": "a", "auth": "b"}})
    assert service.private_pem is None
    sent = await service.send_all({"title": "x"})
    assert sent == 0


async def test_send_all_no_keys_does_not_warn_per_call(service: PushService, caplog):
    """`load_keys()` already warns once on startup if VAPID keys are
    missing — `send_all` should NOT re-warn on every detection event
    (would be log spam on a busy day). iter-129 demoted the per-call
    message to DEBUG."""
    import logging as _logging

    service.add({"endpoint": "x", "keys": {"p256dh": "a", "auth": "b"}})
    assert service.private_pem is None
    with caplog.at_level(_logging.WARNING, logger="app.services.push_service"):
        await service.send_all({"title": "x"})
    warns = [r for r in caplog.records if "no VAPID key" in r.getMessage()]
    assert warns == [], f"expected no WARNING-level vapid messages, got {warns}"


async def test_send_all_returns_zero_when_no_subscribers(service: PushService):
    service.private_pem = b"-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----"
    sent = await service.send_all({"title": "x"})
    assert sent == 0


async def test_send_all_dispatches_to_each_subscription(service: PushService):
    service.private_pem = b"-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----"
    service.add({"endpoint": "a", "keys": {"p256dh": "1", "auth": "2"}})
    service.add({"endpoint": "b", "keys": {"p256dh": "3", "auth": "4"}})

    with patch("app.services.push_service.webpush") as mock_wp:
        mock_wp.return_value = None
        sent = await service.send_all({"title": "t", "body": "b"})

    assert sent == 2
    assert mock_wp.call_count == 2


async def test_when_load_keys_runs_then_vapid_obj_is_built_and_used_in_webpush(
    service: PushService, tmp_path: Path
):
    # arrange — write a real VAPID PKCS8 EC P-256 key (the format
    # `gen_vapid` produces) to disk and point the service at it.
    # This pins the iter-244e regression: pywebpush 2.3.0 rejects raw
    # PEM strings with "ASN.1 parsing error" but accepts a `Vapid`
    # instance.
    from cryptography.hazmat.backends import default_backend
    from cryptography.hazmat.primitives import serialization as _s
    from cryptography.hazmat.primitives.asymmetric import ec
    from py_vapid import Vapid as _Vapid

    priv = ec.generate_private_key(ec.SECP256R1(), default_backend())
    priv_pem = priv.private_bytes(
        encoding=_s.Encoding.PEM,
        format=_s.PrivateFormat.PKCS8,
        encryption_algorithm=_s.NoEncryption(),
    )
    pub_pem = priv.public_key().public_bytes(
        encoding=_s.Encoding.PEM,
        format=_s.PublicFormat.SubjectPublicKeyInfo,
    )
    priv_path = tmp_path / "vapid_private.pem"
    pub_path = tmp_path / "vapid_public.pem"
    priv_path.write_bytes(priv_pem)
    pub_path.write_bytes(pub_pem)

    from app.config import settings as _settings

    monkey_priv = _settings.vapid_private_key_path
    monkey_pub = _settings.vapid_public_key_path
    _settings.vapid_private_key_path = priv_path
    _settings.vapid_public_key_path = pub_path

    # act
    try:
        service.load_keys()
        service.add({"endpoint": "x", "keys": {"p256dh": "p", "auth": "a"}})
        with patch("app.services.push_service.webpush") as mock_wp:
            mock_wp.return_value = None
            await service.send_all({"title": "t"})
    finally:
        _settings.vapid_private_key_path = monkey_priv
        _settings.vapid_public_key_path = monkey_pub

    # assert
    assert isinstance(service._vapid_obj, _Vapid)
    assert mock_wp.call_count == 1
    # The vapid_private_key kwarg must be the Vapid OBJECT (not the
    # raw PEM bytes) so pywebpush 2.3.0+ doesn't ASN.1-fail.
    _args, kwargs = mock_wp.call_args
    assert isinstance(kwargs["vapid_private_key"], _Vapid)


async def test_send_all_drops_410_subscriptions(service: PushService):
    from pywebpush import WebPushException

    service.private_pem = b"fake-pem"
    service.add({"endpoint": "gone", "keys": {"p256dh": "a", "auth": "b"}})
    service.add({"endpoint": "ok", "keys": {"p256dh": "c", "auth": "d"}})

    def fake_webpush(subscription_info, **_kwargs):
        if subscription_info["endpoint"] == "gone":
            resp = MagicMock()
            resp.status_code = 410
            raise WebPushException("expired", response=resp)
        return None

    with patch("app.services.push_service.webpush", side_effect=fake_webpush):
        sent = await service.send_all({"title": "t"})

    assert sent == 1
    assert len(service.subs) == 1
    assert service.subs[0]["endpoint"] == "ok"


async def test_readonly_sender_never_prunes_shared_subscriptions(service: PushService):
    from pywebpush import WebPushException

    service.private_pem = b"fake-pem"
    service.add({"endpoint": "gone", "keys": {"p256dh": "a", "auth": "b"}})
    before = service.persist_path.read_bytes()
    response = MagicMock()
    response.status_code = 410

    with patch(
        "app.services.push_service.webpush",
        side_effect=WebPushException("expired", response=response),
    ):
        sent = await service.send_all_readonly({"title": "operational alert"})

    assert sent == 0
    assert [sub["endpoint"] for sub in service.subs] == ["gone"]
    assert service.persist_path.read_bytes() == before


async def test_send_all_keeps_404_subscriptions(service: PushService):
    """404 also indicates a dead subscription per the WebPush spec; ensure both
    404 and 410 are pruned."""
    from pywebpush import WebPushException

    service.private_pem = b"fake-pem"
    service.add({"endpoint": "missing", "keys": {"p256dh": "a", "auth": "b"}})
    service.add({"endpoint": "live", "keys": {"p256dh": "c", "auth": "d"}})

    def fake_webpush(subscription_info, **_kwargs):
        if subscription_info["endpoint"] == "missing":
            resp = MagicMock()
            resp.status_code = 404
            raise WebPushException("not found", response=resp)
        return None

    with patch("app.services.push_service.webpush", side_effect=fake_webpush):
        sent = await service.send_all({"title": "t"})

    assert sent == 1
    assert [s["endpoint"] for s in service.subs] == ["live"]


async def test_send_all_keeps_subs_on_transient_failure(service: PushService):
    """A 5xx means try later; we must not drop the subscription."""
    from pywebpush import WebPushException

    service.private_pem = b"fake-pem"
    service.add({"endpoint": "rate-limited", "keys": {"p256dh": "a", "auth": "b"}})

    def fake_webpush(subscription_info, **_kwargs):
        resp = MagicMock()
        resp.status_code = 503
        raise WebPushException("rate limited", response=resp)

    with patch("app.services.push_service.webpush", side_effect=fake_webpush):
        sent = await service.send_all({"title": "t"})

    assert sent == 0
    assert len(service.subs) == 1


async def test_send_all_swallows_non_webpush_exceptions(
    service: PushService, caplog
):
    """iter-165: pywebpush is a thin wrapper around `requests` and TLS;
    a network-layer issue (ConnectionError, ssl.SSLError) or a buggy
    library release can raise something OTHER than `WebPushException`.
    Pre-iter-165, `send_one` only caught `WebPushException`, so the
    non-WebPush exception propagated through `asyncio.gather` and
    surfaced as HTTP 500 on `POST /api/push/test` — violating the
    documented `{ok, sent: N}` contract. This test mocks `webpush` to
    raise a bare `ConnectionError` and asserts:
      1. `send_all` returns 0 (count) without raising.
      2. The subscription is NOT pruned (transient errors mustn't
         drop subs — only explicit 404/410 from the gateway should).
      3. A warning is logged with the exception class name so a real
         outage is diagnosable in the journal."""
    service.private_pem = b"fake-pem"
    service.add(
        {"endpoint": "https://push.example/x", "keys": {"p256dh": "a", "auth": "b"}}
    )

    def fake_webpush(subscription_info, **_kwargs):
        raise ConnectionError("TLS handshake failed")

    with patch("app.services.push_service.webpush", side_effect=fake_webpush):
        with caplog.at_level("WARNING"):
            sent = await service.send_all({"title": "t"})

    assert sent == 0
    assert len(service.subs) == 1
    # Log line names the exception type + the endpoint HOST (never the
    # full endpoint — it carries a device secret) so a future operator
    # can grep journalctl for "transient error (ConnectionError)" and
    # find the failure class without reading the message body.
    assert any(
        "transient error" in r.message and "ConnectionError" in r.message
        for r in caplog.records
    )
    # GUARDRAIL: the per-device endpoint secret (the path after the
    # host) must NEVER appear in any log line.
    assert not any("/x" in r.getMessage() for r in caplog.records)


def test_load_keys_handles_corrupt_pem_gracefully(tmp_path, monkeypatch, caplog):
    """iter-170: pre-iter-170 a corrupt VAPID PEM (volume race on first
    container boot, mid-rotation half-write, operator regenerated keys
    while running) raised `ValueError`/`UnsupportedAlgorithm` from
    `serialization.load_pem_public_key`, propagated through the module
    import chain in `app/services/push_service.py:205-206`, and crashed
    the FastAPI app before lifespan even started — no SPA, no
    `/api/status`, no diagnostic. Now `load_keys` catches the parse
    error, logs a warning naming the exception class, sets
    `private_pem`/`public_key_b64` to None, and returns. Push is
    disabled (send_all already no-ops on `private_pem is None`) but the
    server starts and the rest of the app is usable.
    """
    from app.services import push_service as ps
    priv_path = tmp_path / "vapid_private.pem"
    pub_path = tmp_path / "vapid_public.pem"
    priv_path.write_bytes(b"not-a-pem")
    pub_path.write_bytes(b"also-not-a-pem")
    monkeypatch.setattr(ps.settings, "vapid_private_key_path", priv_path)
    monkeypatch.setattr(ps.settings, "vapid_public_key_path", pub_path)
    s = PushService(persist_path=tmp_path / "subs.json")
    with caplog.at_level("WARNING"):
        s.load_keys()
    assert s.private_pem is None
    assert s.public_key_b64 is None
    # Log line must name the exception class so a future operator can
    # grep journalctl for "VAPID keys ... could not be loaded".
    assert any(
        "VAPID keys" in r.message and "could not be loaded" in r.message
        for r in caplog.records
    )


def test_load_keys_handles_unreadable_private_pem(tmp_path, monkeypatch):
    """iter-170: an OSError on `priv.read_bytes()` (permission flip,
    half-mounted volume) must NOT crash the import chain. Cover with a
    file the kernel will refuse to read.
    """
    from app.services import push_service as ps
    import os
    priv_path = tmp_path / "vapid_private.pem"
    pub_path = tmp_path / "vapid_public.pem"
    priv_path.write_bytes(b"ignored")
    pub_path.write_bytes(b"ignored")
    # Strip read permission. (Note: skip if running as root — test_skip,
    # not test_fail — root can read 0o000 files.)
    priv_path.chmod(0o000)
    if os.geteuid() == 0:
        priv_path.chmod(0o600)
        pytest.skip("test runs as root; chmod 0o000 doesn't restrict it")
    monkeypatch.setattr(ps.settings, "vapid_private_key_path", priv_path)
    monkeypatch.setattr(ps.settings, "vapid_public_key_path", pub_path)
    try:
        s = PushService(persist_path=tmp_path / "subs.json")
        s.load_keys()  # must not raise
        assert s.private_pem is None
        assert s.public_key_b64 is None
    finally:
        priv_path.chmod(0o600)  # so tmp_path cleanup works


async def test_send_all_keeps_other_subs_when_one_raises_unexpectedly(
    service: PushService,
):
    """iter-165 companion: even when one sub raises a non-WebPush
    exception, OTHER subs must still be delivered. Pre-fix, the
    `asyncio.gather` would short-circuit on the first non-WebPush
    raise and zero out the count. Now each sub is handled
    independently."""
    from pywebpush import WebPushException

    service.private_pem = b"fake-pem"
    service.add(
        {"endpoint": "https://push.example/ok", "keys": {"p256dh": "a", "auth": "b"}}
    )
    service.add(
        {"endpoint": "https://push.example/boom", "keys": {"p256dh": "c", "auth": "d"}}
    )

    def fake_webpush(subscription_info, **_kwargs):
        if subscription_info["endpoint"].endswith("/boom"):
            raise OSError("kernel ate the packet")
        return None  # success path

    with patch("app.services.push_service.webpush", side_effect=fake_webpush):
        sent = await service.send_all({"title": "t"})

    # The healthy sub still received its push.
    assert sent == 1
    # Both subs preserved — neither got pruned.
    assert len(service.subs) == 2


# --- persistence -----------------------------------------------------------


def test_add_persists_to_disk(tmp_path):
    path = tmp_path / "subs.json"
    s = PushService(persist_path=path)
    s.add({"endpoint": "https://push/x", "keys": {"p256dh": "a", "auth": "b"}})
    assert path.exists()
    import json
    saved = json.loads(path.read_text())
    assert isinstance(saved, list)
    assert len(saved) == 1
    assert saved[0]["endpoint"] == "https://push/x"


def test_load_subs_on_init(tmp_path):
    path = tmp_path / "subs.json"
    path.write_text(
        '[{"endpoint":"https://push/y","keys":{"p256dh":"a","auth":"b"}}]'
    )
    s = PushService(persist_path=path)
    assert len(s.subs) == 1
    assert s.subs[0]["endpoint"] == "https://push/y"


def test_load_subs_handles_missing_file(tmp_path):
    path = tmp_path / "missing.json"
    s = PushService(persist_path=path)
    assert s.subs == []


def test_load_subs_handles_corrupt_file(tmp_path):
    path = tmp_path / "subs.json"
    path.write_text("not valid json {")
    s = PushService(persist_path=path)
    assert s.subs == []


def test_load_subs_ignores_non_list_top_level(tmp_path):
    path = tmp_path / "subs.json"
    path.write_text('{"endpoint":"x"}')
    s = PushService(persist_path=path)
    assert s.subs == []


def test_load_subs_filters_malformed_entries(tmp_path):
    """The fully-formed sub should survive; entries that don't match
    the route's iter-98 shape (string + length-bounded) are dropped."""
    path = tmp_path / "subs.json"
    valid = (
        '{"endpoint":"https://push.example/x",'
        '"keys":{"p256dh":"abc","auth":"def"}}'
    )
    path.write_text(
        f'[{valid}, "garbage", {{"no_endpoint": true}}, {{"endpoint":"x"}}]'
    )
    s = PushService(persist_path=path)
    assert len(s.subs) == 1
    assert s.subs[0]["endpoint"] == "https://push.example/x"


def test_load_subs_drops_oversized_endpoint(tmp_path):
    """A legacy sub persisted before iter-98's route caps with a
    long endpoint must be scrubbed at load — without this, the
    route can't 422-reject a payload that's already on disk."""
    import json as _json
    path = tmp_path / "subs.json"
    big_endpoint = "https://push.example/" + "x" * 5000
    path.write_text(_json.dumps([
        {"endpoint": big_endpoint, "keys": {"p256dh": "a", "auth": "b"}},
        {"endpoint": "https://push.example/ok",
         "keys": {"p256dh": "a", "auth": "b"}},
    ]))
    s = PushService(persist_path=path)
    assert len(s.subs) == 1
    assert s.subs[0]["endpoint"] == "https://push.example/ok"


def test_load_subs_drops_oversized_p256dh(tmp_path):
    import json as _json
    path = tmp_path / "subs.json"
    path.write_text(_json.dumps([
        {"endpoint": "https://push.example/bad",
         "keys": {"p256dh": "x" * 500, "auth": "b"}},
        {"endpoint": "https://push.example/ok",
         "keys": {"p256dh": "a", "auth": "b"}},
    ]))
    s = PushService(persist_path=path)
    assert [x["endpoint"] for x in s.subs] == ["https://push.example/ok"]


def test_load_subs_logs_dropped_count_when_filtering(tmp_path, caplog):
    """When `_load_subs` filters malformed entries, it logs a WARNING
    with the count so operators see "dropped N" in the journal after
    a server upgrade. iter-109 added the log; pin it so a future
    refactor doesn't silently drop the visibility."""
    import json as _json
    import logging as _logging

    path = tmp_path / "subs.json"
    path.write_text(_json.dumps([
        # Two malformed: empty endpoint + over-cap p256dh
        {"endpoint": "", "keys": {"p256dh": "a", "auth": "b"}},
        {"endpoint": "https://push/over",
         "keys": {"p256dh": "x" * 500, "auth": "b"}},
        # One valid
        {"endpoint": "https://push/ok",
         "keys": {"p256dh": "a", "auth": "b"}},
    ]))
    with caplog.at_level(_logging.WARNING, logger="app.services.push_service"):
        s = PushService(persist_path=path)

    assert len(s.subs) == 1
    drop_warnings = [
        r for r in caplog.records
        if "dropped" in r.getMessage() and "malformed" in r.getMessage()
    ]
    assert len(drop_warnings) == 1
    assert "2" in drop_warnings[0].getMessage(), (
        f"expected the warning to mention the count 2, got "
        f"{drop_warnings[0].getMessage()!r}"
    )


def test_load_subs_drops_missing_keys_dict(tmp_path):
    """A sub with `keys` set to something other than a dict (or missing
    entirely) is not usable by webpush. Drop at load."""
    import json as _json
    path = tmp_path / "subs.json"
    path.write_text(_json.dumps([
        {"endpoint": "https://push.example/no-keys"},
        {"endpoint": "https://push.example/wrong-shape", "keys": "abc"},
        {"endpoint": "https://push.example/ok",
         "keys": {"p256dh": "a", "auth": "b"}},
    ]))
    s = PushService(persist_path=path)
    assert [x["endpoint"] for x in s.subs] == ["https://push.example/ok"]


def test_remove_persists_to_disk(tmp_path):
    path = tmp_path / "subs.json"
    s = PushService(persist_path=path)
    s.add({"endpoint": "a", "keys": {}})
    s.add({"endpoint": "b", "keys": {}})
    s.remove("a")
    import json
    saved = json.loads(path.read_text())
    assert len(saved) == 1
    assert saved[0]["endpoint"] == "b"


async def test_dead_sub_prune_persists(tmp_path):
    """When send_all encounters 410/404 it removes the sub — that must hit disk
    too, otherwise the dead sub comes back on next restart."""
    from pywebpush import WebPushException

    path = tmp_path / "subs.json"
    s = PushService(persist_path=path)
    s.private_pem = b"fake-pem"
    s.add({"endpoint": "gone", "keys": {"p256dh": "a", "auth": "b"}})
    s.add({"endpoint": "ok", "keys": {"p256dh": "c", "auth": "d"}})

    def fake_webpush(subscription_info, **_kwargs):
        if subscription_info["endpoint"] == "gone":
            resp = MagicMock()
            resp.status_code = 410
            raise WebPushException("expired", response=resp)
        return None

    with patch("app.services.push_service.webpush", side_effect=fake_webpush):
        await s.send_all({"title": "t"})

    import json
    saved = json.loads(path.read_text())
    assert [x["endpoint"] for x in saved] == ["ok"]


def test_persist_uses_atomic_rename(tmp_path):
    """If save is interrupted mid-write, the file should never be partial.
    Verify the implementation uses a temp file + rename rather than an
    in-place truncate."""
    path = tmp_path / "subs.json"
    s = PushService(persist_path=path)
    s.add({"endpoint": "a", "keys": {}})
    # No .tmp file should be left lying around after a successful save.
    leftover = list(tmp_path.glob("*.tmp"))
    assert leftover == []


# --- iter-205 (Feature #4 slice 1): backwards-compat for legacy subs ---


def test_legacy_sub_loads_with_user_id_and_filters_defaulted(tmp_path):
    """Pre-iter-205 subs on disk lack `user_id` and `filters`. Loader
    must accept them and fill the iter-205 keys with None defaults so
    slice 2's `send_matching` sees a uniform shape."""
    import json as _json
    legacy = [
        {
            "endpoint": "https://push.example/legacy",
            "keys": {"p256dh": "p", "auth": "a"},
        }
    ]
    path = tmp_path / "subs.json"
    path.write_text(_json.dumps(legacy))
    s = PushService(persist_path=path)
    assert len(s.subs) == 1
    assert s.subs[0]["user_id"] is None
    assert s.subs[0]["filters"] is None


def test_loaded_sub_with_invalid_user_id_type_is_dropped(tmp_path):
    """user_id must be a non-empty string when present. An int (or
    empty string) drops the whole sub — defensive against corrupt
    persist files."""
    import json as _json
    path = tmp_path / "subs.json"
    path.write_text(_json.dumps([
        {
            "endpoint": "https://push.example/bad",
            "keys": {"p256dh": "p", "auth": "a"},
            "user_id": 42,
        }
    ]))
    s = PushService(persist_path=path)
    assert s.subs == []


def test_loaded_sub_with_malformed_filters_dict_strips_bad_fields(tmp_path):
    """If filters is a dict but its inner lists are malformed
    (non-string entries, oversized strings, non-list value), the
    loader strips the bad fields rather than dropping the whole sub.
    Operator's manual edit shouldn't lose their endpoint."""
    import json as _json
    path = tmp_path / "subs.json"
    path.write_text(_json.dumps([
        {
            "endpoint": "https://push.example/x",
            "keys": {"p256dh": "p", "auth": "a"},
            "user_id": "alice",
            "filters": {
                "cameras": [123, "cam1", "x" * 100, "cam2"],
                "person_names": "not-a-list",
            },
        }
    ]))
    s = PushService(persist_path=path)
    assert len(s.subs) == 1
    # Non-string + oversized stripped; valid entries preserved.
    assert s.subs[0]["filters"]["cameras"] == ["cam1", "cam2"]
    # Non-list person_names → None (dropped).
    assert s.subs[0]["filters"]["person_names"] is None


def test_loaded_sub_caps_filter_lists_at_16(tmp_path):
    """Same bound as the route's PushFilters max_length=16. Defends
    against operator manually editing in 50 cameras."""
    import json as _json
    path = tmp_path / "subs.json"
    path.write_text(_json.dumps([
        {
            "endpoint": "https://push.example/x",
            "keys": {"p256dh": "p", "auth": "a"},
            "user_id": "alice",
            "filters": {"cameras": ["c{}".format(i) for i in range(25)]},
        }
    ]))
    s = PushService(persist_path=path)
    assert len(s.subs[0]["filters"]["cameras"]) == 16


def test_loaded_sub_with_filters_not_a_dict_is_dropped(tmp_path):
    """filters as a list / string / int → invalid; whole sub drops."""
    import json as _json
    path = tmp_path / "subs.json"
    path.write_text(_json.dumps([
        {
            "endpoint": "https://push.example/x",
            "keys": {"p256dh": "p", "auth": "a"},
            "filters": "not-a-dict",
        }
    ]))
    s = PushService(persist_path=path)
    assert s.subs == []


# --- iter-206 (Feature #4 slice 2): send_matching filter evaluation ---


from app.services.push_service import _sub_matches_event  # noqa: E402


def _evt(**over):
    """Helper: minimal detection event dict."""
    e = {
        "v": 1,
        "type": "detection",
        "id": "evt-1",
        "ts": 1700000000.0,
        "camera_id": "cam1",
        "label": "person",
        "score": 0.91,
        "boxes": [],
        "thumb_url": None,
        "person_name": None,
        "clip_url": None,
    }
    e.update(over)
    return e


def test_sub_with_null_filters_matches_every_event():
    """Legacy / iter-205 default. Preserves pre-iter-206 fanout."""
    sub = {"endpoint": "x", "keys": {}, "user_id": "alice", "filters": None}
    assert _sub_matches_event(sub, _evt()) is True
    assert _sub_matches_event(sub, _evt(camera_id="cam2")) is True


def test_sub_with_camera_filter_matches_listed_camera():
    sub = {"endpoint": "x", "keys": {}, "filters": {"cameras": ["cam1"]}}
    assert _sub_matches_event(sub, _evt(camera_id="cam1")) is True


def test_sub_with_camera_filter_rejects_non_listed_camera():
    sub = {"endpoint": "x", "keys": {}, "filters": {"cameras": ["cam1"]}}
    assert _sub_matches_event(sub, _evt(camera_id="cam2")) is False


def test_sub_with_empty_camera_list_matches_nothing():
    """Empty list is distinct from None — explicitly opts out of all
    cameras. Useful for "I'm on vacation, mute everything" toggle."""
    sub = {"endpoint": "x", "keys": {}, "filters": {"cameras": []}}
    assert _sub_matches_event(sub, _evt(camera_id="cam1")) is False


def test_sub_with_person_name_filter_matches_listed_name():
    sub = {
        "endpoint": "x", "keys": {},
        "filters": {"person_names": ["israel"]},
    }
    assert _sub_matches_event(sub, _evt(person_name="israel")) is True


def test_sub_with_person_name_filter_rejects_unlisted_name():
    sub = {
        "endpoint": "x", "keys": {},
        "filters": {"person_names": ["israel"]},
    }
    assert _sub_matches_event(sub, _evt(person_name="bob")) is False


def test_sub_with_person_name_filter_rejects_unrecognized_event():
    """When `person_name` filter is set but the event has no face match
    (person_name=None), the sub does NOT receive the push. Lets a user
    say 'only fire on recognized people' to filter generic motion."""
    sub = {
        "endpoint": "x", "keys": {},
        "filters": {"person_names": ["israel"]},
    }
    assert _sub_matches_event(sub, _evt(person_name=None)) is False


def test_sub_with_both_filters_ANDs_together():
    """cameras=['cam1'] + person_names=['israel'] → both must match."""
    sub = {
        "endpoint": "x", "keys": {},
        "filters": {"cameras": ["cam1"], "person_names": ["israel"]},
    }
    assert _sub_matches_event(sub, _evt(camera_id="cam1", person_name="israel")) is True
    assert _sub_matches_event(sub, _evt(camera_id="cam2", person_name="israel")) is False
    assert _sub_matches_event(sub, _evt(camera_id="cam1", person_name="bob")) is False


# iter-209 (Feature #4 slice 4): schedule_window filter — time-of-day
# push gating. Window bounds are HH:MM, server local time. We pin
# the per-event evaluation through the existing `_sub_matches_event`
# entry point so the AND-with-other-filters semantics are exercised.

def _ts_at(hour: int, minute: int = 0) -> float:
    """Return a unix timestamp whose local-time clock reads HH:MM
    today. Tests run wherever pytest does, so we anchor against the
    machine's TZ rather than asserting absolute epoch values."""
    import time as _t
    lt = _t.localtime()
    target = _t.struct_time(
        (lt.tm_year, lt.tm_mon, lt.tm_mday, hour, minute, 0,
         lt.tm_wday, lt.tm_yday, lt.tm_isdst)
    )
    return _t.mktime(target)


def test_schedule_window_inside_window_matches():
    sub = {
        "endpoint": "x", "keys": {},
        "filters": {
            "schedule_window": {"start": "09:00", "end": "17:00"},
        },
    }
    assert _sub_matches_event(sub, _evt(ts=_ts_at(12, 0))) is True


def test_schedule_window_outside_window_rejects():
    sub = {
        "endpoint": "x", "keys": {},
        "filters": {
            "schedule_window": {"start": "09:00", "end": "17:00"},
        },
    }
    # 06:00 is before the window starts.
    assert _sub_matches_event(sub, _evt(ts=_ts_at(6, 0))) is False
    # 18:00 is after the window ends.
    assert _sub_matches_event(sub, _evt(ts=_ts_at(18, 0))) is False


def test_schedule_window_end_is_exclusive():
    """[start, end) — an event at exactly `end` is OUTSIDE the window."""
    sub = {
        "endpoint": "x", "keys": {},
        "filters": {
            "schedule_window": {"start": "09:00", "end": "17:00"},
        },
    }
    assert _sub_matches_event(sub, _evt(ts=_ts_at(17, 0))) is False
    # And `start` is inclusive.
    assert _sub_matches_event(sub, _evt(ts=_ts_at(9, 0))) is True


def test_schedule_window_overnight_wraparound():
    """22:00 → 07:00 covers the night — 23:00 + 06:00 inside, 12:00 outside."""
    sub = {
        "endpoint": "x", "keys": {},
        "filters": {
            "schedule_window": {"start": "22:00", "end": "07:00"},
        },
    }
    assert _sub_matches_event(sub, _evt(ts=_ts_at(23, 0))) is True
    assert _sub_matches_event(sub, _evt(ts=_ts_at(6, 0))) is True
    # Mid-day = outside.
    assert _sub_matches_event(sub, _evt(ts=_ts_at(12, 0))) is False


def test_schedule_window_zero_length_disables_gating():
    """start == end → "no schedule" sentinel; matches every event,
    same semantics as `services/detection_config.py::in_schedule_off_window`."""
    sub = {
        "endpoint": "x", "keys": {},
        "filters": {
            "schedule_window": {"start": "09:00", "end": "09:00"},
        },
    }
    assert _sub_matches_event(sub, _evt(ts=_ts_at(3, 0))) is True
    assert _sub_matches_event(sub, _evt(ts=_ts_at(12, 0))) is True


def test_schedule_window_ANDs_with_other_filters():
    """schedule_window AND-combined with person_names — both must
    pass for the sub to fire."""
    sub = {
        "endpoint": "x", "keys": {},
        "filters": {
            "person_names": ["israel"],
            "schedule_window": {"start": "09:00", "end": "17:00"},
        },
    }
    # Right person + right time → fires.
    assert _sub_matches_event(
        sub, _evt(person_name="israel", ts=_ts_at(12, 0))
    ) is True
    # Right person + wrong time → blocked.
    assert _sub_matches_event(
        sub, _evt(person_name="israel", ts=_ts_at(3, 0))
    ) is False
    # Wrong person + right time → blocked.
    assert _sub_matches_event(
        sub, _evt(person_name="bob", ts=_ts_at(12, 0))
    ) is False


def test_schedule_window_malformed_fails_open():
    """Malformed schedule_window (bad regex, wrong shape) should NOT
    silently suppress all push delivery — fall back to "no gating"
    so an operator's bad disk-edit doesn't black-hole notifications.
    Symmetric with the iter-205 `_normalize_loaded_sub` belt-and-
    braces handling: bad data → safe default."""
    # Invalid HH:MM in start.
    sub_bad_start = {
        "endpoint": "x", "keys": {},
        "filters": {"schedule_window": {"start": "25:99", "end": "07:00"}},
    }
    assert _sub_matches_event(sub_bad_start, _evt(ts=_ts_at(12, 0))) is True
    # Wrong shape entirely.
    sub_wrong_shape = {
        "endpoint": "x", "keys": {},
        "filters": {"schedule_window": "not-a-dict"},
    }
    assert _sub_matches_event(sub_wrong_shape, _evt(ts=_ts_at(12, 0))) is True


def test_schedule_window_disk_load_normalizes_malformed_to_none(tmp_path):
    """Hand-edited push_subs.json with a malformed schedule_window
    (bad regex) → `_normalize_loaded_sub` drops it to None rather
    than failing the whole sub. Symmetric with iter-205 cameras /
    person_names tolerance."""
    path = tmp_path / "subs.json"
    path.write_text(json.dumps([{
        "endpoint": "https://push.example/x",
        "keys": {"p256dh": "p", "auth": "a"},
        "user_id": "alice",
        "filters": {
            "cameras": ["cam1"],
            "person_names": None,
            "schedule_window": {"start": "99:99", "end": "07:00"},
        },
    }]))
    s = PushService(persist_path=path)
    assert len(s.subs) == 1
    assert s.subs[0]["filters"]["schedule_window"] is None
    # cameras still preserved (one bad field doesn't drop the whole filter set).
    assert s.subs[0]["filters"]["cameras"] == ["cam1"]


@pytest.mark.asyncio
async def test_send_matching_skips_non_matching_subs(service):
    """Two subs: one matches, one doesn't. send_matching dispatches
    only to the matching one. Mock the inner _fanout_to to count
    invocations + see which subs were passed."""
    service.private_pem = b"fake"
    service.add({
        "endpoint": "match-this",
        "keys": {"p256dh": "p", "auth": "a"},
        "filters": {"cameras": ["cam1"]},
    })
    service.add({
        "endpoint": "skip-this",
        "keys": {"p256dh": "p", "auth": "a"},
        "filters": {"cameras": ["cam-other"]},
    })

    captured_subs = []

    async def fake_fanout(subs, payload):
        captured_subs.extend(subs)
        return len(subs)

    with patch.object(service, "_fanout_to", side_effect=fake_fanout):
        sent = await service.send_matching(_evt(camera_id="cam1"), {"title": "x"})

    assert sent == 1
    endpoints = [s["endpoint"] for s in captured_subs]
    assert endpoints == ["match-this"]


@pytest.mark.asyncio
async def test_send_matching_logs_one_info_fanout_summary(service, caplog):
    import logging as _logging

    service.private_pem = b"fake"
    service.add({
        "endpoint": "match-this",
        "keys": {"p256dh": "p", "auth": "a"},
        "filters": {"cameras": ["cam1"]},
    })
    service.add({
        "endpoint": "skip-this",
        "keys": {"p256dh": "p", "auth": "a"},
        "filters": {"cameras": ["cam-other"]},
    })

    async def fake_fanout(subs, payload):
        return len(subs)

    with (
        patch.object(service, "_fanout_to", side_effect=fake_fanout),
        caplog.at_level(_logging.INFO, logger="app.services.push_service"),
    ):
        sent = await service.send_matching(
            _evt(id="evt-log-1", camera_id="cam1"),
            {"title": "x"},
        )

    assert sent == 1
    summaries = [
        r.getMessage()
        for r in caplog.records
        if r.getMessage().startswith("push fanout event=")
    ]
    assert summaries == [
        "push fanout event=evt-log-1 sent=1 filtered=1 failed=0 pruned=0"
    ]


@pytest.mark.asyncio
async def test_send_matching_with_no_matches_returns_zero(service):
    service.private_pem = b"fake"
    service.add({
        "endpoint": "x",
        "keys": {"p256dh": "p", "auth": "a"},
        "filters": {"cameras": ["cam-other"]},
    })

    async def fake_fanout(subs, payload):
        return len(subs)

    with patch.object(service, "_fanout_to", side_effect=fake_fanout):
        sent = await service.send_matching(_evt(camera_id="cam1"), {"title": "x"})

    assert sent == 0


def test_added_sub_with_iter_205_fields_round_trips_to_disk(tmp_path):
    """add() preserves the iter-205 fields through save+load."""
    path = tmp_path / "subs.json"
    s1 = PushService(persist_path=path)
    s1.add({
        "endpoint": "https://push.example/x",
        "keys": {"p256dh": "p", "auth": "a"},
        "user_id": "alice",
        "filters": {"cameras": ["cam1"], "person_names": ["israel"]},
    })
    # Fresh instance reloads from disk.
    s2 = PushService(persist_path=path)
    assert len(s2.subs) == 1
    assert s2.subs[0]["user_id"] == "alice"
    # iter-209: `_normalize_loaded_sub` fills `schedule_window: None`
    # for legacy iter-205/iter-206 subs that lack the field.
    assert s2.subs[0]["filters"] == {
        "cameras": ["cam1"],
        "person_names": ["israel"],
        "schedule_window": None,
    }


def test_send_to_user_targets_only_that_users_subscriptions(service, monkeypatch):
    """send_to_user fans out ONLY to subs owned by the given user — bob's and
    legacy (user_id=None) subs are excluded. Used for the 'your timelapse is
    ready' notification to the build's requester."""
    # arrange
    import asyncio
    service.subs = [
        {"endpoint": "https://e/a1", "user_id": "alice"},
        {"endpoint": "https://e/b1", "user_id": "bob"},
        {"endpoint": "https://e/a2", "user_id": "alice"},
        {"endpoint": "https://e/legacy", "user_id": None},
    ]
    captured = {}

    async def _fake_fanout(subs, payload):
        captured["subs"] = subs
        return len(subs)

    monkeypatch.setattr(service, "_fanout_to", _fake_fanout)

    # act
    n = asyncio.run(service.send_to_user("alice", {"title": "x"}))

    # assert — only alice's two subscriptions targeted.
    assert n == 2
    assert {s["endpoint"] for s in captured["subs"]} == {
        "https://e/a1",
        "https://e/a2",
    }


def test_send_to_user_with_empty_user_is_a_noop(service, monkeypatch):
    """An empty/None user must NEVER fan out (no accidental broadcast-to-all)."""
    # arrange
    import asyncio
    service.subs = [{"endpoint": "https://e/a1", "user_id": "alice"}]
    called = {"n": 0}

    async def _fake_fanout(subs, payload):
        called["n"] += 1
        return 0

    monkeypatch.setattr(service, "_fanout_to", _fake_fanout)

    # act + assert — fanout never called.
    assert asyncio.run(service.send_to_user("", {"title": "x"})) == 0
    assert called["n"] == 0
