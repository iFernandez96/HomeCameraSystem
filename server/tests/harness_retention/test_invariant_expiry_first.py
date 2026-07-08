from pathlib import Path

import pytest

from app.config import settings
from app.services import recording_service
from server.tests.harness_retention.manifest_fixture import (
    DiskModel,
    build_scratch_recordings,
    parse_recordings_manifest,
)


MANIFEST = (
    Path(__file__).resolve().parents[3]
    / ".jetson-snapshot"
    / "proof_fixtures"
    / "recordings_manifest.txt"
)

pytestmark = pytest.mark.skipif(
    not MANIFEST.exists(),
    reason="no Jetson recordings manifest - capture .jetson-snapshot/proof_fixtures/recordings_manifest.txt",
)


def test_given_real_manifest_under_disk_pressure_when_sweep_and_evict_runs_then_expired_clips_delete_before_byte_eviction(
    tmp_path, monkeypatch
):
    clips, df_avail_bytes = parse_recordings_manifest(MANIFEST)
    recordings_dir = tmp_path / "recordings"
    build_scratch_recordings(clips, recordings_dir)
    monkeypatch.setattr(settings, "recordings_dir", recordings_dir)

    now = max(mtime for _name, _size, mtime in clips) + 60
    cutoff = now - (7 * 86400)
    expired_names = {
        name for name, _size, mtime in clips if mtime < cutoff
    }
    fresh_names = {
        name for name, _size, mtime in clips if mtime >= cutoff
    }
    expired_bytes = sum(
        size for name, size, _mtime in clips if name in expired_names
    )

    monkeypatch.setattr(recording_service.time, "time", lambda: now)
    model = DiskModel(df_avail_bytes, clips, recordings_dir)
    evictor_seen = {}

    def list_clips(rec_dir):
        pairs = recording_service._list_clips_by_mtime(rec_dir)
        evictor_seen["names"] = {path.name for _mtime, path in pairs}
        return pairs

    result = recording_service.sweep_and_evict(
        retention_days=7,
        disk_usage=model,
        list_clips=list_clips,
    )

    deleted_names = model.deleted_mp4_names()
    evicted_names = deleted_names - expired_names

    assert result["swept"] == len(expired_names)
    assert result["evicted"] == len(evicted_names)
    assert result["freed_bytes"] == sum(
        size for name, size, _mtime in clips if name in evicted_names
    )
    assert model.calls
    assert model.free_bytes() == df_avail_bytes + expired_bytes + result["freed_bytes"]

    assert expired_names <= deleted_names
    if "names" in evictor_seen:
        assert evictor_seen["names"].isdisjoint(expired_names)
        assert evicted_names <= evictor_seen["names"]
    assert fresh_names - evicted_names == {
        path.name for path in recordings_dir.glob("*.mp4")
    }
