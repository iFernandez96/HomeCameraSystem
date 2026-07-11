"""iter-201 (Feature #1 slice 1): recording_service tests.

Service is pure file-ops; tests use tmp_path + monkeypatch
`settings.recordings_dir`. No ffmpeg, no async — purely the
storage/retention surface.
"""
from __future__ import annotations

import time
import json

import pytest

from app.services import recording_service
from app.config import settings


@pytest.fixture
def rec_dir(tmp_path, monkeypatch):
    """Per-test recordings dir; gets created on demand."""
    p = tmp_path / "recordings"
    monkeypatch.setattr(settings, "recordings_dir", p)
    yield p


# --- clip_path / clip_exists / delete_clip ---


def test_clip_path_resolves_to_event_id_dot_mp4(rec_dir):
    assert recording_service.clip_path("evt-123") == rec_dir / "evt-123.mp4"


def test_clip_path_rejects_path_traversal(rec_dir):
    """Defense-in-depth: even if the route regex were bypassed, the
    service refuses any non-bare event_id."""
    with pytest.raises(ValueError):
        recording_service.clip_path("../etc/passwd")
    with pytest.raises(ValueError):
        recording_service.clip_path("foo/bar")
    with pytest.raises(ValueError):
        recording_service.clip_path("foo bar")
    with pytest.raises(ValueError):
        recording_service.clip_path("")


def test_clip_path_accepts_canonical_event_id(rec_dir):
    """Charset is `[A-Za-z0-9_-]+` — alphanumeric + underscore +
    dash. Matches the existing event_bus id format and the route's
    Path pattern."""
    assert recording_service.clip_path("abc123") is not None
    assert recording_service.clip_path("a_b-c") is not None
    assert recording_service.clip_path("X" * 64) is not None


def test_clip_exists_false_for_missing_file(rec_dir):
    assert recording_service.clip_exists("evt-missing") is False


def test_clip_exists_true_after_write(rec_dir):
    rec_dir.mkdir()
    (rec_dir / "evt-001.mp4").write_bytes(b"fake mp4")
    assert recording_service.clip_exists("evt-001") is True


def test_clip_exists_false_for_invalid_id(rec_dir):
    """Invalid id → False (don't raise; clip_path catches it)."""
    assert recording_service.clip_exists("../etc/passwd") is False


def test_clip_state_reads_worker_ledger_when_clip_missing(rec_dir):
    rec_dir.mkdir()
    (rec_dir / ".clip_state.json").write_text(json.dumps({
        "v": 1,
        "events": {
            "evt-001": {
                "event_id": "evt-001",
                "state": "recording",
                "start_ts": 100.0,
                "last_seen": 105.0,
            },
        },
    }))

    state = recording_service.clip_state("evt-001")

    assert state["state"] == "recording"
    assert state["source"] == "ledger"
    assert state["last_seen"] == 105.0


def test_clip_state_disk_available_wins_over_stale_ledger(rec_dir):
    rec_dir.mkdir()
    (rec_dir / ".clip_state.json").write_text(json.dumps({
        "v": 1,
        "events": {"evt-001": {"state": "recording"}},
    }))
    (rec_dir / "evt-001.mp4").write_bytes(b"fake")

    state = recording_service.clip_state("evt-001")

    assert state["state"] == "available"
    assert state["source"] == "disk"
    assert state["bytes"] == 4


def test_clip_state_unknown_when_no_file_or_ledger_entry(rec_dir):
    assert recording_service.clip_state("evt-ghost") == {
        "event_id": "evt-ghost",
        "state": "unknown",
        "source": "missing",
    }


def test_delete_clip_removes_existing(rec_dir):
    rec_dir.mkdir()
    p = rec_dir / "evt-002.mp4"
    p.write_bytes(b"fake mp4")
    assert recording_service.delete_clip("evt-002") is True
    assert not p.exists()


