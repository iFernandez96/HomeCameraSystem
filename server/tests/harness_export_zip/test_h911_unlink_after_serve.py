import time

import pytest

from app.config import settings
from app.routes import clips as clips_route
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


async def _inline_to_thread(func, /, *args, **kwargs):
    return func(*args, **kwargs)


def _run_background_inline(background):
    background.func(*background.args, **background.kwargs)


@pytest.mark.asyncio
async def test_given_export_response_body_consumed_when_background_task_runs_then_temp_zip_is_unlinked(
    tmp_path,
    monkeypatch,
):
    recordings_dir, _copied = build_scratch_recordings(tmp_path)
    events_db_path = copy_events_db(tmp_path)
    monkeypatch.setattr(settings, "recordings_dir", recordings_dir)
    monkeypatch.setattr(settings, "events_db_path", events_db_path)
    monkeypatch.setattr(clips_route.asyncio, "to_thread", _inline_to_thread)

    response = await clips_route.export_events(
        clips_route._ExportBody(event_ids=[clip_ids()[0]]),
    )
    assert response.status_code == 200
    assert response.media_type == "application/zip"
    assert open(response.path, "rb").read()
    assert response.background.func is clips_route._unlink_quiet
    _run_background_inline(response.background)

    deadline = time.monotonic() + 2.0
    leftovers = list(recordings_dir.glob("homecam_export_*.zip"))
    while leftovers and time.monotonic() < deadline:
        time.sleep(0.02)
        leftovers = list(recordings_dir.glob("homecam_export_*.zip"))

    assert leftovers == []
