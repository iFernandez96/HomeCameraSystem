import os
import threading
import time

import pytest

from app.config import settings
from app.routes.clips import _build_export_zip
from app.services import events_db
from server.tests.harness_export_zip.fixtures import (
    CLIPS_DIR,
    EVENTS_DB,
    build_scratch_recordings,
    clip_ids,
    copy_events_db,
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


def _current_rss_bytes():
    with open("/proc/self/status", encoding="utf-8") as status:
        for line in status:
            if line.startswith("VmRSS:"):
                parts = line.split()
                return int(parts[1]) * 1024
    raise AssertionError("VmRSS missing from /proc/self/status")


def test_given_all_six_real_clips_when_export_zip_built_then_rss_stays_flat(
    tmp_path,
    monkeypatch,
):
    recordings_dir, _copied = build_scratch_recordings(tmp_path)
    events_db_path = copy_events_db(tmp_path)
    monkeypatch.setattr(settings, "recordings_dir", recordings_dir)
    monkeypatch.setattr(settings, "events_db_path", events_db_path)
    ids = clip_ids()
    events = events_db.get_by_ids(events_db_path, ids)
    total_clip_bytes = sum(size_bytes for _event_id, _path, size_bytes in list_clips())
    peak_rss = {"bytes": _current_rss_bytes()}
    stop_sampling = threading.Event()

    def sample_rss_until_done():
        while not stop_sampling.is_set():
            peak_rss["bytes"] = max(peak_rss["bytes"], _current_rss_bytes())
            time.sleep(0.001)

    before_rss = _current_rss_bytes()
    sampler = threading.Thread(target=sample_rss_until_done)
    sampler.start()
    zip_path = None
    try:
        zip_path = _build_export_zip(events)
    finally:
        stop_sampling.set()
        sampler.join(timeout=5)
    after_rss = _current_rss_bytes()

    try:
        peak_delta = peak_rss["bytes"] - before_rss
        # The six captured clips are about 289MB. A streaming-to-disk
        # export should not grow RSS anywhere near the input size; 96MB
        # leaves room for zipfile buffers, interpreter allocation jitter,
        # and pytest/TestClient noise while still catching whole-archive
        # buffering regressions.
        assert peak_delta < 96 * 1024 * 1024, {
            "before_rss": before_rss,
            "peak_rss": peak_rss["bytes"],
            "after_rss": after_rss,
            "peak_delta": peak_delta,
            "total_clip_bytes": total_clip_bytes,
            "zip_size": os.path.getsize(zip_path),
        }
    finally:
        if zip_path is not None:
            os.unlink(zip_path)
