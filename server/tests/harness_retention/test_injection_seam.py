"""Focused injection seam tests for the retention harness."""
from __future__ import annotations

from collections import namedtuple

from app.config import settings
from app.services import recording_service


def test_given_injected_disk_usage_and_list_clips_when_sweep_and_evict_runs_then_real_probes_are_not_used(
    tmp_path, monkeypatch
):
    rec_dir = tmp_path / "recordings"
    rec_dir.mkdir()
    clips = []
    for name in ("a.mp4", "b.mp4", "c.mp4"):
        path = rec_dir / name
        with path.open("wb") as f:
            f.truncate(1)
        clips.append(path)

    monkeypatch.setattr(settings, "recordings_dir", rec_dir)
    monkeypatch.setattr(
        recording_service.shutil,
        "disk_usage",
        lambda _path: (_ for _ in ()).throw(
            AssertionError("real disk_usage/statvfs was consulted")
        ),
    )
    monkeypatch.setattr(
        recording_service,
        "_list_clips_by_mtime",
        lambda _rec_dir: (_ for _ in ()).throw(
            AssertionError("real recordings list was consulted")
        ),
    )

    Usage = namedtuple("Usage", ["total", "used", "free"])
    calls = {"disk_usage": [], "list_clips": []}

    def disk_usage(path):
        calls["disk_usage"].append(path)
        remaining = len([clip for clip in clips if clip.exists()])
        return Usage(total=0, used=0, free=(3 - remaining))

    def list_clips(path):
        calls["list_clips"].append(path)
        return [(index, clip) for index, clip in enumerate(clips)]

    result = recording_service.sweep_and_evict(
        retention_days=7,
        disk_usage=disk_usage,
        list_clips=list_clips,
    )

    assert calls["disk_usage"]
    assert calls["list_clips"] == [rec_dir]
    assert result == {"swept": 0, "evicted": 3, "freed_bytes": 3}
