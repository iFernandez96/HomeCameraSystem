# Continuous (person-following) event recording — plan of attack

**Status:** architecture green-lit by multi-expert critique (2026-06-21); execute revised.
**Goal (user):** follow the same subject through an event and record *continuously* until they leave; then a post-roll grace timer runs; if they return before it expires, reset it. One **visit = one clip** — no overlapping per-event clips, so the daily-timelapse "teleport" disappears at the source.

## Why this kills the teleport
Today each detection re-fire records its own fixed ~90.7s clip; one lingering presence → many clips overlapping ~85s. The server de-overlap front-trims with concat `inpoint` under `-c copy`, which can only cut at a **keyframe** — and the *recorded* GOP is **~4.3s** (measured, not the WHEP path's 133ms). So the trim snaps back up to ~4.3s → re-shown footage → backward playhead jump. One-visit-one-clip means **no sibling clips to de-overlap → nothing to snap → no teleport.**

## Architecture (chosen: Design B — confirmed sound)
Reuse the **always-on** `-c copy` segment ring (`detection/preroll.py::PrerollBuffer`, verified started at boot `detect.py:1206-1252` regardless of `clip_pre_roll_s=0`). A visit is a `[start_ts, end_ts]` wall-clock window. A pure state machine decides open/extend/finalize. On finalize, a daemon thread concats the visit's **already-copied** segment range into one `<event_id>.mp4` (`-c copy -f mp4`, atomic `os.replace`). **No per-visit encoder to start/stop → the moov-on-SIGINT gamble does not exist** (moov comes from self-contained ring slots + a fresh concat container). Single-owner libargus untouched (both ring + detector read `rtsp://localhost:8554/cam`; zero new RTSP readers).

## Corrected key numbers (real data — ./.jetson-snapshot/)
| Quantity | Use |
|---|---|
| Stream bitrate **0.31 MB/s (2.48 Mbps)** | const `DETECT_STREAM_BYTES_PER_S ≈ 325000`; size everything in BYTES |
| Recorded GOP / edge-snap **~4.3s** | pre-roll/edge precision is ±~4.3s (accept for a doorbell); segment slots are GOP-floored ~4.3s |
| `max_visit_s` default **120–180s** (NOT 600) | caps stuck-detection fill at ~37–56 MB/clip |
| Finalize timeout | **bytes-scaled** over total input bytes, covers copy + faststart; replaces hard 30s/120s |
| `absence_finalize_s` **new field, default 8–15s** | the post-roll grace; `clip_post_roll_s` deprecated/ignored |
| Post-validate | **`ffmpeg -v error -i out -f null -`** + grep `non monoton`/`Invalid data`/`moov atom not found` + duration≈window; ffprobe-rc=0 is NOT enough |
| Disk backstop | **byte-budget evictor (NEW, ships with feature)** + mandatory `statvfs` floor checked on **every extend** |

## BLOCKERS (must be in before the risky slices / live flip)
- **B1** Finalize post-validate must be a real **decode pass** (`-f null -`), not `_clip_has_video` (rc=0 on broken output). `-c copy` concat of `-reset_timestamps` slots injects "non monotonic dts" at GOP joins — display-PTS stays ordered so HTTP `<video>` is fine, but the output is **HTTP-playback-only and must never feed WebRTC/transcode**. Pin that.
- **B2** Disk sizing was ×15 wrong. Recompute in bytes; `max_visit_s` default 120–180s; **byte-budget free-space evictor ships with the feature** (time-only retention won't reclaim for weeks); worker open/extend floor must sit **above** the server eviction floor (pin ordering by test); `statvfs` floor checked on **every extend**, not just open.
- **B3** **Incremental copy-on-extend is SLICE-2, not deferred.** Copy each completed segment into per-visit scratch on the extend tick *before* the ring can wrap it (re-uses the iter-356.51 copy-before-wait defense; `recording.py:454-466`). Then ring size is irrelevant to correctness — size the **scratch**, keep the ring at its existing wrap.
- **B4** Crash recovery must be **idempotent**: 3-state on-disk lifecycle `OPEN→FINALIZING→DONE`; recovery skips any visit whose `<id>.mp4` already exists with a valid moov (ffprobe-gate); drop the entry/write DONE **before** `os.replace` commits; **fsync** the `.open_visits.json` dir on open. Property test: random crash points never yield two `os.replace` for one `event_id`.
- **B5** `visit_tracker.tick(now,...)` goes at the **TOP of the detection loop body, before any early-`continue`** (`detect.py:1849-1851` early-continues on no-detection/zone-reject/coalesced — exactly the absent frames the deadline needs). Regression test: all-empty frames → finalize fires at the deadline.

## Required revisions (majors)
- **R1** Delete every "133ms" claim; edge precision ±~4.3s. `segments_in_range` granularity ~4.3s (drop the 1s-divisor capacity math). Timelapse sidecar `offset_s` from the finalized clip's **actual first PTS** (ffprobe), not nominal `start_ts`.
- **R2** `v2.start_ts == v1.end_ts` exact cap-split is **unachievable** under `-c copy`. Keep the **pure SM nominal**; handle adjacency at finalize: both continuation windows share one **whole boundary segment with no seam trim** (trim only the visit's outer edges). Test #6 → `v2.start_ts <= v1.end_ts within one GOP`; de-overlap still runs across continuation segments (NOT a no-op there). Prove with a real-ffmpeg test on a **4.3s-GOP** fixture.
- **R3** `clip_post_roll_s` semantic flip → introduce **new `absence_finalize_s`** (default 8–15s), deprecate/ignore old field (live operator value is 76.0 — don't reinterpret). One-time Settings note. Clip-ready latency now `absence_grace + bytes-scaled concat` → feeds R4.
- **R4** Client 404→retry is **sticky, no auto-retry** (`ClipModal`). **Do NOT send `clip_url` in the open-time POST**; emit a "clip ready" WS event-update at finalize that sets `clip_url` on the row (reuse existing WS update path), so the play affordance only lights when the file exists.
- **R5** On `mediamtx_watchdog` escalation (mediamtx/nvargus restart, or reboot mid-visit): **finalize the open visit immediately at `last_seen`** and persist `.open_visits.json` **before** reboot; next detection opens a continuation. Test: mid-visit escalation → short *valid* clip.
- **R6** Wire-contract: `WorkerMetrics` + config types live in **`client/src/lib/types.ts`** (not `api.ts`). `max_visit_s` slider needs `MAX_VISIT_MIN/MAX` server consts + `maxVisitMin/Max` client `DETECTION_LIMITS` + `expected_pairs`. New metrics need **all three** symmetry edits + follow existing `clip_*` naming. Add distinct disk metrics: `clips_dropped_disk_floor` (≠ `clips_dropped_capacity`), `visits_truncated_ring_wrap`, `scratch_orphans_reclaimed`. Run `wire-contract-sync`.
- **R7** **Drop the "legacy de-overlap marker"** — de-overlap is data-driven (`covered_until` vs `ts+duration`); disjoint windows yield inpoint 0 already. A marker adds a phantom wire surface and risks mis-gating → teleport. Keep de-overlap as the universal safety net.
- **R8** Orphan-scratch reaping on **every** finalize exit (`try/finally rmtree`), opportunistically before each open, AND at boot — scope boot sweep to `_visits/*` + `*.mp4.tmp` **ONLY, never `_preroll/seg_*`**. `Semaphore(1)` on finalize (Nano OOM history).
- **R9** Bytes-scaled finalize timeout must actually **replace** the hard 30s/120s. Consider dropping `+faststart` for large finalized clips (full-file second pass over ~186 MB on slow eMMC).

## Confirmed-sound (do not re-litigate)
Ring always-on regardless of `clip_pre_roll_s=0`; single-owner libargus untouched; no-encoder-to-stop sidesteps moov gamble; `-c copy -f segment -reset_timestamps 1` + `shutil.copy2` decouple real; events_db single `clip_url` 1:1 holds; de-overlap data-driven; clips on host SD via bind mount (512MB container cap bounds finalize RAM, not storage); real load 48 events/day with 4.6–13.4s overlap.

## Files
**New:** `detection/visit.py` (pure SM), `detection/tests/test_visit.py`.
**Changed (detection):** `preroll.py` (`segments_in_range`, incremental `snapshot_range_so_far`, byte-sized capacity), `recording.py` (`finalize_visit`: real-decode validate, bytes-timeout, `Semaphore(1)`, `try/finally` rmtree, `statvfs`), `detect.py` (loop-top `tick`, `is_present`→`VisitTracker`, 3-state fsync recovery, watchdog-finalize coupling, hard-XOR flag, env knobs), `presence.py` (thin `is_present`), `metrics.py` (new `clip_*`/disk metrics).
**Changed (server):** `detection_config.py` (`absence_finalize_s`, `max_visit_s`, `MAX_VISIT_MIN/MAX`; mirror in `_internal`), `_internal.py` (`_ALLOWED_METRIC_FIELDS`), `routes` (clip-ready WS update at finalize), `timelapse.py` (sidecar offset from real PTS; no marker), **NEW byte-budget evictor** in retention.
**Changed (client):** `lib/types.ts` (`WorkerMetrics`, config types, `DETECTION_LIMITS`), Settings slider + copy, `api.test.ts`.

## Slice order (0→1→2→3→4→4.5→5→6→7)
- **S0 tests-first** — `test_visit.py` incl. countdown-reset, keyframe-aware split (relaxed), crash-idempotency property. RED.
- **S1 pure SM `visit.py`** — 100% offline, ship first. `absence_finalize_s` as call-arg; nominal boundaries (keyframe-awareness lives in finalize).
- **S2 ring range API** — `segments_in_range` (GOP-granular), **incremental copy-on-extend** (B3), byte-sized capacity. Offline.
- **S3 `finalize_visit`** — heaviest. Real-decode validate (B1), bytes-timeout (R9), `Semaphore(1)`+`try/finally` (R8), `statvfs` every-extend (B2). Real-ffmpeg gated test on **4.3s-GOP** fixture: one clip, no backward PTS, clean DTS. Offline (real ffmpeg, no Jetson).
- **S4 detect.py wiring + recovery** — loop-top `tick` (B5); 3-state idempotent fsync recovery (B4); watchdog-finalize coupling (R5); hard-XOR flag default **off**.
- **S4.5 byte-budget evictor** (B2) — age-independent free-space eviction; worker-floor-above-server-floor pinned by test. Before S7.
- **S5 server config + timelapse** — `absence_finalize_s` + `MAX_VISIT_*`; sidecar offset from real PTS; no marker.
- **S6 metrics symmetry + client** — `types.ts` (not api.ts); 3 symmetry edits; distinct disk metrics; no-`clip_url`-at-open + clip-ready WS update (R4). Run `wire-contract-sync`.
- **S7 LIVE JETSON** (gate) — cross-deploy, flip flag per-retention-preset (enable `week` first); disk-bake with auto kill-switch reverting `continuous_capture→false` if free space < floor. Acceptance: walk-in→one clip through motion flaps→no teleport; leave→finalize ~grace later, valid moov; return after grace→new clip; stand still 11min→adjacent capped clips; daily reel monotonic.

**Do not reach S3 finalize or S7 live-flip until B1–B4 + the evictor are in.** S0–S1 are safe to start immediately.
