"""End-to-end replay harness for the continuous-capture visit pipeline.

Standalone-first proof against REAL captured data (gitignored fixtures under
.jetson-snapshot/continuous_capture_fixtures/): tonight's production journal
is parsed into a presence/absence timeline and replayed through the REAL
``visit_runtime.VisitRunner`` / ``visit.VisitTracker`` /
``preroll.copy_new_segments`` / ``recording.finalize_visit`` (real ffmpeg)
over REAL Jetson ring segments re-mtimed onto the replay clock. Assertions
are on real outputs: files on disk, ffprobe/decode results, POSTed payload
captures.

Scenarios (docs/audits/uiux-overhaul-2026-07-07/continuous-capture-harness-
report.md carries the pass/fail matrix + verdict):
  1. Tonight's flapping trace at absence_finalize_s=10 vs 30.
  2. Continuous presence past max_visit_s: cap-split adjacency +
     continuation flags on the REAL detect._build_visit_runner POST adapter.
  3. Return-during-grace with a disjoint box (IoU 0) -> ONE visit.
  4. Restart mid-visit: idempotent recovery; missing-scratch bounded retry.
  5. Arm/disarm mid-presence via detect._arm/_disarm_visit_runner (XOR).
  6. Ring wrap: copy-on-extend preserves footage the ring recycled.
  7. Finalize output quality on real segments (plan-B1 decode exception).

Gated: skips wholly when the fixtures or ffmpeg are absent (Jetson-off dev
convention — run deploy/fetch-jetson-data.sh + capture fixtures first).

BDD-lite: Given/When/Then names + arrange/act/assert bodies.
"""
import os
import sys
import time
import types
from pathlib import Path
from unittest.mock import MagicMock

import pytest

_HARNESS_DIR = Path(__file__).resolve().parent
_DETECTION_DIR = _HARNESS_DIR.parents[1]
sys.path.insert(0, str(_HARNESS_DIR))
sys.path.insert(0, str(_DETECTION_DIR))

import journal_replay  # noqa: E402
import rig as rigmod  # noqa: E402

import recording  # noqa: E402
import visit_runtime  # noqa: E402

pytestmark = pytest.mark.skipif(
    not (rigmod.fixtures_available() and rigmod.ffmpeg_available()),
    reason=(
        "continuous-capture fixtures (.jetson-snapshot/"
        "continuous_capture_fixtures/) or ffmpeg not present — capture "
        "fixtures from the Jetson first"
    ),
)

# The Jetson SDK is host-only; stub it so detect.py imports on the dev box
# (same pattern as test_capture_recovery.py).
sys.modules.setdefault("jetson_inference", MagicMock())
sys.modules.setdefault("jetson_utils", MagicMock())

import detect  # noqa: E402

KEY = rigmod.DEFAULT_KEY
BOX = rigmod.DEFAULT_BOX
DISJOINT_BOX = (900.0, 500.0, 1100.0, 700.0)  # IoU 0 vs DEFAULT_BOX


# --------------------------------------------------------------------------
# shared fixtures: tonight's parsed timeline + the two knob replays
# --------------------------------------------------------------------------

@pytest.fixture(scope="module")
def tonight():
    parsed = journal_replay.parse_journal(str(rigmod.JOURNAL_PATH))
    events = journal_replay.load_event_instants(
        str(rigmod.EVENTS_PATH), parsed["t0"], parsed["t1"],
    )
    instants = journal_replay.presence_timeline(parsed, events)
    return {"parsed": parsed, "events": events, "instants": instants}


def _run_tonight_replay(tonight, tmp_root, absence_s, max_visit_s=150.0):
    instants = tonight["instants"]
    t_start = min(tonight["parsed"]["t0"], instants[0])
    t_end = max(tonight["parsed"]["t1"], instants[-1])
    rig = rigmod.ReplayRig(tmp_root, start_ts=t_start)
    rigmod.run_timeline(
        rig, instants, t_start, t_end, absence_s, max_visit_s,
    )
    return rig


@pytest.fixture(scope="module")
def replay10(tonight, tmp_path_factory):
    return _run_tonight_replay(
        tonight, tmp_path_factory.mktemp("replay10"), absence_s=10.0,
    )


