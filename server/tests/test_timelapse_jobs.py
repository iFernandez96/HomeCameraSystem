from __future__ import annotations

import stat
import pytest


def test_job_state_survives_module_independent_reads(tmp_path):
    from app.services import timelapse_jobs

    timelapse_jobs.set_state(
        tmp_path, "2026-07-09", "queued", requested_by="owner"
    )
    job = timelapse_jobs.get(tmp_path, "2026-07-09")
    assert job is not None
    assert job["state"] == "queued"
    assert job["requested_by"] == "owner"
    assert timelapse_jobs.db_path(tmp_path).exists()
    assert stat.S_IMODE(timelapse_jobs.db_path(tmp_path).stat().st_mode) == 0o600


def test_invalid_job_state_is_rejected(tmp_path):
    from app.services import timelapse_jobs

    with pytest.raises(ValueError, match="invalid timelapse job state"):
        timelapse_jobs.set_state(tmp_path, "2026-07-09", "mystery")  # type: ignore[arg-type]


def test_reconcile_marks_completed_interrupted_job_ready(tmp_path, monkeypatch):
    from app.config import settings
    from app.routes import control
    from app.services import timelapse_jobs

    monkeypatch.setattr(settings, "timelapses_dir", tmp_path)
    timelapse_jobs.set_state(tmp_path, "2026-07-09", "running")
    (tmp_path / "2026-07-09.mp4").write_bytes(b"done")

    assert control.reconcile_timelapse_jobs() == 0
    assert timelapse_jobs.get(tmp_path, "2026-07-09")["state"] == "ready"


async def test_reconcile_resumes_interrupted_job(tmp_path, monkeypatch):
    from app.config import settings
    from app.routes import control
    from app.services import timelapse_jobs

    monkeypatch.setattr(settings, "timelapses_dir", tmp_path)
    timelapse_jobs.set_state(
        tmp_path, "2026-07-09", "running", requested_by="owner"
    )
    calls = []

    async def _run(date, requested_by=None):
        calls.append((date, requested_by))

    monkeypatch.setattr(control, "_run_timelapse_build", _run)
    assert control.reconcile_timelapse_jobs() == 1
    tasks = list(control._TIMELAPSE_TASKS)
    if tasks:
        await __import__("asyncio").gather(*tasks)
    assert calls == [("2026-07-09", "owner")]
