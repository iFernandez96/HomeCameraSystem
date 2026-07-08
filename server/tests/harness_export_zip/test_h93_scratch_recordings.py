import pytest

from server.tests.harness_export_zip.fixtures import (
    CLIPS_DIR,
    EVENTS_DB,
    build_scratch_recordings,
    list_clips,
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


def test_given_real_clips_when_scratch_recordings_are_built_then_every_mp4_is_copied_byte_for_byte(
    tmp_path,
):
    recordings_dir, copied = build_scratch_recordings(tmp_path)
    expected_ids = [event_id for event_id, _, _ in list_clips()]
    copied_ids = [event_id for event_id, _, _ in copied]
    report = {
        "recordings_dir": str(recordings_dir),
        "expected_ids": expected_ids,
        "copied_ids": copied_ids,
    }

    assert recordings_dir.is_dir(), report
    assert copied_ids == expected_ids, report
    for event_id, source, target in copied:
        assert target == recordings_dir / "{}.mp4".format(event_id)
        assert target.is_file(), {"event_id": event_id, "target": str(target)}
        assert target.read_bytes() == source.read_bytes(), {
            "event_id": event_id,
            "source": str(source),
            "target": str(target),
            "source_size": source.stat().st_size,
            "target_size": target.stat().st_size,
        }
