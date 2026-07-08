# Continuous-capture replay harness — findings report

**Date:** 2026-07-07 · **Harness:** `detection/tests/harness/` (journal_replay.py + rig.py + test_replay_scenarios.py)
**Fixtures:** REAL production data, gitignored under `.jetson-snapshot/continuous_capture_fixtures/` — 95 valid ring segment MP4s (genuine Jetson NVENC `-c copy -f segment` slots, ~1.05 s / ~290 KB each; the snapshot's in-flight moov-less slots are excluded as ring sources, exactly as production's `_filter_valid_segments` would drop them), tonight's journald (21:30–22:12, worker pids 29312 → 2472 → 4622 → 5761), and 56 real event rows.

The harness drives the REAL shipped modules end to end — `visit.VisitTracker` via `visit_runtime.VisitRunner`, `preroll.segments_in_range` / `copy_new_segments`, `recording.ClipRecorder.finalize_visit` with real ffmpeg, `visit_runtime.recover_open_visits`, and `detect._build_visit_runner` / `_arm_visit_runner` / `_disarm_visit_runner` (SDK stubbed at the import boundary only). The single simulated piece is the camera: `RingSim` re-mtimes real segment bytes onto the replay clock and recycles slot names modulo capacity like `-segment_wrap`. All assertions are on real outputs: files on disk, ffprobe durations, `ffmpeg -f null -` decode passes, captured POST payloads.

Run: `/tmp/homecam-venv/bin/python -m pytest detection/tests/harness -q` (gated: skips wholly when fixtures or ffmpeg are absent). **Final result: 17/17 harness tests pass (3:03); full detection suite `pytest detection/tests -q` = 453 passed, 3 skipped (the pre-existing Jetson-snapshot-gated skips).** The replay's visit counts matched the pure-gap oracle exactly (31 clips on disk at absence=10, 20 at absence=30), every published clip survived an independent full-decode pass, and every one of the 71 real detection instants fell inside a recorded window at both knob settings.

## Scenario matrix

| # | Scenario | Result | Test(s) |
|---|---|---|---|
| 0 | Journal parser recovers the real shape (restart chain, ARMED knobs, scratch-error storm) | PASS | `test_given_tonights_journal_when_parsed_then_real_shape_recovered` |
| 1 | Tonight's flapping trace @ absence 10 vs 30: fewer visits at 30; union of recorded windows covers every detection instant at BOTH settings; every finalized clip publishes + decode-validates + is on-window | PASS (after fix F1) | `test_given_tonights_trace_*` (4 tests) + `test_given_absence_30_replay_*` (2 tests) |
| 2 | Continuous presence > max_visit_s: cap-split windows adjacent (v2.start == v1.end, ≤1 GOP), `continuation:true` on every segment_index>0 open POST, absent on the first — via the REAL `detect._build_visit_runner` adapter | PASS | `test_given_long_presence_when_cap_splits_then_adjacent_and_continuation_flagged` |
| 3 | Return-during-grace with a disjoint box (IoU 0): ONE visit, countdown reset (2026-07-07 semantics fix) | PASS | `test_given_return_in_grace_with_disjoint_box_then_one_visit_and_reset` |
| 4 | Restart mid-visit: fresh-runner recovery is idempotent (one finalize / one `os.replace` per id, valid clip skipped byte-untouched); missing-scratch OPEN visit does NOT crash-loop | PASS (fast-restart case; fix F2 bounds the retry loop; **bug B3 pinned** for the slow-restart case) | `test_given_crash_mid_visit_when_recovered_then_one_clip_idempotently`, `test_given_open_visit_with_missing_scratch_when_recovered_then_bounded_not_crash`, `test_known_bug_given_slow_restart_when_recovered_then_clip_duration_refused` |
| 5 | Arm/disarm mid-presence via `detect._arm/_disarm_visit_runner`: disarm finalizes at last_seen into a valid clip, re-arm opens a fresh visit, XOR gate holds | PASS | `test_given_mid_presence_disarm_then_valid_clip_and_rearm_opens_fresh` |
| 6 | Ring wrap: a 40 s visit over a 12-slot (~12 s) ring — copy-on-extend preserved the recycled footage; finalized clip has full expected duration + clean decode | PASS | `test_given_visit_outlasting_ring_when_finalized_then_full_footage_survives` |
| 7 | Finalize quality on REAL NVENC segments: independent `ffmpeg -v error … -f null -` decode clean of every fatal marker (`_FINALIZE_DECODE_BAD_MARKERS`, mirrored from `recording.py`); non-monotonic-DTS-at-joins allowed per plan B1; duration on-window; scratch reaped | PASS | `test_given_real_segments_when_finalized_then_decode_clean_and_on_window` |

## Bugs found

### B1 (CRITICAL, FIXED — F1): finalize never copied footage it hadn't already copied → tonight's zero-clip visits

Tonight's journal shows 9 distinct `finalize: scratch_dir unreadable … FileNotFoundError … — no clip` errors. Root cause reproduced by the replay: **nothing copies ring segments at finalize time.** Two concrete failure modes shared it:

