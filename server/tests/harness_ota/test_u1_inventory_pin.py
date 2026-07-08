import pytest

from app.routes.control import router
from app.config import settings
from app.services.ota_ledger import read_events


@pytest.mark.asyncio
async def test_given_no_update_manifest_when_post_route_endpoint_runs_then_unavailable_note_is_non_applied(
    tmp_path, monkeypatch
):
    ota_root = tmp_path / "dist-ota"
    monkeypatch.setattr(settings, "version", "1.2.3")
    monkeypatch.setattr(settings, "ota_root", ota_root)
    monkeypatch.setattr(
        settings, "ota_manifest_path", ota_root / "update-manifest.json"
    )
    monkeypatch.setattr(settings, "ota_artifacts_dir", ota_root / "artifacts")
    monkeypatch.setattr(settings, "ota_staging_root", ota_root / "staging")
    monkeypatch.setattr(settings, "ota_active_pointer", ota_root / "active-version")
    monkeypatch.setattr(settings, "ota_ledger_path", ota_root / "ota-ledger.jsonl")
    monkeypatch.setattr(
        settings,
        "ota_restart_command",
        ("systemctl", "restart", "homecam.service"),
    )

    route = next(
        route
        for route in router.routes
        if getattr(route, "path", None) == "/system/update"
        and "POST" in getattr(route, "methods", set())
    )
    body = await route.endpoint(None)

    assert body["status"] == "rejected"
    assert body["applied"] is False
    assert body["note"] is not None
    assert "manifest" in body["note"].lower()
    assert body["restart_required"] is False
    assert body["ledger_id"] is None
    rows = read_events(settings.ota_ledger_path)
    assert [row["status"] for row in rows] == ["requested", "rejected"]
    assert rows[0]["metadata"]["strategy"] == "rsync-artifact"