@pytest.fixture(scope="module")
def replay30(tonight, tmp_path_factory):
    return _run_tonight_replay(
        tonight, tmp_path_factory.mktemp("replay30"), absence_s=30.0,
    )


def _covered(finalizes, t, eps=0.001):
    return any(
        f["start_ts"] - eps <= t <= f["end_ts"] + eps for f in finalizes
    )


# --------------------------------------------------------------------------
# Scenario 0 — the parser reads the REAL journal correctly
# --------------------------------------------------------------------------

def test_given_tonights_journal_when_parsed_then_real_shape_recovered(tonight):
    # arrange / act
    parsed = tonight["parsed"]

    # assert — the real restart chain (worker pids), the real ARMED knob
    # settings, the real scratch-FileNotFoundError storm, and a usable
    # presence timeline all came out of the log.
    assert parsed["pids"] == [29312, 2472, 4622, 5761]
    armed_knobs = {(mv, ab) for _t, mv, ab in parsed["armed"]}
    assert (150.0, 10.0) in armed_knobs
    assert (180.0, 30.0) in armed_knobs
    assert len(parsed["scratch_missing_ids"]) >= 8
    assert len(parsed["recovery_retry_ids"]) >= 2
    assert len(parsed["capture_error_ts"]) >= 50
    assert len(tonight["instants"]) >= 50
    assert len(tonight["events"]) >= 20


# --------------------------------------------------------------------------
# Scenario 1 — tonight's flapping trace at absence_finalize_s = 10 vs 30
# --------------------------------------------------------------------------

def test_given_tonights_trace_when_absence_30_then_fewer_visits_than_10(
    replay10, replay30, tonight,
):
    # arrange
    n10 = len(replay10.fresh_visit_posts())
    n30 = len(replay30.fresh_visit_posts())

    # assert — the larger grace merges the capture-error flap gaps into
    # fewer visits, and the replay's fresh-visit counts match the pure gap
    # oracle over the same instants (the state machine adds nothing).
    assert n30 < n10
    assert n10 == journal_replay.expected_visit_count(
        tonight["instants"], 10.0,
    )
    assert n30 == journal_replay.expected_visit_count(
        tonight["instants"], 30.0,
    )


@pytest.mark.parametrize("which", ["replay10", "replay30"])
def test_given_tonights_trace_when_replayed_then_every_instant_covered(
    which, request, tonight,
):
    # arrange
    rig = request.getfixturevalue(which)

    # assert — NO FOOTAGE LOSS: the union of finalized visit windows covers
    # every real detection instant, at both knob settings.
    uncovered = [
        t for t in tonight["instants"] if not _covered(rig.finalizes, t)
    ]
    assert uncovered == [], (
        "detection instants outside every recorded window: {}".format(
            uncovered,
        )
    )


@pytest.mark.parametrize("which", ["replay10", "replay30"])
def test_given_tonights_trace_when_replayed_then_every_finalize_publishes(
    which, request,
):
    # arrange
    rig = request.getfixturevalue(which)

    # assert — every visit finalize succeeded through the REAL ffmpeg concat
    # + real-decode validate (plan B1) and its file exists on disk. This is
    # exactly where the pre-fix pipeline failed tonight (single-observe
    # visits had no scratch -> "no clip produced").
    assert rig.finalizes, "replay produced no visits at all?"
    bad = [f for f in rig.finalizes if not f["ok"]]
    assert bad == [], "refused finalizes: {}".format(
        [(f["visit_id"], f["start_ts"], f["end_ts"]) for f in bad],
    )
    missing = [f for f in rig.finalizes if not os.path.exists(f["path"])]
    assert missing == []


def test_given_absence_30_replay_when_clips_decoded_then_all_validate(replay30):
    # arrange / act / assert — independent full decode pass over every
    # published clip (not just finalize's own gate): the plan-B1 fatal
    # markers must be absent; NVENC GOP-join DTS warnings are the documented
    # allowed exception.
    for f in replay30.finalizes:
        assert rigmod.decode_is_clean(f["path"]), (
            "clip failed independent decode: {}".format(f["path"])
        )


