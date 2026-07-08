from pathlib import Path

import pytest


FIXTURE_DIR = (
    Path(__file__).resolve().parents[3]
    / ".jetson-snapshot"
    / "proof_fixtures"
    / "push"
)
VAPID_PRIVATE = FIXTURE_DIR / "vapid_private.pem"
VAPID_PUBLIC = FIXTURE_DIR / "vapid_public.pem"

pytestmark = pytest.mark.skipif(
    not (VAPID_PRIVATE.exists() and VAPID_PUBLIC.exists()),
    reason="no Jetson VAPID fixture - capture .jetson-snapshot/proof_fixtures/push/vapid_private.pem and vapid_public.pem",
)


def test_given_real_vapid_fixtures_when_loaded_then_push_service_exposes_key_material(
    monkeypatch,
):
    # arrange
    from app.config import settings
    from app.services.push_service import PushService
    from py_vapid import Vapid

    monkeypatch.setattr(settings, "vapid_private_key_path", VAPID_PRIVATE)
    monkeypatch.setattr(settings, "vapid_public_key_path", VAPID_PUBLIC)

    # act
    service = PushService()
    service.load_keys()

    # assert
    assert isinstance(service.private_pem, bytes)
    assert service.private_pem.startswith(b"-----BEGIN ")
    assert isinstance(service.public_key_b64, str)
    assert len(service.public_key_b64) == 87
    assert all(char.isalnum() or char in "-_" for char in service.public_key_b64)
    assert isinstance(service._vapid_obj, Vapid)