def test_delete_clip_returns_false_for_missing(rec_dir):
    """No error on missing — best-effort cleanup."""
    assert recording_service.delete_clip("evt-ghost") is False


def test_delete_clip_returns_false_for_invalid_id(rec_dir):
    assert recording_service.delete_clip("../etc/passwd") is False


# --- sweep_old_clips ---


def test_sweep_returns_zero_when_dir_missing(rec_dir):
    assert recording_service.sweep_old_clips(7) == 0


def test_sweep_deletes_old_clips_keeps_fresh(rec_dir):
    """Files older than retention_days * 86400 seconds are deleted;
    fresh files are kept."""
    rec_dir.mkdir()
    old = rec_dir / "old.mp4"
    fresh = rec_dir / "fresh.mp4"
    old.write_bytes(b"old")
    fresh.write_bytes(b"fresh")

    # Backdate `old` by 30 days; `fresh` left at current mtime.
    cutoff_age_s = 30 * 86400
    import os as _os
    _os.utime(old, (time.time() - cutoff_age_s, time.time() - cutoff_age_s))

    deleted = recording_service.sweep_old_clips(retention_days=7)
    assert deleted == 1
    assert not old.exists()
    assert fresh.exists()


def test_sweep_skips_non_mp4_files(rec_dir):
    """Operator might keep ad-hoc test clips or partial ffmpeg
    work-files that share the dir; only `.mp4` is sweepable."""
    rec_dir.mkdir()
    log_file = rec_dir / "ffmpeg.log"
    log_file.write_bytes(b"x")
    import os as _os
    _os.utime(log_file, (time.time() - 30 * 86400, time.time() - 30 * 86400))

    deleted = recording_service.sweep_old_clips(retention_days=7)
    assert deleted == 0
    assert log_file.exists()


def test_sweep_with_zero_retention_skips(rec_dir):
    """`retention_days <= 0` is a misconfiguration; refuse to delete
    everything. Operator clears the dir manually if they actually
    want that."""
    rec_dir.mkdir()
    p = rec_dir / "evt.mp4"
    p.write_bytes(b"x")
    import os as _os
    _os.utime(p, (time.time() - 1000 * 86400, time.time() - 1000 * 86400))

    assert recording_service.sweep_old_clips(retention_days=0) == 0
    assert recording_service.sweep_old_clips(retention_days=-5) == 0
    assert p.exists()


def test_sweep_with_default_retention_uses_settings(rec_dir, monkeypatch):
    """No arg → reads `settings.recordings_retention_days`."""
    monkeypatch.setattr(settings, "recordings_retention_days", 7)
    rec_dir.mkdir()
    old = rec_dir / "old.mp4"
    old.write_bytes(b"x")
    import os as _os
    _os.utime(old, (time.time() - 30 * 86400, time.time() - 30 * 86400))

    assert recording_service.sweep_old_clips() == 1


# --- evict_to_free_space (byte-budget, plan S4.5 / B2) ---


def _fake_disk_usage(free_bytes):
    """A drop-in for shutil.disk_usage returning a namedtuple-ish object with
    just `.free` (the only field the evictor reads). Accepts an int or a
    zero-arg callable so a test can model free space rising as clips delete."""
    from collections import namedtuple

    _Usage = namedtuple("_Usage", ["total", "used", "free"])

    def _du(_path):
        free = free_bytes() if callable(free_bytes) else free_bytes
        return _Usage(total=0, used=0, free=free)

    return _du


def _write_clip_with_mtime(rec_dir, name, size, age_s):
    """Write a `<name>` file of `size` bytes, backdated by `age_s` seconds."""
    import os as _os

    p = rec_dir / name
    p.write_bytes(b"x" * size)
    _os.utime(p, (time.time() - age_s, time.time() - age_s))
    return p


