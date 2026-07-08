# Standalone-proof program — every feature proven against real data (draft r1)

Method (proven on continuous capture 2026-07-07): isolate each feature's
risky core, build a replay/fixture harness that drives the REAL modules
with REAL captured data (never hand-invented fixtures, never
reimplementations), pin the full lifecycle, fix what the harness catches,
only then trust production. Claude plans and reviews; codex (gpt-5.5)
writes the harness code; brainstorm rounds recorded here.

## Inventory — feature → risky core → current proof state

### Already proven offline (keep, extend on touch)
| Feature | Core | Proof |
|---|---|---|
| Presence coalescing | presence.py | test_presence (pure) |
| Continuous capture | visit.py + visit_runtime | replay harness vs real prod trace (2026-07-07) |
| Watchdog escalation | mediamtx_watchdog.py | persisted-ladder tests |
| Timelapse build/de-overlap | timelapse.py | real-ffmpeg suite incl. 4.3s-GOP de-overlap |
| Zones | zones.py 3-way mirror | pure tests both sides |
| Memory/thermal gears | memory_guard/thermal_guard | hysteresis tests |
| Box normalization | box_norm.py | pure tests |
| Wire contracts | mirror tests | 3-way metric pin + api.test.ts |

### Gaps — candidates for new harnesses (draft priority)
1. **Push notifications end-to-end** — VAPID webpush round-trip, filters,
   quiet hours, badge count, SW display+click. Today: mocked fanout only.
   Real fixtures possible: capture a REAL browser push subscription (the
   phone's), send real webpush from a harness, assert delivery payloads.
2. **Face recognition** — encodings build, match thresholds, lazy-dlib
   boundary. Today: untested logic (dlib hazard). Real fixtures: actual
   snapshots/thumbs from events.db (real faces of household), run real
   face_recognition lib on dev machine (no Nano deadlock there).
3. **Retention + byte-budget evictor under real disk shapes** — replay a
   real recordings-dir manifest (sizes/ages from prod) through eviction;
   prove floors, ordering vs worker floor, no eviction of open visits.
4. **Backup/restore round-trip** — real backup file from prod → restore
   into scratch → assert config/users/zones equivalence; version drift.
5. **WebRTC/WHEP client resilience** — browser-driven suite (Playwright)
   against the live MediaMTX: first-frame, quality switch, network drop,
   resume, silent-retry. Today: jsdom-only; device checks are manual.
6. **Multicam with a real second stream** — publish a synthetic RTSP path
   (ffmpeg test pattern) into MediaMTX as camera #2; prove registry,
   per-camera events, switcher, filter — WITHOUT second hardware.
7. **OTA update flow** — staged update against a scratch clone of the
   deploy layout; prove version gates, rollback, kill-switch.
8. **Export ZIP** — real clips from prod snapshot; 50-cap, semaphore,
   memory ceiling measured (RSS), unlink-after-serve.
9. **Auth/session lifecycle** — token expiry/refresh/kind claims replayed
   over a compressed clock; the phone's "signed out twice tonight"
   annoyance suggests a refresh-path gap worth proving.
10. **Snapshot/thumb pipeline** — real frames → thumb encode → unauth
    carve-out shape.

## Open questions for codex round 1
- What did this inventory miss? (Scan the repo.)
- Rank the gaps by (risk of silent production breakage) x (feasibility of
  REAL fixtures).
- For each: what is the exact input→output contract of the risky core,
  and what real fixture capture strategy makes the harness honest?
- Which existing test suites LOOK like proof but are mock-hollow?

## Rounds log
- r1 (Claude): inventory drafted; sent to codex for critique.

## Round 2 (Claude) — decisions on codex r1
Accepted: the nine inventory additions; the mock-hollow list becomes the
audit trail (each harness must name which hollow suite it supersedes).
Ranking adjustments:
- Push splits into two legs: (a) real-gateway send (real VAPID -> FCM,
  assert gateway 201/prune semantics) — runnable now; (b) device
  display/click leg — deferred until the phone is available.
- OTA + backup/restore drop out of proof scope until de-stubbed; their
  first "harness" is an honest implementation. Logged as separate work.
- Multicam uses the synthetic second RTSP path (ffmpeg test pattern into
  MediaMTX) — no hardware needed.

EXECUTION ORDER (fixture-readiness x risk):
1. Retention + evictor (manifest captured: proof_fixtures/recordings_manifest.txt)
2. Auth/session lifecycle (compressed-TTL local server, real browser)
3. Snapshot/thumb pipeline (139 real images captured)
4. WebRTC/WHEP live browser suite (live Jetson, Playwright)
5. Push gateway leg (real subscription already persisted server-side)
6. SW cache/update semantics
7. Event-bus fanout under real cadence + SQLite concurrency (one rig)
8. Face recognition (real household images, dev-machine dlib)
9. Export ZIP (real clips, measured RSS)
10. Multicam synthetic second camera
11. De-stub OTA / backup-restore, then prove them

Division of labor: Claude specs + reviews + captures fixtures + runs
suites; codex writes every harness. Rounds logged here.

## Round 3 (converged)
Codex r2 agreed on both scope calls; accepted its reorder — push gateway
leg moves to #2, auth to #3, snapshot/thumb #4, WHEP live suite #5.
Harness #1 spec: docs/audits/proof-program-codex-r2.md (verified seams
exist in recording_service.py). Implementation: codex, workspace-write;
review + gate: Claude.

## STANDING RULE — atomicity (Israel, 2026-07-08)
Every harness and every feature is built as SMALL ATOMIC STEPS:
- Specs end in a numbered atomic step list; codex implements ONE step per
  invocation; Claude runs + gates + commits each step before the next.