def test_given_absence_30_replay_when_durations_probed_then_on_window(replay30):
    # arrange / act / assert — each published clip's real duration is within
    # the shipped tolerance of its nominal visit window.
    for f in replay30.finalizes:
        probed = rigmod.probe_duration(f["path"])
        expected = f["end_ts"] - f["start_ts"]
        assert abs(probed - expected) <= recording._FINALIZE_DURATION_TOLERANCE_S, (
            "clip {} duration {:.1f}s vs window {:.1f}s".format(
                f["visit_id"], probed, expected,
            )
        )


def test_given_tonights_gaps_when_analyzed_then_30s_bridges_the_flap_cluster(
    tonight,
):
    # arrange — the knob-recommendation data (report scenario-1 section).
    gaps = journal_replay.gap_histogram(tonight["instants"])

    # assert — tonight's real flap gaps (capture-error storms mid-presence)
    # cluster in (10, 30]: absence_finalize_s=10 splits a real visit at
    # every one of them; 30 bridges them all. Gaps past 30s are genuine
    # departures (36s+), so 30 doesn't over-merge.
    flap_cluster = [g for g in gaps if 10.0 < g <= 30.0]
    departures = [g for g in gaps if g > 30.0]
    assert len(flap_cluster) >= 8
    assert min(departures) > 35.0


# --------------------------------------------------------------------------
# Scenario 2 — continuous presence past max_visit_s (real detect adapter)
# --------------------------------------------------------------------------

def test_given_long_presence_when_cap_splits_then_adjacent_and_continuation_flagged(
    tmp_path, monkeypatch,
):
    # arrange — the REAL detect._build_visit_runner wiring (its _post_open
    # carries the continuation flag), real recorder + real preroll buffer
    # over a simulated ring of real segments. POSTs captured in-process.
    posted = []
    monkeypatch.setattr(
        detect, "post_event", lambda url, payload, **kw: posted.append(payload),
    )
    recordings_dir = str(tmp_path / "rec")
    ring_dir = os.path.join(recordings_dir, "_preroll")
    t0 = 1783486800.0
    ring = rigmod.RingSim(
        ring_dir, rigmod.segment_library(), capacity=90, start_ts=t0 - 5.0,
    )
    buf = __import__("preroll").PrerollBuffer(
        "rtsp://unused", ring_dir, segment_s=1,
    )
    rec = recording.ClipRecorder("rtsp://unused", recordings_dir)
    windows = []
    orig_finalize = rec.finalize_visit

    def _capture_finalize(visit_id, scratch, s, e, **kw):
        ok = orig_finalize(visit_id, scratch, s, e, **kw)
        windows.append({"visit_id": visit_id, "start_ts": s, "end_ts": e,
                        "ok": ok})
        return ok

    rec.finalize_visit = _capture_finalize
    runner = detect._build_visit_runner(
        recordings_dir, rec, buf, "http://unused/event", "front_door",
    )
    absence_s, max_visit_s = 5.0, 15.0

    # act — 40s of CONTINUOUS presence (observe every second), then drain.
    for k in range(41):
        t = t0 + k
        ring.advance_to(t)
        runner.tick(t, absence_s, max_visit_s)
        runner.observe(KEY, BOX, t, 0.0, absence_s, max_visit_s,
                       boxes=rigmod.DEFAULT_BOXES)
    for k in range(41, 53):
        t = t0 + k
        ring.advance_to(t)
        runner.tick(t, absence_s, max_visit_s)
    deadline = time.time() + 180.0
    while runner._finalizing_ids and time.time() < deadline:
        time.sleep(0.2)
    assert not runner._finalizing_ids, "finalize threads never drained"

    # assert — three cap-split windows; the FIRST open has no continuation
    # key, every segment_index>0 open is continuation=True (real _post_open).
    assert len(posted) == 3
    assert "continuation" not in posted[0]
    assert all(p.get("continuation") is True for p in posted[1:])
    # adjacency: v2.start <= v1.end within one GOP (plan R2; nominal-exact).
    ws = sorted(windows, key=lambda w: w["start_ts"])
    assert len(ws) == 3
    for prev, nxt in zip(ws, ws[1:]):
        assert nxt["start_ts"] <= prev["end_ts"] + 1e-6
        assert abs(nxt["start_ts"] - prev["end_ts"]) <= 4.3
    # every cap-split clip published + decode-validates for real.
    for w in ws:
        assert w["ok"] is True
        path = os.path.join(recordings_dir, "{}.mp4".format(w["visit_id"]))
        assert os.path.exists(path)
        assert rigmod.decode_is_clean(path)