def test_evict_noops_when_already_above_floor(rec_dir):
    """Free space at/above the floor → nothing deleted."""
    # arrange
    rec_dir.mkdir()
    clip = rec_dir / "evt.mp4"
    clip.write_bytes(b"x" * 100)
    floor = 300 * 1024 * 1024

    # act — disk_usage reports plenty of free space.
    result = recording_service.evict_to_free_space(
        min_free_bytes=floor, disk_usage=_fake_disk_usage(floor + 1)
    )

    # assert
    assert result == {"deleted": 0, "freed_bytes": 0}
    assert clip.exists()


def test_evict_returns_zero_when_dir_missing(rec_dir):
    """No recordings dir yet → no-op, no crash."""
    # arrange — rec_dir intentionally NOT created.
    # act
    result = recording_service.evict_to_free_space(
        min_free_bytes=100, disk_usage=_fake_disk_usage(0)
    )
    # assert
    assert result == {"deleted": 0, "freed_bytes": 0}


def test_evict_deletes_oldest_first_until_above_floor(rec_dir):
    """Below the floor → delete OLDEST clips first; stop as soon as free space
    crosses the floor. Models free space rising 100 bytes per deletion."""
    # arrange — three clips, distinct ages (oldest → newest).
    rec_dir.mkdir()
    oldest = _write_clip_with_mtime(rec_dir, "oldest.mp4", 100, age_s=300)
    middle = _write_clip_with_mtime(rec_dir, "middle.mp4", 100, age_s=200)
    newest = _write_clip_with_mtime(rec_dir, "newest.mp4", 100, age_s=100)

    floor = 250
    # Start at free=0; each deleted 100-byte clip frees 100 bytes. Need 3
    # deletions to reach 300 >= 250 — but free crosses the floor after the
    # 3rd... model it so only 3 are needed; assert oldest-first ordering by
    # checking which survive after a SMALLER floor.
    deleted_count = {"n": 0}

    def _free():
        return deleted_count["n"] * 100

    def _du(_path):
        from collections import namedtuple

        _Usage = namedtuple("_Usage", ["total", "used", "free"])
        return _Usage(0, 0, _free())

    # Wrap unlink-counting by patching list_clips to bump the counter as the
    # evictor deletes — simplest is to let the real unlink happen and recount.
    # Instead: floor reachable after deleting 2 (free 0→needs >=200). We make
    # the reader count surviving-deleted via the real filesystem.
    def _du_fs(_path):
        from collections import namedtuple

        _Usage = namedtuple("_Usage", ["total", "used", "free"])
        remaining = len([e for e in rec_dir.iterdir() if e.suffix == ".mp4"])
        deleted = 3 - remaining
        return _Usage(0, 0, deleted * 100)

    # act — floor 200 → free must reach >=200 → exactly 2 deletions.
    result = recording_service.evict_to_free_space(
        min_free_bytes=200, disk_usage=_du_fs
    )

    # assert — oldest two gone, newest survives; counts reported.
    assert not oldest.exists()
    assert not middle.exists()
    assert newest.exists()
    assert result["deleted"] == 2
    assert result["freed_bytes"] == 200


def test_evict_stops_when_no_clips_left(rec_dir):
    """Free space never recovers but clips run out → stops cleanly, reports
    what it managed to delete (never loops forever / raises)."""
    # arrange — two clips; disk_usage always reports 0 free (below any floor).
    rec_dir.mkdir()
    a = _write_clip_with_mtime(rec_dir, "a.mp4", 100, age_s=300)
    b = _write_clip_with_mtime(rec_dir, "b.mp4", 100, age_s=100)

    # act
    result = recording_service.evict_to_free_space(
        min_free_bytes=10 ** 12, disk_usage=_fake_disk_usage(0)
    )

    # assert — both deleted, then it stopped (no infinite loop).
    assert not a.exists()
    assert not b.exists()
    assert result["deleted"] == 2


