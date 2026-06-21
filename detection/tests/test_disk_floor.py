"""S4.5 / blocker B2 offline tests: the WORKER disk floor + the worker-floor-
above-server-floor ordering invariant.

The live recording loop is Jetson-only, but the free-space GATE is pure Python
with an injected free-space reader, so the open-refuse / extend-stop behavior is
fully exercised here on the dev host (SDK mocked, mirrors test_visit_recovery).

Run from `detection/`:
    /tmp/homecam-venv/bin/python -m pytest tests/test_disk_floor.py -q
"""
import sys
from pathlib import Path
from unittest.mock import MagicMock

# detect.py / visit.py / visit_runtime.py sit one level up.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

# Stub the host-only Jetson SDK BEFORE importing anything that pulls detect.
sys.modules.setdefault("jetson_inference", MagicMock())
sys.modules.setdefault("jetson_utils", MagicMock())

import visit_runtime  # noqa: E402
from visit import VisitTracker  # noqa: E402


def _make_runner(tmp_path, free_bytes, min_free_bytes=None):
    """A VisitRunner whose free-space reader returns a FIXED ``free_bytes`` (or
    a callable for dynamic tests), with side effects captured into lists and
    finalize run synchronously."""
    events = {"open": [], "copy": [], "finalize": []}

    def post_event(visit_id, key, start_ts, boxes=None):
        events["open"].append((visit_id, key, start_ts, boxes))

    def copy_segments(visit_id, start_ts, until_ts, scratch, already):
        events["copy"].append((visit_id, start_ts, until_ts))
        return [], (already if already is not None else set())

    def finalize(visit_id, scratch, start_ts, end_ts):
        events["finalize"].append((visit_id, start_ts, end_ts))
        return True

    def _sync_spawn(target, _vid):
        target()

    if callable(free_bytes):
        free_space = lambda _path: free_bytes()
    else:
        free_space = lambda _path: free_bytes

    kwargs = dict(
        recordings_dir=str(tmp_path),
        post_event=post_event,
        copy_segments=copy_segments,
        finalize_visit=finalize,
        tracker=VisitTracker(id_factory=lambda: "vid1"),
        spawn=_sync_spawn,
        free_space=free_space,
    )
    if min_free_bytes is not None:
        kwargs["min_free_bytes"] = min_free_bytes
    runner = visit_runtime.VisitRunner(**kwargs)
    return runner, events


# --------------------------------------------------------------------------- #
# 1. _on_open refuses below the floor                                          #
# --------------------------------------------------------------------------- #

def test_given_free_space_below_floor_when_open_then_refuses_no_post_no_record(
    tmp_path,
):
    # arrange — free space sits BELOW the worker floor.
    below = visit_runtime.WORKER_MIN_FREE_BYTES - 1
    runner, events = _make_runner(tmp_path, free_bytes=below)

    # act — a present detection that would normally open a visit.
    runner.observe("person:cam1", (0.0, 0.0, 0.1, 0.1), now=100.0,
                   pre_roll_s=0.0, absence_finalize_s=10.0, max_visit_s=150.0,
                   boxes=[{"label": "person", "x": 0.1, "y": 0.1,
                           "w": 0.2, "h": 0.3, "score": 0.9}])

    # assert — NO open POST, NO persisted visit (refused).
    assert events["open"] == [], "below the floor the open must be refused"
    assert visit_runtime.read_open_visits(str(tmp_path)) == {}
    # plan S6 observability: the refused open is counted for the heartbeat.
    assert runner.clips_dropped_disk_floor == 1
    assert runner.visits_finalized == 0


def test_given_free_space_above_floor_when_open_then_opens_normally(tmp_path):
    # arrange — comfortably above the worker floor.
    above = visit_runtime.WORKER_MIN_FREE_BYTES + (50 * 1024 * 1024)
    runner, events = _make_runner(tmp_path, free_bytes=above)

    # act
    runner.observe("person:cam1", (0.0, 0.0, 0.1, 0.1), now=100.0,
                   pre_roll_s=0.0, absence_finalize_s=10.0, max_visit_s=150.0,
                   boxes=[{"label": "person", "x": 0.1, "y": 0.1,
                           "w": 0.2, "h": 0.3, "score": 0.9}])

    # assert — opened: POST fired AND the visit persisted.
    assert len(events["open"]) == 1
    assert "vid1" in visit_runtime.read_open_visits(str(tmp_path))
    # plan S6: an accepted open is NOT counted as a disk-floor drop.
    assert runner.clips_dropped_disk_floor == 0


def test_given_refused_open_when_subject_persists_then_tracker_rolled_back(
    tmp_path,
):
    # arrange — open refused (below floor), but the same subject keeps showing.
    below = visit_runtime.WORKER_MIN_FREE_BYTES - 1
    runner, events = _make_runner(tmp_path, free_bytes=below)
    runner.observe("person:cam1", (0.0, 0.0, 0.1, 0.1), now=100.0,
                   pre_roll_s=0.0, absence_finalize_s=10.0, max_visit_s=150.0,
                   boxes=[{"label": "person"}])

    # act — a second present frame for the SAME key.
    runner.observe("person:cam1", (0.0, 0.0, 0.1, 0.1), now=103.0,
                   pre_roll_s=0.0, absence_finalize_s=10.0, max_visit_s=150.0,
                   boxes=[{"label": "person"}])

    # assert — the tracker was forgotten, so the second frame is a fresh OPEN
    # attempt (also refused) rather than an EXTEND of a phantom visit. No copy
    # of segments for a visit we never opened.
    assert events["open"] == []
    assert events["copy"] == []
    assert visit_runtime.read_open_visits(str(tmp_path)) == {}