# --------------------------------------------------------------------------
# Scenario 3 — return-during-grace with a disjoint box (2026-07-07 fix)
# --------------------------------------------------------------------------

def test_given_return_in_grace_with_disjoint_box_then_one_visit_and_reset(
    tmp_path,
):
    # arrange — subject at BOX, leaves, returns 8s later (inside the 10s
    # grace) at a location with IoU 0 vs the last box.
    t0 = 1783486800.0
    rig = rigmod.ReplayRig(tmp_path, start_ts=t0)
    absence_s, max_visit_s = 10.0, 150.0
    rig.step_observe(t0, absence_s, max_visit_s, box=BOX)
    for k in range(1, 8):
        rig.step_tick(t0 + k, absence_s, max_visit_s)

    # act — the disjoint-box return, then ticks past the ORIGINAL deadline
    # (t0+10) but not the reset one, then past the reset one.
    rig.step_observe(t0 + 8, absence_s, max_visit_s, box=DISJOINT_BOX)
    for k in range(9, 17):
        rig.step_tick(t0 + k, absence_s, max_visit_s)
    assert rig.finalizes == [], (
        "countdown was NOT reset by the disjoint-box return"
    )
    for k in range(17, 22):
        rig.step_tick(t0 + k, absence_s, max_visit_s)

    # assert — ONE visit (IoU is advisory, never gating: the 2026-07-07
    # semantics fix), finalized at the RESET deadline t0+8+10, one clip.
    assert len(rig.fresh_visit_posts()) == 1
    assert len(rig.finalizes) == 1
    f = rig.finalizes[0]
    assert f["start_ts"] == t0
    assert f["end_ts"] == pytest.approx(t0 + 18.0)
    assert f["ok"] is True
    assert rigmod.decode_is_clean(f["path"])


# --------------------------------------------------------------------------
# Scenario 4 — restart mid-visit: idempotent recovery + missing scratch
# --------------------------------------------------------------------------

def _recovery_hooks(recorder, recordings_dir, finalize_log):
    """Mirror detect._recover_open_visits' wiring: the recorder's ffprobe
    gate as the idempotency validator, the real finalize as the finalizer."""
    def validate(path):
        return recorder._probe_duration(path) is not None

    def finalize(visit_id, scratch, s, e):
        finalize_log.append(visit_id)
        return recorder.finalize_visit(
            visit_id, scratch, s, e, recordings_dir=recordings_dir,
        )

    return validate, finalize


def test_given_crash_mid_visit_when_recovered_then_one_clip_idempotently(
    tmp_path,
):
    # arrange — an open visit with 20s of real observed footage, then the
    # worker "crashes" (we simply stop driving it; .open_visits.json holds
    # the OPEN entry, the scratch dir holds the copied segments).
    t0 = 1783486800.0
    rig = rigmod.ReplayRig(tmp_path, start_ts=t0)
    absence_s, max_visit_s = 10.0, 150.0
    for k in range(21):
        rig.step_observe(t0 + k, absence_s, max_visit_s)
    table = visit_runtime.read_open_visits(rig.recordings_dir)
    assert len(table) == 1
    vid = list(table)[0]
    assert table[vid]["state"] == visit_runtime.STATE_OPEN

    # act — "reboot": a FRESH recovery pass over the persisted table using
    # the real modules (visit_runtime.recover_open_visits + real ffmpeg).
    # now = crash + 2s: a fast systemd restart, so the recovery window
    # [start, min(last_extend + absence, now)] stays inside the footage
    # that actually reached scratch (see the known-bug test below for the
    # slow-restart case).
    finalize_log = []
    validate, finalize = _recovery_hooks(
        rig.recorder, rig.recordings_dir, finalize_log,
    )
    s1 = visit_runtime.recover_open_visits(
        rig.recordings_dir, validate, finalize, now=t0 + 22.0,
        default_absence_finalize_s=absence_s,
    )

    # assert — recovered into ONE published, decode-valid clip.
    assert s1["finalized"] == [vid]
    clip = os.path.join(rig.recordings_dir, "{}.mp4".format(vid))
    assert os.path.exists(clip)
    assert rigmod.decode_is_clean(clip)
    st_before = os.stat(clip)

    # act again — a SECOND recovery pass (double reboot). The valid clip
    # must be skipped: no second finalize, no second os.replace, file
    # byte-for-byte untouched (B4 idempotency on real data).
    # (Recovery already dropped the entry; re-seed it as a crash replay.)
    visit_runtime.write_open_visits(rig.recordings_dir, {vid: table[vid]})
    s2 = visit_runtime.recover_open_visits(
        rig.recordings_dir, validate, finalize, now=t0 + 80.0,
        default_absence_finalize_s=absence_s,
    )
    assert s2["skipped"] == [vid]
    assert finalize_log.count(vid) == 1, "finalize ran twice for one id"
    st_after = os.stat(clip)
    assert (st_before.st_mtime_ns, st_before.st_size) == (
        st_after.st_mtime_ns, st_after.st_size,
    )
    assert visit_runtime.read_open_visits(rig.recordings_dir) == {}


