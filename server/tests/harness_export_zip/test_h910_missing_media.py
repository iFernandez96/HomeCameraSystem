import io
import json
import os
import zipfile

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
async def test_given_real_db_row_with_absent_clip_when_export_requested_then_200_manifest_records_missing_media(
    tmp_path,
    monkeypatch,
):
    recordings_dir, _copied = build_scratch_recordings(tmp_path)
    events_db_path = copy_events_db(tmp_path)
    monkeypatch.setattr(settings, "recordings_dir", recordings_dir)
    monkeypatch.setattr(settings, "events_db_path", events_db_path)
    monkeypatch.setattr(clips_route.asyncio, "to_thread", _inline_to_thread)
    event_id = clip_ids()[0]
    (recordings_dir / "{}.mp4".format(event_id)).unlink()

    response = await clips_route.export_events(
        clips_route._ExportBody(event_ids=[event_id]),
    )
    body = os.fsdecode(response.path)
    zip_bytes = open(body, "rb").read()
    _run_background_inline(response.background)

    assert response.status_code == 200
    assert response.media_type == "application/zip"
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as archive:
        names = set(archive.namelist())
        assert "manifest.json" in names
        assert "{}.mp4".format(event_id) not in names
        manifest = json.loads(archive.read("manifest.json"))

    assert manifest["v"] == 1
    assert manifest["exported_count"] == 1
    assert len(manifest["events"]) == 1
    assert manifest["events"][0]["id"] == event_id
    assert manifest["events"][0]["clip_included"] is False
