from __future__ import annotations

from app.services import push_assurance


def _sub(endpoint: str = "https://push.example/device-secret") -> dict:
    return {
        "endpoint": endpoint,
        "keys": {"p256dh": "p", "auth": "a"},
        "user_id": "israel",
    }


def test_given_gateway_send_and_valid_receipt_when_phone_shows_then_status_is_delivered(tmp_path):
    # arrange
    path = tmp_path / "push-assurance.json"
    sub = _sub()
    token = push_assurance.issue(sub, now=100.0)

    # act
    accepted = push_assurance.accept(token, True, now=102.0, path=path)
    status = push_assurance.status([sub], now=110.0, path=path)

    # assert
    assert accepted is True
    assert status == {
        "state": "delivered",
        "devices": 1,
        "received_recent": 1,
        "latest_received_at": 102.0,
        "latest_age_s": 8.0,
    }
    assert "device-secret" not in path.read_text()
    assert token not in path.read_text()


def test_given_receipt_is_replayed_when_accepted_then_it_cannot_change_state_twice(tmp_path):
    # arrange
    path = tmp_path / "push-assurance.json"
    token = push_assurance.issue(_sub(), now=100.0)

    # act / assert
    assert push_assurance.accept(token, True, now=101.0, path=path) is True
    assert push_assurance.accept(token, False, now=102.0, path=path) is False


def test_given_unknown_capability_when_received_then_no_state_is_persisted(tmp_path):
    # arrange
    path = tmp_path / "push-assurance.json"

    # act
    accepted = push_assurance.accept("x" * 32, True, now=100.0, path=path)

    # assert
    assert accepted is False
    assert not path.exists()


def test_given_subscription_without_receipt_when_status_reads_then_it_waits_truthfully(tmp_path):
    # act
    status = push_assurance.status([_sub()], now=100.0, path=tmp_path / "missing.json")

    # assert
    assert status["state"] == "waiting"
    assert status["received_recent"] == 0


def test_given_malformed_json_shape_when_status_reads_then_it_fails_closed(tmp_path):
    path = tmp_path / "push-assurance.json"
    path.write_text("[]")

    status = push_assurance.status([_sub()], now=100.0, path=path)

    assert status["state"] == "waiting"
    assert status["received_recent"] == 0