def test_given_slow_restart_when_recovered_then_honest_clip_publishes(
    tmp_path,
):
    """Bug B3 FIXED (2026-07-07): recovery's window used to add the
    absence-grace tail — footage scratch never held (the ring is gone by
    recovery time) — so a recovery running later than the duration
    tolerance had its honest clip REFUSED and the footage was lost
    (guaranteed at absence=30, coin-flip at 10; tonight's prod restarts
    were 60s+ after the wedge). The window is now bounded to last_extend:
    exactly what was captured, and the slow-restart clip publishes."""
    # arrange — 20s of real observed footage, crash, recovery 20s later.
    t0 = 1783486800.0
    rig = rigmod.ReplayRig(tmp_path, start_ts=t0)
    for k in range(21):
        rig.step_observe(t0 + k, 10.0, 150.0)
    table = visit_runtime.read_open_visits(rig.recordings_dir)
    vid = list(table)[0]
    finalize_log = []
    validate, finalize = _recovery_hooks(
        rig.recorder, rig.recordings_dir, finalize_log,
    )

    # act — recovery runs well past last_extend; the window must claim
    # only the ~20s that actually reached scratch, not a 30s fiction.
    s1 = visit_runtime.recover_open_visits(
        rig.recordings_dir, validate, finalize, now=t0 + 40.0,
        default_absence_finalize_s=10.0,
    )

    # assert — the honest clip publishes on the first attempt.
    assert s1["finalized"] == [vid]
    assert os.path.exists(
        os.path.join(rig.recordings_dir, "{}.mp4".format(vid)),
    )


def test_given_open_visit_with_missing_scratch_when_recovered_then_bounded_not_crash(
    tmp_path,
):
    # arrange — tonight's prod shape: an OPEN entry whose scratch dir does
    # not exist at all (pids 2472/4622/5761 each retried such visits with
    # "leaving FINALIZING for a later retry", forever).
    recordings_dir = str(tmp_path / "rec")
    os.makedirs(recordings_dir, exist_ok=True)
    recorder = recording.ClipRecorder("rtsp://unused", recordings_dir)
    t0 = 1783486800.0
    visit_runtime.write_open_visits(recordings_dir, {
        "lostvisit01": {
            "state": visit_runtime.STATE_OPEN,
            "key": KEY,
            "visit_id": "lostvisit01",
            "start_ts": t0,
            "last_extend": t0 + 12.0,
            "last_seen": t0 + 12.0,
            "segment_index": 0,
            "absence_finalize_s": 10.0,
        },
    })
    finalize_log = []
    validate, finalize = _recovery_hooks(
        recorder, recordings_dir, finalize_log,
    )

    # act — three boots' worth of recovery passes. None may raise (the real
    # finalize hits the missing dir and returns False — graceful).
    summaries = [
        visit_runtime.recover_open_visits(
            recordings_dir, validate, finalize, now=t0 + 100.0 * (i + 1),
            default_absence_finalize_s=10.0,
        )
        for i in range(3)
    ]

    # assert — no crash-loop AND no retry-forever: two bounded FINALIZING
    # retries, then the entry is abandoned (2026-07-07 bounded-retry fix;
    # the pre-fix behavior retried on every boot for eternity).
    assert summaries[0]["failed"] == ["lostvisit01"]
    assert summaries[1]["failed"] == ["lostvisit01"]
    assert summaries[2]["abandoned"] == ["lostvisit01"]
    assert visit_runtime.read_open_visits(recordings_dir) == {}
    assert len(finalize_log) == 3
    assert not os.path.exists(
        os.path.join(recordings_dir, "lostvisit01.mp4"),
    )


