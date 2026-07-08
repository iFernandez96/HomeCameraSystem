import pytest

from app.routes.control import router
from app.services import ota_ledger, ota_manifest, ota_version


@pytest.mark.asyncio
async def test_given_update_scaffold_when_post_route_endpoint_runs_then_note_means_non_applied_and_no_ota_service_call(
    monkeypatch,
):
    called: list[str] = []

    def explode(*_args, **_kwargs):
        called.append("called")
        raise AssertionError("OTA service helper must not be wired in U1")

    monkeypatch.setattr(ota_ledger, "append_event", explode)
    monkeypatch.setattr(ota_manifest, "read_local_manifest", explode)
    monkeypatch.setattr(ota_version, "current_version_from_env", explode)

    route = next(
        route
        for route in router.routes
        if getattr(route, "path", None) == "/system/update"
        and "POST" in getattr(route, "methods", set())
    )
    body = await route.endpoint()

    assert body["ok"] is True
    assert body["note"] is not None
    assert "stub" in body["note"].lower()
    assert body.get("applied") in (None, False)
    assert "ledger_id" not in body
    assert called == []
