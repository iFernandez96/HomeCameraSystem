from __future__ import annotations

import os

from app.config import settings
from app.services import events_db, recording_jobs


def _event(event_id: str, ts: float) -> dict:
    return {
        "id": event_id,
        "ts": ts,
        "camera_id": "front_door",
        "label": "person",
        "score": 0.9,
        "boxes": [],
        "v": 1,
        "type": "detection",
        "end_ts": ts + 5,
    }


def test_given_published_clip_when_reconciled_then_ready_latency_is_durable(
    tmp_path, monkeypatch
):
    # arrange
    events_path = tmp_path / "events.db"
    jobs_path = tmp_path / "recording-jobs.db"
    recordings = tmp_path / "recordings"
    recordings.mkdir()
    monkeypatch.setattr(settings, "events_db_path", events_path)
    monkeypatch.setattr(settings, "recordings_dir", recordings)
    events_db.init_db(events_path)
    events_db.insert_event(events_path, _event("evt_ready", 100.0))
    clip = recordings / "evt_ready.mp4"
    clip.write_bytes(b"video")
    os.utime(clip, (112.0, 112.0))
    monkeypatch.setattr(recording_jobs, "_has_playable_video", lambda _path: True)

    # act
    result = recording_jobs.reconcile_recent(now=130.0, path=jobs_path)
    first = recording_jobs.summary(now=130.0, path=jobs_path)
    second = recording_jobs.summary(now=131.0, path=jobs_path)

    # assert
    assert result == {"examined": 1, "validated": 1, "transitions": 1}
    assert first["counts"]["available"] == 1
    assert first["median_ready_s"] == 7.0
    assert second["median_ready_s"] == 7.0


def test_given_invalid_published_clip_when_reconciled_then_it_is_failed_and_removed(
    tmp_path, monkeypatch
):
    # arrange
    events_path = tmp_path / "events.db"
    jobs_path = tmp_path / "recording-jobs.db"
    recordings = tmp_path / "recordings"
    recordings.mkdir()
    monkeypatch.setattr(settings, "events_db_path", events_path)
    monkeypatch.setattr(settings, "recordings_dir", recordings)
    events_db.init_db(events_path)
    events_db.insert_event(events_path, _event("evt_bad", 100.0))
    clip = recordings / "evt_bad.mp4"
    clip.write_bytes(b"not-video")
    monkeypatch.setattr(recording_jobs, "_has_playable_video", lambda _path: False)

    # act
    recording_jobs.reconcile_recent(now=130.0, path=jobs_path)
    recording_jobs.reconcile_recent(now=131.0, path=jobs_path)
    result = recording_jobs.summary(now=131.0, path=jobs_path)
    failures = recording_jobs.recent_failures(path=jobs_path)

    # assert
    assert clip.exists() is False
    assert result["counts"]["failed"] == 1
    assert result["invalid_videos"] == 1
    assert failures[0]["failure_code"] == "integrity_validation_failed"