- One invariant per test, one concern per step, one step per commit.
- If a step cannot go green without touching more than its own concern,
  the feature is too entangled to prove: it goes on the REBUILD list and
  gets redone from scratch in atomic slices. Rework is acceptable;
  unproven code is not.
- Rebuild list (de-stub/redo first, then prove): OTA update flow,
  backup/restore.

## STANDING RULE — ground-truth parity (Israel, 2026-07-08)
THE goal of every standalone: given the raw outputs captured from the
Jetson, the harness driving the REAL modules must produce results
IDENTICAL to what the live Jetson actually produced. Not "the contract
holds" — "the same bytes/rows/decisions the production system emitted."
- Every harness ends with a PARITY leg: replay real captured inputs
  (events.sqlite rows, journald traces, real clips/segments, real
  registries) through the real code and diff against the Jetson's own
  recorded results for the same inputs. Contract pins (P1-P9 style) are
  scaffolding; the parity leg is what closes a harness. No harness is
  "done" without one.
- Fixtures are always REAL captures, never hand-invented (unchanged).
- If the Jetson-side ground truth needed for a diff was never recorded
  (e.g. push send outcomes only log at debug), the harness gains a step
  that makes production record it (log-level promotion, sidecar, etc.)
  + a fresh fetch-jetson-data.sh capture — observability gaps are
  harness work, not an excuse to skip parity.
- Every codex step prompt carries this criterion; every gate checks it;
  drift from this goal is a gate-reject even if tests are green.
- Ground truth inventory: .jetson-snapshot/db/events.sqlite (+ .dump.sql),
  logs/homecam-detect.log, continuous_capture_fixtures/ (journal +
  events + 118 real segments — the model parity leg, proven 2026-07-07),
  proof_fixtures/{push,snapshots,persons,clips,recordings_manifest.txt}.
  Refresh opportunistically whenever the Jetson is reachable.

## Harness #1 — retention/evictor: atomic steps (spec: proof-program-codex-r2.md)
- [x] A1 manifest parser (manifest_fixture.py) + parser-integrity test
- [x] A2 sparse scratch builder + size/mtime round-trip test
- [x] A3 sweep_and_evict injection seam (disk_usage/list_clips kwargs), default path byte-identical
- [x] A4 invariant: expiry sweeps before byte eviction
- [x] A5 invariant: byte floor met via oldest-fresh prefix, mtime order
- [x] A6 invariant: untouchables survive (non-mp4, _preroll/, _visits/, *.mp4.tmp, .open_visits.json)
- [x] A7 invariant: sidecar policy pinned as-is
- [x] A8 invariant: second pass idempotent
- [x] A9 invariant: WORKER_MIN_FREE_BYTES > SERVER_MIN_FREE_BYTES

## Harness #2 — push gateway leg: atomic steps (spec: proof-program-codex-r3-push.md)
Claude redirects: live steps target ONE known-current sub (single buzz,
not 8); prune test mutates the DISPOSABLE fixture copy over real
network, never the prod registry.
- [x] P1 fixture parser + secret-hygiene pin
- [x] P2 real VAPID PEMs load through real PushService
- [x] P3 log redaction: failure paths never emit endpoint/key bytes
- [x] P4 payload contract (title/body/tag/url/event_id/unread_count/image)
- [x] P5 payload without thumb: image key absent, not null
- [x] P6 camera filter gates before fanout
- [ ] P7 person filter gates before fanout
- [ ] P8 quiet-hours filter gates before fanout
- [ ] P9 webpush call-boundary kwargs (TTL/urgency) — may add prod kwargs
- [ ] P10 LIVE: single-sub test push accepted by real gateway (gated)
- [ ] P11 LIVE: event-shaped payload accepted, image+badge intact (gated)
- [ ] P12 LIVE: 404/410 prune on disposable copy over real network (gated)
- [ ] P13 PARITY prep (product): promote per-send outcome logging from
      debug to info (send successes are currently invisible in journald —
      0 push lines in 48h — so no Jetson-side ground truth exists yet);
      deploy, let real events flow, re-fetch snapshot
- [ ] P14 PARITY: replay real person events from .jetson-snapshot/db/
      events.sqlite through the real route + real registry copy; diff
      selected subs, payload fields, and send outcomes against the
      Jetson's own journald send lines for the same events

## Harness #3 — auth/session lifecycle: atomic steps (spec: proof-program-codex-r4-auth.md)
Motivating symptom: double silent sign-out 2026-07-07 evening. Top
hypotheses: WS-1008 path never attempts refresh before anon (#1); no
proactive refresh across backgrounding (#2). A7 is the reproducer; A8
is the product fix contract if A7 confirms.
- [x] A1 login cookie contract (names/path/secure) on scratch server
- [x] A2 token kind/sub/role/exp claims pin
- [x] A3 wrong-kind boundary 401s both directions
- [ ] A4 access-expired + refresh-valid REST path rotates and retries
- [ ] A5 refresh single-flight under concurrent 401s
- [ ] A6 refresh-expired emits ONE session-expired
- [ ] A7 REPRODUCER: WS 1008 + /me 401 signs out despite valid refresh
- [ ] A8 fix contract: 1008 attempts refresh before anon
- [ ] A9 1008 + failed refresh -> session-expired
- [ ] A10 real-browser cookie expiry/rotation (Playwright, scratch uvicorn)
- [ ] A11 background/resume past access TTL stays signed in
- [ ] A12 secret rotation kills sessions into session-expired
- [ ] A13 PARITY: replay the real auth_rejected sequences from Jetson
      journald (homecam-server) against the scratch server — same
      request shapes must produce the same rejection reasons and codes
      the live server logged; diff harness WARN lines against the
      captured ones