- A visit whose subject appears on exactly ONE frame (very common in tonight's sparse flapping trace) gets an `open` but never an `extend` — and only `_on_extend` called `copy_new_segments`. Its scratch dir was never created, finalize found nothing, the event row 404s forever. **Every single-detection visit produced zero footage.**
- The absence-grace tail after the LAST extend was never copied, so every published clip ran ~`absence_finalize_s` shorter than its nominal window. At the operator's 22:08 setting (`absence_finalize=30`) the ±10 s duration check would have REFUSED every clip.

**Fix (shipped):** `visit_runtime.VisitRunner._catchup_copy` — one final synchronous `copy_new_segments` over the full `[start_ts, end_ts]` window in `_on_finalize` AND in the watchdog-escalation drain, same disk-floor/error posture as `_on_extend`. The ring still holds that footage at finalize time (the grace tail is far shorter than the ring window). Pinned by three new tests in `test_visit_recovery.py` (§7) and exercised for real by harness scenarios 1/3/5/6 (scenario 1 fails without it).

### B2 (HIGH, FIXED — F2): recovery retried unrecoverable visits forever

Tonight's journal: `recovery: finalize of visit f0ad6e… produced no clip — leaving FINALIZING for a later retry` at 21:56 (pid 4622) and again for `75743a…` at 22:02 (pid 5761). A FINALIZING entry whose scratch is gone can never succeed, and the old code re-attempted it on EVERY boot for eternity (log spam + a wasted real-ffmpeg finalize per boot + an immortal `.open_visits.json` entry).

**Fix (shipped):** bounded retry — `finalize_attempts` is persisted in the same durable write that flips the entry to FINALIZING; after `RECOVERY_MAX_FINALIZE_ATTEMPTS` (3) total failures the entry is abandoned with a loud ERROR (`summary["abandoned"]`). The existing "never silently dropped on first failure" pin is untouched (two retries still happen). Pinned by `test_given_finalize_keeps_failing_when_recovered_repeatedly_then_abandoned` + harness scenario 4.

### B3 (MEDIUM, NOT FIXED — pinned as known-bug): recovery window claims the grace tail → slow restarts lose the clip

`recover_open_visits` finalizes over `[start_ts, min(last_extend + absence_finalize_s, now)]` (plan B4's formula, pinned by `test_given_visit_with_no_output_when_recovered_then_finalized_from_scratch`). But scratch only ever holds footage up to `last_extend` — the grace tail was never recorded into scratch and the ring is gone by the next boot. So whenever recovery runs more than ~`(10s tolerance − edge)` after the crash, the expected window exceeds the real footage by ~`absence_finalize_s` and the honest, decodable clip is **refused by the duration check** ("off window by > 10s") → bounded retries → abandoned → footage lost. At `absence_finalize=30` this is guaranteed; at the default 10 it's a coin flip on restart latency (tonight's restarts were 60 s+ after the wedge).

**Proposed fix** (not applied because the current formula is pinned by an existing test AND by the plan doc — changing it means updating that pin deliberately): bound recovery's `end_ts` to `min(last_extend, now)` — the footage that actually exists — or, equivalently, relax the duration check for the recovery path only. One-line change in `recover_open_visits` + update the formula pin + flip `test_known_bug_given_slow_restart_when_recovered_then_clip_duration_refused` to assert success.

### B4 (LOW, NOT FIXED — documented): journal noise during the failure window

Secondary observations from tonight's log, no code change made: the pre-arm pid 29312 window shows the capture-error storm (114 lines in 42 min) that produced the flapping presence; these are absent frames to the state machine and are handled by the loop-top tick (plan B5) — verified by scenario 1 running the replay across those exact gaps.

## Scenario 1 data + knob recommendation

Tonight's real presence timeline (71 detection instants: journal gear transitions + emit lines + 35 real event rows, 21:30–22:12):

| absence_finalize_s | visits (replay == pure-gap oracle) |
|---|---|
| 5 | 35 |
| 10 (tonight's setting) | 31 |
| 15 | 29 |
| 20 | 26 |
| **30** | **20** |
| 45 | 16 |
| 60 | 14 |

Inter-detection gap histogram, the decision data: 11 real gaps fall in **(10, 30] s — {11.2, 11.6, 18.2, 18.2, 19.2, 22.0, 23.3, 23.3, 23.7, 24.5, 27.7}** — these are mid-presence flaps (capture-error storms + detector misses), each of which splits a real visit at `absence_finalize_s=10`. The next gap above is **36 s**, and beyond that gaps jump to 44–325 s (genuine departures).

**Recommendation: `absence_finalize_s = 30`.** It bridges every one of tonight's intra-visit flap gaps (the whole 10–28 s cluster) while sitting comfortably below the smallest genuine-departure gap (36 s), cutting tonight's event spam from 31 rows to 20 with zero footage loss (scenario 1 proves the recorded-window union covers every detection instant at both settings). 10 s is too twitchy for this camera's real flap profile; 45+ starts merging plausibly-distinct visits for marginal gain. NOTE: 30 is only safe **with fix F1 shipped** — pre-fix, 30 s would have made the duration check refuse every clip (B1 second bullet) — and B3 means crash-recovered visits will still be lost at 30 until B3 is fixed.

`max_visit_s`: no change recommended (150 s worked; cap-split adjacency + continuation flags verified in scenario 2).

## Verdict

**GO — conditional.** Re-enable `continuous_capture` in production with `absence_finalize_s=30`, `max_visit_s=150`, **after deploying fixes F1 + F2** (both in this tree, fully pinned; without F1 the feature loses every single-detection visit and refuses every clip at the 30 s setting — tonight's exact failure). Ship B3's one-line recovery-window fix in the next slice before trusting crash recovery on slow restarts; until then a mid-visit worker crash can still lose that one visit's clip (bounded, loud, no crash-loop). All 17 harness tests + the full detection suite are green with the fixes in.
