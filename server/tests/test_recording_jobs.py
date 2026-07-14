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
    monkeypatch.setattr(
        recording_jobs,
        "_probe_playable_video",
        lambda _path: recording_jobs._PROBE_VALID,
    )

    # act
    result = recording_jobs.reconcile_recent(now=130.0, path=jobs_path)
    first = recording_jobs.summary(now=130.0, path=jobs_path)
    second = recording_jobs.summary(now=131.0, path=jobs_path)

    # assert
    assert result == {
        "examined": 1,
        "validated": 1,
        "validation_unavailable": 0,
        "transitions": 1,
    }
    assert first["counts"]["available"] == 1
    assert first["v"] == 2
    assert first["default_window"] == "24h"
    assert first["windows"]["24h"]["counts"]["available"] == 1
    assert first["windows"]["all"]["latency_samples"] == 1
    assert first["median_ready_s"] == 7.0
    assert second["median_ready_s"] == 7.0


def test_given_invalid_published_clip_when_reconciled_then_it_is_failed_and_quarantined(
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
    monkeypatch.setattr(
        recording_jobs,
        "_probe_playable_video",
        lambda _path: recording_jobs._PROBE_INVALID,
    )

    # act
    recording_jobs.reconcile_recent(now=130.0, path=jobs_path)
    recording_jobs.reconcile_recent(now=131.0, path=jobs_path)
    result = recording_jobs.summary(now=131.0, path=jobs_path)
    failures = recording_jobs.recent_failures(path=jobs_path)

    # assert
    assert clip.exists() is False
    assert (recordings / "evt_bad.mp4.invalid").read_bytes() == b"not-video"
    assert result["counts"]["failed"] == 1
    assert result["invalid_videos"] == 1
    assert failures[0]["failure_code"] == "integrity_validation_failed"


def test_given_ffprobe_is_unavailable_when_reconciled_then_clip_is_retained_for_retry(
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
    events_db.insert_event(events_path, _event("evt_retry", 100.0))
    clip = recordings / "evt_retry.mp4"
    clip.write_bytes(b"potentially-valid-video")

    def unavailable(*_args, **_kwargs):
        raise OSError("ffprobe temporarily unavailable")

    monkeypatch.setattr(recording_jobs.subprocess, "run", unavailable)

    # act
    reconciled = recording_jobs.reconcile_recent(now=130.0, path=jobs_path)
    result = recording_jobs.summary(now=130.0, path=jobs_path)
    objective = next(
        item for item in result["objectives"] if item["id"] == "validated_available"
    )

    # assert
    assert clip.read_bytes() == b"potentially-valid-video"
    assert reconciled["validated"] == 0
    assert reconciled["validation_unavailable"] == 1
    assert result["counts"]["available"] == 1
    assert result["pending_validation"] == 1
    assert objective["met"] is False


def test_given_pending_clips_when_batch_is_bounded_then_oldest_is_validated_first(
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
    for index in range(4):
        event_id = "evt_{}".format(index)
        events_db.insert_event(events_path, _event(event_id, 100.0 + index))
        (recordings / "{}.mp4".format(event_id)).write_bytes(b"video")
    probed = []

    def valid(path):
        probed.append(path.name)
        return recording_jobs._PROBE_VALID

    monkeypatch.setattr(recording_jobs, "_probe_playable_video", valid)

    # act
    recording_jobs.reconcile_recent(now=130.0, path=jobs_path, validate_limit=1)
    first = recording_jobs.summary(now=130.0, path=jobs_path)
    recording_jobs.reconcile_recent(now=131.0, path=jobs_path, validate_limit=1)

    # assert
    assert probed == ["evt_0.mp4", "evt_1.mp4"]
    assert first["pending_validation"] == 3
    objective = next(
        item for item in first["objectives"] if item["id"] == "validated_available"
    )
    assert objective["met"] is False


def test_metrics_summary_uses_bounded_window_and_matches_24h_gauges(tmp_path):
    # arrange
    jobs_path = tmp_path / "recording-jobs.db"
    recording_jobs.init_db(jobs_path)
    with recording_jobs._connect(jobs_path) as conn:
        conn.executemany(
            "INSERT INTO recording_jobs "
            "(event_id,event_ts,state,first_seen_ts,updated_ts,ready_ts,"
            "capture_end_ts,validation_state) VALUES (?,?,?,?,?,?,?,?)",
            [
                ("recent", 90_000.0, "available", 90_000.0, 90_000.0, 90_012.0, 90_002.0, "valid"),
                ("invalid", 90_001.0, "failed", 90_001.0, 90_001.0, None, None, "invalid"),
                ("old", 1.0, "available", 1.0, 1.0, 5.0, 2.0, "valid"),
            ],
        )
        conn.commit()

    # act
    result = recording_jobs.metrics_summary(now=100_000.0, path=jobs_path)

    # assert
    assert result == {
        "stuck_jobs": 0,
        "p95_ready_s": 10.0,
        "invalid_videos": 1,
    }
