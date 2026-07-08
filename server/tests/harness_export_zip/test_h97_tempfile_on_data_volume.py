import os

import pytest

from app.config import settings
from app.routes import clips as clips_route
from app.services import events_db
from server.tests.harness_export_zip.fixtures import (
    CLIPS_DIR,
    EVENTS_DB,
    build_scratch_recordings,
    clip_ids,
    copy_events_db,
)


pytestmark = [
    pytest.mark.skipif(
        not CLIPS_DIR.exists(),
        reason="no Jetson clip fixtures - capture .jetson-snapshot/proof_fixtures/clips",
    ),
    pytest.mark.skipif(
        not EVENTS_DB.exists(),
        reason="no Jetson events DB fixture - capture .jetson-snapshot/db/events.sqlite",
    ),
]


def test_given_real_export_when_zip_tempfile_created_then_it_lives_on_recordings_volume(
    tmp_path,
    monkeypatch,
):
    recordings_dir, _copied = build_scratch_recordings(tmp_path)
    events_db_path = copy_events_db(tmp_path)
    monkeypatch.setattr(settings, "recordings_dir", recordings_dir)
    monkeypatch.setattr(settings, "events_db_path", events_db_path)
    events = events_db.get_by_ids(events_db_path, [clip_ids()[0]])
    calls = []
    real_named_temporary_file = clips_route.tempfile.NamedTemporaryFile

    def spy_named_temporary_file(*args, **kwargs):
        calls.append({"args": args, "kwargs": dict(kwargs)})
        return real_named_temporary_file(*args, **kwargs)

    monkeypatch.setattr(
        clips_route.tempfile,
        "NamedTemporaryFile",
        spy_named_temporary_file,
    )

    zip_path = clips_route._build_export_zip(events)
    try:
        assert calls, "expected export build to create a NamedTemporaryFile"
        call = calls[0]
        assert call["kwargs"]["dir"] == str(settings.recordings_dir), call
        assert call["kwargs"]["delete"] is False, call
        assert call["kwargs"]["prefix"] == "homecam_export_", call
    finally:
        os.unlink(zip_path)
