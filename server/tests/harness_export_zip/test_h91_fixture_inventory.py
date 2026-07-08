import pytest

from server.tests.harness_export_zip.fixtures import CLIPS_DIR, EVENTS_DB, list_clips


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


def test_given_export_zip_fixture_sources_when_loaded_then_six_nonempty_clips_are_reported():
    clips = list_clips()
    total_size_bytes = sum(size_bytes for _, _, size_bytes in clips)
    report = {
        "clips_dir": str(CLIPS_DIR),
        "clip_count": len(clips),
        "total_size_bytes": total_size_bytes,
        "clips": [
            {"event_id": event_id, "path": str(path), "size_bytes": size_bytes}
            for event_id, path, size_bytes in clips
        ],
    }

    assert CLIPS_DIR.exists()
    assert EVENTS_DB.exists()
    assert len(clips) == 6, report
    assert all(size_bytes > 0 for _, _, size_bytes in clips), report
    assert total_size_bytes > 0, report