def test_evict_ignores_non_mp4_files(rec_dir):
    """Only `.mp4` clips are evictable; operator work-files are left alone."""
    # arrange
    rec_dir.mkdir()
    clip = _write_clip_with_mtime(rec_dir, "evt.mp4", 100, age_s=300)
    log_file = rec_dir / "ffmpeg.log"
    log_file.write_bytes(b"x" * 100)

    # act — floor unreachable so it deletes every clip it can.
    recording_service.evict_to_free_space(
        min_free_bytes=10 ** 12, disk_usage=_fake_disk_usage(0)
    )

    # assert — clip gone, non-mp4 untouched.
    assert not clip.exists()
    assert log_file.exists()


def test_evict_preserves_protected_clip(rec_dir):
    from app.config import settings
    from app.services import events_db, event_bus

    rec_dir.mkdir()
    protected = _write_clip_with_mtime(rec_dir, "keep.mp4", 100, age_s=300)
    ordinary = _write_clip_with_mtime(rec_dir, "remove.mp4", 100, age_s=100)
    event = event_bus.make_detection_event(
        label="person", score=0.9, boxes=[], event_id="keep"
    )
    events_db.insert_event(settings.events_db_path, event)
    events_db.set_protected(settings.events_db_path, "keep", True)

    result = recording_service.evict_to_free_space(
        min_free_bytes=10 ** 12, disk_usage=_fake_disk_usage(0)
    )

    assert protected.exists()
    assert not ordinary.exists()
    assert result["deleted"] == 1


# --- sweep_and_evict (combined pass: time-sweep THEN byte-evict) ---


def test_sweep_and_evict_runs_time_sweep_then_byte_evict(rec_dir, monkeypatch):
    """The combined pass deletes genuinely-old clips (time) FIRST, then evicts
    the oldest survivors to recover space (bytes). Order is observable: the
    expired clip is gone via the AGE path; a fresh-but-oldest clip is gone via
    the BYTE path only because the card is still under the floor."""
    # arrange — `expired` is 30d old (past 7d retention); `fresh_old` and
    # `fresh_new` are recent but the card is under the floor.
    monkeypatch.setattr(settings, "recordings_retention_days", 7)
    rec_dir.mkdir()
    expired = _write_clip_with_mtime(rec_dir, "expired.mp4", 100, age_s=30 * 86400)
    fresh_old = _write_clip_with_mtime(rec_dir, "fresh_old.mp4", 100, age_s=200)
    fresh_new = _write_clip_with_mtime(rec_dir, "fresh_new.mp4", 100, age_s=100)

    call_order = []
    real_sweep = recording_service.sweep_old_clips
    real_evict = recording_service.evict_to_free_space

    def _spy_sweep(*a, **k):
        call_order.append("sweep")
        return real_sweep(*a, **k)

    def _spy_evict(*a, **k):
        call_order.append("evict")
        # Inject a fake disk_usage that mirrors the filesystem: free rises as
        # clips delete; floor reachable after evicting one of the survivors.
        from collections import namedtuple

        _Usage = namedtuple("_Usage", ["total", "used", "free"])

        def _du(_path):
            remaining = len(
                [e for e in rec_dir.iterdir() if e.suffix == ".mp4"]
            )
            # start of evict: expired already swept → 2 left. Need 1 byte-evict.
            return _Usage(0, 0, (2 - remaining) * 100)

        return real_evict(min_free_bytes=100, disk_usage=_du)

    monkeypatch.setattr(recording_service, "sweep_old_clips", _spy_sweep)
    monkeypatch.setattr(recording_service, "evict_to_free_space", _spy_evict)

    # act
    result = recording_service.sweep_and_evict()

    # assert — sweep ran BEFORE evict; expired gone by age, fresh_old (oldest
    # survivor) gone by bytes, fresh_new survives.
    assert call_order == ["sweep", "evict"]
    assert not expired.exists()
    assert not fresh_old.exists()
    assert fresh_new.exists()
    assert result["swept"] == 1
    assert result["evicted"] == 1