# --------------------------------------------------------------------------
# Scenario 5 — arm/disarm mid-presence via the REAL detect helpers (XOR)
# --------------------------------------------------------------------------

def test_given_mid_presence_disarm_then_valid_clip_and_rearm_opens_fresh(
    tmp_path, monkeypatch,
):
    # arrange — real detect._arm_visit_runner wiring over a real ring.
    posted = []
    monkeypatch.setattr(
        detect, "post_event", lambda url, payload, **kw: posted.append(payload),
    )
    recordings_dir = str(tmp_path / "rec")
    ring_dir = os.path.join(recordings_dir, "_preroll")
    t0 = 1783486800.0
    ring = rigmod.RingSim(
        ring_dir, rigmod.segment_library(), capacity=90, start_ts=t0 - 5.0,
    )
    buf = __import__("preroll").PrerollBuffer(
        "rtsp://unused", ring_dir, segment_s=1,
    )
    rec = recording.ClipRecorder("rtsp://unused", recordings_dir)
    runtime = types.SimpleNamespace(absence_finalize_s=10.0, max_visit_s=150.0)
    try:
        # act 1 — ARM (boot path: recovery + sweep run before first open).
        detect._arm_visit_runner(
            recordings_dir, rec, buf, "http://unused/event", "front_door",
            runtime,
        )
        assert detect._VISIT_RUNNER is not None, "armed -> runner owns clips"
        runner1 = detect._VISIT_RUNNER

        # act 2 — presence for 12s through the armed runner.
        for k in range(13):
            t = t0 + k
            ring.advance_to(t)
            runner1.tick(t, 10.0, 150.0)
            runner1.observe(KEY, BOX, t, 0.0, 10.0, 150.0,
                            boxes=rigmod.DEFAULT_BOXES)
        vid1 = posted[0]["id"]

        # act 3 — DISARM mid-presence (Settings toggle off).
        detect._disarm_visit_runner(now=t0 + 12.5)

        # assert — XOR flips: the runner global is None so every later
        # detection takes the legacy start_clip path, never both.
        assert detect._VISIT_RUNNER is None
        # the open table was drained + persisted before the runner dropped.
        assert visit_runtime.read_open_visits(recordings_dir) == {}
        # the mid-visit footage finalized at last_seen into a VALID clip.
        deadline = time.time() + 180.0
        while runner1._finalizing_ids and time.time() < deadline:
            time.sleep(0.2)
        clip1 = os.path.join(recordings_dir, "{}.mp4".format(vid1))
        assert os.path.exists(clip1), "disarm lost the mid-visit footage"
        assert rigmod.decode_is_clean(clip1)
        probed = rigmod.probe_duration(clip1)
        # window is [t0, last_seen=t0+12]; edge precision ±~1 segment.
        assert abs(probed - 12.0) <= recording._FINALIZE_DURATION_TOLERANCE_S

        # act 4 — RE-ARM and a new presence: a FRESH visit opens.
        detect._arm_visit_runner(
            recordings_dir, rec, buf, "http://unused/event", "front_door",
            runtime,
        )
        assert detect._VISIT_RUNNER is not None
        runner2 = detect._VISIT_RUNNER
        assert runner2 is not runner1
        t = t0 + 30.0
        ring.advance_to(t)
        runner2.tick(t, 10.0, 150.0)
        runner2.observe(KEY, BOX, t, 0.0, 10.0, 150.0,
                        boxes=rigmod.DEFAULT_BOXES)

        # assert — a second open POST with a NEW visit id (fresh, not a
        # resurrection of the finalized one).
        assert len(posted) == 2
        assert posted[1]["id"] != vid1
        assert "continuation" not in posted[1]
    finally:
        detect._VISIT_RUNNER = None


