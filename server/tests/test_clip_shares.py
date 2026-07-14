import json

from app.services import clip_shares


def test_share_tokens_are_hashed_expiring_and_revocable(tmp_path):
    path = tmp_path / "shares.json"
    grant = clip_shares.create(path, "evt-1", 60, now=100)

    stored = json.loads(path.read_text())
    assert grant["token"] not in path.read_text()
    assert stored[grant["share_id"]]["event_id"] == "evt-1"
    assert clip_shares.resolve(path, grant["token"], now=159) == "evt-1"
    assert clip_shares.resolve(path, grant["token"], now=160) is None
    assert clip_shares.revoke(path, grant["share_id"]) is True
    assert clip_shares.revoke(path, grant["share_id"]) is False


def test_wrong_token_does_not_resolve(tmp_path):
    path = tmp_path / "shares.json"
    clip_shares.create(path, "evt-1", 60, now=100)
    assert clip_shares.resolve(path, "x" * 43, now=101) is None


def test_owner_can_create_fetch_and_revoke_share(
    client, client_anon, tmp_path, monkeypatch
):
    from app.config import settings

    monkeypatch.setattr(settings, "recordings_dir", tmp_path)
    (tmp_path / "evt-share.mp4").write_bytes(b"video")

    created = client.post(
        "/api/events/evt-share/share", json={"ttl_s": 60}
    )
    assert created.status_code == 200
    assert created.headers["cache-control"] == "private, no-store"
    body = created.json()
    assert body["url"].startswith("/api/shared/")

    # The opaque URL is intentionally usable without a login cookie.
    shared = client_anon.get(body["url"])
    assert shared.status_code == 200
    assert shared.content == b"video"
    assert shared.headers["cache-control"] == "private, no-store"

    revoked = client.delete("/api/shares/{}".format(body["share_id"]))
    assert revoked.json() == {"revoked": True}
    assert client_anon.get(body["url"]).status_code == 404
