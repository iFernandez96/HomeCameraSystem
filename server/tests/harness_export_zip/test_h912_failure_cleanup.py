import pytest
from fastapi import HTTPException

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


class _FailingZipFile:
    def __init__(self, *_args, **_kwargs):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *_exc_info):
        return False

    def write(self, *_args, **_kwargs):
        raise OSError("forced harness zip write failure")


async def _inline_to_thread(func, /, *args, **kwargs):
    return func(*args, **kwargs)


@pytest.mark.asyncio
async def test_given_zip_write_raises_mid_build_when_export_requested_then_500_and_partial_zip_removed(
    tmp_path,
    monkeypatch,
):
    recordings_dir, _copied = build_scratch_recordings(tmp_path)
    events_db_path = copy_events_db(tmp_path)
    monkeypatch.setattr(settings, "recordings_dir", recordings_dir)
    monkeypatch.setattr(settings, "events_db_path", events_db_path)
    monkeypatch.setattr(clips_route.asyncio, "to_thread", _inline_to_thread)
    monkeypatch.setattr(clips_route.zipfile, "ZipFile", _FailingZipFile)

    with pytest.raises(HTTPException) as exc_info:
        await clips_route.export_events(
            clips_route._ExportBody(event_ids=[clip_ids()[0]]),
        )

    assert exc_info.value.status_code == 500
    assert exc_info.value.detail == "failed to build export archive"
    assert list(recordings_dir.glob("homecam_export_*.zip")) == []
