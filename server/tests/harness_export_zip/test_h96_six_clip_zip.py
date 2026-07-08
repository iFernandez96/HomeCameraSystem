import json
import os
import zipfile

import pytest
from starlette.responses import FileResponse

from app.config import settings
from app.routes.clips import _build_export_zip
from app.services import events_db
from server.tests.harness_export_zip.fixtures import (
    CLIPS_DIR,
    EVENTS_DB,
    assert_event_matches_raw_row,
    build_scratch_recordings,
    clip_ids,
    copy_events_db,
    ordered_raw_rows_for,
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


def test_given_six_real_clips_when_export_zip_built_then_every_member_and_manifest_row_matches_fixtures(
    tmp_path,
    monkeypatch,
):
    recordings_dir, copied = build_scratch_recordings(tmp_path)
    events_db_path = copy_events_db(tmp_path)
    monkeypatch.setattr(settings, "recordings_dir", recordings_dir)
    monkeypatch.setattr(settings, "events_db_path", events_db_path)
    ids = clip_ids()
    sources_by_id = {
        event_id: source_path for event_id, source_path, _target_path in copied
    }
    events = events_db.get_by_ids(events_db_path, ids)

    zip_path = _build_export_zip(events)
    response = FileResponse(
        zip_path,
        media_type="application/zip",
        filename="homecam_events.zip",
    )

    assert response.status_code == 200
    assert response.media_type == "application/zip"
    assert response.headers["content-disposition"].startswith(
        'attachment; filename="homecam_events.zip"'
    )
    try:
        with zipfile.ZipFile(zip_path) as archive:
            names = set(archive.namelist())
            assert names == {"manifest.json"} | {
                "{}.mp4".format(event_id) for event_id in ids
            }
            for event_id in ids:
                assert archive.read("{}.mp4".format(event_id)) == sources_by_id[
                    event_id
            ].read_bytes()
            manifest = json.loads(archive.read("manifest.json"))
    finally:
        os.unlink(zip_path)

    raw_rows = ordered_raw_rows_for(ids, db_path=events_db_path)
    assert manifest["v"] == 1
    assert manifest["exported_count"] == 6
    assert [event["id"] for event in manifest["events"]] == ids
    for event, raw_row in zip(manifest["events"], raw_rows):
        assert event["clip_included"] is True
        assert_event_matches_raw_row(event, raw_row)