# --------------------------------------------------------------------------- #
# 2. _on_extend stops copying below the floor                                  #
# --------------------------------------------------------------------------- #

def test_given_open_visit_when_disk_drops_below_floor_then_extend_stops_copying(
    tmp_path,
):
    # arrange — start ABOVE the floor (visit opens), then DROP below it.
    state = {"free": visit_runtime.WORKER_MIN_FREE_BYTES + (50 * 1024 * 1024)}
    runner, events = _make_runner(tmp_path, free_bytes=lambda: state["free"])
    runner.set_absence_finalize_s(10.0)
    box = (0.0, 0.0, 0.2, 0.2)
    runner.observe("person:cam1", box, now=100.0, pre_roll_s=0.0,
                   absence_finalize_s=10.0, max_visit_s=150.0,
                   boxes=[{"label": "person"}])
    assert len(events["open"]) == 1, "visit should open while above the floor"

    # act — the card fills; the next extend lands below the floor.
    state["free"] = visit_runtime.WORKER_MIN_FREE_BYTES - 1
    runner.observe("person:cam1", box, now=103.0, pre_roll_s=0.0,
                   absence_finalize_s=10.0, max_visit_s=150.0,
                   boxes=[{"label": "person"}])

    # assert — NO segment copy on the below-floor extend (the visit will
    # finalize the footage it already has instead of growing).
    assert events["copy"] == [], "extend below floor must not copy new segments"


def test_given_open_visit_when_above_floor_then_extend_copies_normally(tmp_path):
    # arrange — stays above the floor throughout.
    above = visit_runtime.WORKER_MIN_FREE_BYTES + (50 * 1024 * 1024)
    runner, events = _make_runner(tmp_path, free_bytes=above)
    runner.set_absence_finalize_s(10.0)
    box = (0.0, 0.0, 0.2, 0.2)
    runner.observe("person:cam1", box, now=100.0, pre_roll_s=0.0,
                   absence_finalize_s=10.0, max_visit_s=150.0,
                   boxes=[{"label": "person"}])

    # act — a second present frame extends.
    runner.observe("person:cam1", box, now=103.0, pre_roll_s=0.0,
                   absence_finalize_s=10.0, max_visit_s=150.0,
                   boxes=[{"label": "person"}])

    # assert — the extend copied as usual.
    assert len(events["copy"]) == 1
    assert events["copy"][0][2] == 103.0


def test_given_unreadable_free_space_when_open_then_does_not_block(tmp_path):
    # arrange — the free-space reader returns None (statvfs hiccup); bias is
    # toward recording (a missed event is worse than a transient stat error).
    runner, events = _make_runner(tmp_path, free_bytes=lambda: None)

    # act
    runner.observe("person:cam1", (0.0, 0.0, 0.1, 0.1), now=100.0,
                   pre_roll_s=0.0, absence_finalize_s=10.0, max_visit_s=150.0,
                   boxes=[{"label": "person"}])

    # assert — opened despite the unreadable stat.
    assert len(events["open"]) == 1


# --------------------------------------------------------------------------- #
# 2b. visits_finalized counter (plan S6 observability)                         #
# --------------------------------------------------------------------------- #

def test_given_open_visit_when_absence_finalizes_then_visits_finalized_incremented(
    tmp_path,
):
    # arrange — open a visit comfortably above the floor.
    above = visit_runtime.WORKER_MIN_FREE_BYTES + (50 * 1024 * 1024)
    runner, events = _make_runner(tmp_path, free_bytes=above)
    runner.set_absence_finalize_s(10.0)
    box = (0.0, 0.0, 0.2, 0.2)
    runner.observe("person:cam1", box, now=100.0, pre_roll_s=0.0,
                   absence_finalize_s=10.0, max_visit_s=150.0,
                   boxes=[{"label": "person"}])
    assert runner.visits_finalized == 0, "no finalize yet while present"

    # act — subject leaves; a tick past the absence deadline finalizes.
    runner.tick(now=200.0, absence_finalize_s=10.0, max_visit_s=150.0)

    # assert — exactly one finalize ran AND the counter advanced once.
    assert len(events["finalize"]) == 1
    assert runner.visits_finalized == 1
    assert runner.clips_dropped_disk_floor == 0


# --------------------------------------------------------------------------- #
# 3. The anti-live-lock ordering invariant (THE pinned property)              #
# --------------------------------------------------------------------------- #

def test_worker_floor_strictly_above_server_floor():
    """The worker stops CREATING footage before the server is forced to start
    DELETING it. If WORKER_MIN_FREE_BYTES <= SERVER_MIN_FREE_BYTES the worker
    would open visits the server immediately evicts → a card-thrashing live-lock
    where no visit ever completes. Import BOTH constants and pin the order."""
    # arrange — pull the server floor across the tier boundary (the test is the
    # only thing that can see both; the worker can't import the FastAPI pkg).
    server_root = Path(__file__).resolve().parents[2] / "server"
    sys.path.insert(0, str(server_root))
    from app.services.recording_service import SERVER_MIN_FREE_BYTES

    # assert
    assert visit_runtime.WORKER_MIN_FREE_BYTES > SERVER_MIN_FREE_BYTES, (
        "worker disk floor must sit strictly ABOVE the server eviction floor "
        "(anti-live-lock invariant)"
    )