# --------------------------------------------------------------------------
# Scenario 6 — ring wrap: copy-on-extend beats slot recycling
# --------------------------------------------------------------------------

def test_given_visit_outlasting_ring_when_finalized_then_full_footage_survives(
    tmp_path,
):
    # arrange — a TINY 12-slot ring (~12s window) and a 40s presence: by
    # finalize time the ring has recycled its early slots 3x over. Only the
    # incremental copy-on-extend (plan B3) can have saved the early footage.
    t0 = 1783486800.0
    rig = rigmod.ReplayRig(tmp_path, start_ts=t0, ring_capacity=12)
    absence_s, max_visit_s = 5.0, 300.0

    # act — 40s continuous presence, then drain past the grace deadline.
    for k in range(41):
        rig.step_observe(t0 + k, absence_s, max_visit_s)
    for k in range(41, 53):
        rig.step_tick(t0 + k, absence_s, max_visit_s)

    # assert — the ring truly wrapped (far more segments copied than slots),
    # and the finalized clip carries the FULL window with a clean decode.
    assert len(rig.finalizes) == 1
    f = rig.finalizes[0]
    total_copied = sum(n for _v, _s, _u, n in rig.copies)
    assert total_copied > 12, "ring never wrapped — scenario is vacuous"
    assert f["ok"] is True
    expected = f["end_ts"] - f["start_ts"]  # 40s presence + 5s grace
    assert expected == pytest.approx(45.0)
    probed = rigmod.probe_duration(f["path"])
    assert abs(probed - expected) <= recording._FINALIZE_DURATION_TOLERANCE_S
    assert rigmod.decode_is_clean(f["path"])


# --------------------------------------------------------------------------
# Scenario 7 — finalize output quality on REAL segments
# --------------------------------------------------------------------------

def test_given_real_segments_when_finalized_then_decode_clean_and_on_window(
    tmp_path,
):
    # arrange — a 30s band of real ring segments copied through the REAL
    # preroll range/copy API into a visit scratch.
    t0 = 1783486800.0
    recordings_dir = str(tmp_path / "rec")
    ring_dir = os.path.join(recordings_dir, "_preroll")
    rigmod.RingSim(
        ring_dir, rigmod.segment_library(), capacity=60, start_ts=t0 - 2.0,
    ).advance_to(t0 + 32.0)
    buf = __import__("preroll").PrerollBuffer(
        "rtsp://unused", ring_dir, segment_s=1,
    )
    scratch = visit_runtime.scratch_dir_for(recordings_dir, "quality01")
    newly, _seen = buf.copy_new_segments(t0, t0 + 30.0, scratch)
    assert len(newly) >= 28, "band selection dropped real segments"
    recorder = recording.ClipRecorder("rtsp://unused", recordings_dir)

    # act — the real finalize (concat + faststart + internal B1 validate).
    ok = recorder.finalize_visit(
        "quality01", scratch, t0, t0 + 30.0, recordings_dir=recordings_dir,
    )

    # assert — published, and an INDEPENDENT `ffmpeg -v error -f null -`
    # decode pass is clean of every fatal marker finalize greps for
    # (mirrored via recording._FINALIZE_DECODE_BAD_MARKERS). The documented
    # plan-B1 exception — "non monotonic dts" at NVENC GOP joins — is
    # allowed and NOT treated as corruption.
    assert ok is True
    out = os.path.join(recordings_dir, "quality01.mp4")
    rc, stderr_text = rigmod.decode_null(out)
    assert rc == 0
    for marker in recording._FINALIZE_DECODE_BAD_MARKERS:
        assert marker not in stderr_text, (
            "fatal decode marker {!r} in output".format(marker)
        )
    probed = rigmod.probe_duration(out)
    assert abs(probed - 30.0) <= recording._FINALIZE_DURATION_TOLERANCE_S
    # scratch reaped on the way out (plan R8).
    assert not os.path.exists(scratch)
