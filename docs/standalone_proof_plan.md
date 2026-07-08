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
- [x] P7 person filter gates before fanout
- [x] P8 quiet-hours filter gates before fanout
- [x] P9 webpush call-boundary kwargs (TTL/urgency) — FOUND+FIXED real bug: TTL=0 default dropped notifications for offline phones
- [x] P10 LIVE: single-sub test push accepted by real gateway (gated; live-verified 2026-07-08, sent=1, no prune, no secret leakage)
- [x] P11 LIVE: event-shaped payload accepted, image+badge intact (gated; live-verified 2026-07-08 through real send_matching, sent=1)
- [x] P12 LIVE: 404/410 prune on disposable copy over real network
      (gated; live-verified 2026-07-08 — synthetic-dead sub pruned on a
      real gateway 404, all 8 real subs accepted and retained; registry
      has ZERO naturally-dead subs, a parity finding in itself)
- [x] P13 PARITY prep (product): per-event fanout outcome now logs at
      INFO ('push fanout event=… sent=… filtered=… failed=… pruned=…',
      6583833); ALSO fixed fetch script to capture the docker app-log
      stream (b538c47). REMAINING operator half: cross-deploy server,
      let real events flow, re-fetch snapshot before P14 can run
- [x] P14 PARITY: replay real person events from .jetson-snapshot/db/
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
- [x] A4 access-expired + refresh-valid REST path rotates and retries
- [x] A5 refresh single-flight under concurrent 401s (server side: sliding-window reuse pinned)
- [ ] A6 refresh-expired emits ONE session-expired
- [x] A7 REPRODUCER: WS 1008 + /me 401 signs out despite valid refresh
      (confirmed vs production trace — zero refresh attempts; 7552510)
- [x] A8 fix contract: 1008 attempts refresh before anon (88fc13e;
      single-flight reuse, signals stay distinct, full client suite green)
- [x] A9 1008 + failed refresh -> session-expired (3ca4018)
- [ ] A10 real-browser cookie expiry/rotation (Playwright, scratch uvicorn)
      — decomposed (codex design r5, 2026-07-08): runner = existing
      Playwright conventions; new playwright.auth-harness.config.ts (no
      global webServer) + client/e2e/authHarness.ts fixture (temp dirs,
      free port, env TTL/secret injection, uvicorn spawn/readiness/logs)
      + auth-session-lifecycle.spec.ts; env-gated HOMECAM_RUN_REAL_BROWSER_AUTH=1
  - [x] A10.0 infra: harness boots scratch uvicorn serving built dist; browser reaches login (live-run green 2026-07-08)
  - [x] A10.1 real-Chromium login cookie attrs (httpOnly/path/sameSite/expiry) (live-run green 2026-07-08)
  - [x] A10.2 access expiry rotates via refresh; cookie values/expiry change; stays authed (live-run green 2026-07-08, exactly one refresh 200)
  - [x] A10.3 both-expired reaches session-expired UX (live-run green 2026-07-08; all refresh attempts 401, bounded, lands /login?expired=1)
- [ ] A11 background/resume past access TTL stays signed in
  - [x] A11.1 resume past access TTL refreshes and stays signed in (live-run green 2026-07-08 — the production mobile-resume scenario, browser-proven)
  - [x] A11.2 WS reconnect self-heal after expiry (browser leg of A8) —
        FOUND+FIXED production bug 23f2a50: pre-accept close(1008) reached
        real browsers as 1006, so ws.ts's no-retry + homecam:auth-failed
        contract had NEVER fired from the live server (jsdom mocks hid it);
        accept-then-close makes the whole chain real (866d760, live-run green)
- [ ] A12 secret rotation kills sessions into session-expired
  - [x] A12.1 rotation kills REST refresh into session-expired (live-run green 2026-07-08; confirms restart-with-unpersisted-secret WOULD sign everyone out — check the deploy volume persists jwt secret)
  - [x] A12.2 rotation kills WS self-heal into session-expired (live-run green 2026-07-08; quiescence check pins no-storm after landing on /login)
  - [x] A12.3 parity ledger: browser/server event ledger diffs against Jetson auth trace shapes
        (live-run green 2026-07-08; parity finding: Chromium deletes expired
        cookies, so browser-side expiry 401s reach the server as no-cookie —
        production's expired-signature-WITH-cookie lines are the narrow
        clock-skew window, a distinct shape)
- [x] A13 PARITY: replay the real auth_rejected sequences from the
      captured docker app log against the scratch server — both
      production REST rejection shapes (40x expired-signature, 5x
      no-cookie) reproduce identical reason+cookie_present lines;
      WS shape deferred to A10's browser leg (named TODO)

## Harness #4 — snapshot/thumbnail pipeline: atomic steps (spec: codex r6, 2026-07-08)
Risky cores: unauth thumb carve-out boundaries; thumb_url wire regex;
DB->file->route->production-log parity chain (9 logged filenames overlap
all four). Fixtures: proof_fixtures/snapshots/ (139 real jpgs),
events.sqlite (2772 thumb_urls), homecam-server-app.log (real unauth
push-daemon fetches).
- [x] H4.1 fixture inventory readable, counts nonzero
- [x] H4.2 every DB thumb_url matches ^/snapshots/thumb_[0-9]+\.jpg$
- [x] H4.3 fixture filenames are only production shapes
- [x] H4.4 DB->file overlap set nonempty, reported
- [x] H4.5 worker save_thumb contract (path shape, dir, no external URLs)
- [x] H4.6 worker retention: prunes only thumb_*, spares latest/snap
- [x] H4.7 wire accept: real-shaped event with fixture thumb_url preserved
- [x] H4.8 wire reject: external/traversal/wrong-shape thumb_url refused
- [x] H4.9 push image == thumb_url exactly (spied send_matching)
HARNESS #4 COMPLETE 2026-07-08 — 15/15, parity chain green.
- [x] H4.10 unauth thumb serve: 200, image/jpeg, exact bytes, no Set-Cookie
- [x] H4.11 latest/snap 308 to auth-gated path; arbitrary names 404
- [x] H4.12 EventList thumb consumption (img src, selectability)
- [x] H4.13 ClipModal poster + still fallback
- [x] H4.14 SW: payload image -> notification options image, unrewritten
- [x] H4.15 PARITY: every production-logged thumb 200 replays 200 with
      matching bytes AND appears in events.sqlite thumb_url (green 2026-07-08)

## Harness #9 — export ZIP: atomic steps (spec: codex r7, 2026-07-08)
Main job: prove the OOM fix (tempfile-on-recordings_dir + FileResponse
+ BackgroundTask unlink + Semaphore(1)) keeps RSS flat vs ~289MB of
real clip bytes. Fixtures: proof_fixtures/clips/ (6 real MP4s, 9.8-80MB,
IDs match events.sqlite rows).
- [x] H9.1 fixtures.py + inventory (clips<->DB rows, sizes)
- [x] H9.2 fixture integrity (every clip has a DB row, bytes nonzero)
- [x] H9.3 scratch recordings_dir builder (byte-for-byte)
- [x] H9.4 get_by_ids order + row parity vs captured DB
- [x] H9.5 single-clip ZIP: manifest + exact MP4 bytes
- [x] H9.6 six-clip ZIP: all bytes match, manifest rows match DB
- [x] H9.7 tempfile called with dir=recordings_dir, delete=False
- [x] H9.8 measured RSS flat vs 289MB input (bounded delta)
- [x] H9.9 Semaphore(1) serializes concurrent builds
- [x] H9.10 missing clip -> 200 + clip_included=false, no 500
- [x] H9.11 unlink after serve (no homecam_export_*.zip left)
- [x] H9.12 failure mid-zip -> 500 + partial cleaned
- [x] H9.13 PARITY: manifest rows vs captured DB; members vs captured bytes;
      note absent Jetson export-log ground truth as observability gap
HARNESS #9 COMPLETE 2026-07-08 — 13/13 incl. measured-RSS OOM guard + parity close.

## Harness #7 — event bus + SQLite under real cadence: atomic steps (spec: codex r8, 2026-07-08)
Fixtures: continuous_capture_fixtures/events_tonight.json + journal cadence,
events.sqlite, fresh docker app log. Parity target: accepted persisted
events (F16 ledger separates worker-lost attempts).
- [x] F1 fixtures.py + inventory
- [x] F2 fixture row normalization (json<->sqlite parity of the fixture itself)
- [x] F3 real row -> DetectionPayload conversion
- [x] F4 scratch DB replay through real event_bus.publish
- [x] F5 route ingest replay with pinned time
- [x] F6 lazy-import circular-dep pin
- [x] F7 idempotent duplicate stream (rows unchanged pass 2)
- [x] F8 duplicate live-fanout contract pinned
- [x] F9 slow subscriber never blocks publish
- [x] F10 queue overflow drops only the stuck subscriber
- [x] F11 overflow warning rate-limited + resets
- [x] F12 WS closed-transport unsubscribes cleanly
- [x] F13 SQLite lock contention fail-open pinned (may expose busy_timeout gap)
- [x] F14 concurrent readers during ingest
- [x] F15 PARITY: full night replay diffs vs events_tonight.json AND events.sqlite
- [x] F16 app-log acceptance ledger (accepted vs worker-lost)
HARNESS #7 COMPLETE 2026-07-08 — 16/16 incl. full-night parity replay.

## Harness #5 — WebRTC/WHEP browser resilience: atomic steps (spec: codex r9, 2026-07-08)
Two honest legs: LIVE vs the real Jetson (env HOMECAM_LIVE_WHEP=1; real
first frames per rung) + LOCAL whep-error-harness (real Chromium
RTCPeerConnection, error paths only — a canned SDP cannot make frames).
Parity: per-attempt browser ledger diffed vs mediamtx.log + client_log lines.
- [x] W1 live config reusing auth-harness runner shape
- [x] W2 live fixture: console/event capture + JSON attempt ledger
- [x] W3 LIVE smoke: real frame -> Live pill only after frame evidence
- [x] W4 LIVE rung hq (/whep/cam/whep, first frame <8s)
- [x] W5 LIVE rung sd (/whep/cam_lq/whep)
- [x] W6 LIVE rung xs (/whep/cam_uq/whep)
- [x] W7 LIVE quality switch: old attempt closes, no stale-blank
- [x] W8 LIVE resume/error coalescing: at most one reconnect
- [x] W9 local error-harness fixture (404/503/hang/net-close/invalid-sdp)
- [x] W10 local: non-2xx -> error UI, manual Retry = exactly one POST
- [x] W11 local: hung POST aborted on unmount/switch, no leak
- [x] W12 local: invalid SDP -> set-remote-failed, never Live
- [x] W13 observability: attempt ledger (id, rung, timings, no SDP/IPs)
- [x] W14 parity prep: settled-attempt client logging
- [ ] W15 parity capture: live run + fresh Jetson log fetch
- [ ] W16 PARITY diff: ledger vs mediamtx/client_log by rung/outcome/window
- [ ] W17 completion gate: live frames + local errors + parity all green

## Harness #8 — face recognition: atomic steps (spec: codex r10, 2026-07-08)
FINDING: production has ZERO named person rows — recognition has never
fired live (capture-only). Named parity gated on a future refreshed
snapshot (R14 sentinel). Deps INSTALLED in /tmp/homecam-venv (ephemeral!
recreate recipe: pip install face_recognition "setuptools<81" +
pip install git+https://github.com/ageitgey/face_recognition_models —
setuptools>=81 removes pkg_resources which the models package needs).
- [x] R1 fixtures.py: persons/ inventory + sidecar schema + DB overlap
- [x] R2 sidecar integrity vs DB rows
- [x] R3 DB ground truth: pin zero-named-rows state explicitly
- [x] R4 lazy-import boundary: no face_recognition import w/o encodings.pkl
- [x] R5 load-mode: missing/corrupt encodings => capture-only
- [x] R6 gated: real encode_known_faces build into temp encodings.pkl
- [x] R7 gated: threshold ledger on real same-person/stranger crops
- [x] R8 gated: replay all real person crops, record outcomes
- [ ] R9 PARITY: replay decisions vs production person_name (all-null now)
- [x] R10 null-name propagation through ingest + face_unrecognized search
- [x] R11 named propagation contract (person_names -> legacy person_name)
- [x] R12 training/review routes against copied real fixture tree
- [x] R13 name-them flow contract (review link + sidecar move)
- [x] R14 refresh-required sentinel for named parity
- [ ] R15 close only after fresh named snapshot passes parity

## Harness #6 — SW cache/update: atomic steps (spec: codex r11, 2026-07-08)
A/B two-build rig on the scratch uvicorn; real Chromium SW lifecycle.
- [x] H6.1-H6.4 rig: two real builds with markers, scratch serve, SW active
- [x] H6.5 first-load-after-deploy truth pinned (A or B — observed reality)
- [x] H6.6 takeover timing (controllerchange -> B)
- [x] H6.7 fetch ledger explains 6.5/6.6
- [x] H6.8 precache completeness (no excluded cat PNGs)
- [x] H6.9 offline shell renders from cache
- [x] H6.10 events NetworkFirst: cached 200 offline; 401 never cached
- [x] H6.11 notificationclick: dismiss/view/tap contracts
- [x] H6.12 stale-handler risk pinned across A->B
- [ ] H6.13 observability prep (build-id visibility) if needed for parity
- [ ] H6.14 PARITY vs production log window post-deploy

## Harness #10 — multicam synthetic: atomic steps (spec: codex r12, 2026-07-08)
- [ ] M10.1 contract doc vs code audit
- [x] M10.2 local mediamtx fixture (env-gated download/boot)
- [x] M10.3 ffmpeg testsrc RTSP publish -> /synth/whep
- [x] M10.4 two-camera registry route
- [ ] M10.5 browser switcher -> /whep/synth/whep
- [ ] M10.6 quality rung URL composition per camera
- [x] M10.7 worker DETECT_CAMERA_ID -> payload camera_id
- [ ] M10.8 per-camera persistence + search filter
- [x] M10.9 client Events camera chip narrows (already pinned: Events.test.tsx "camera chip is selected...list narrows" + "Load more...camera= forwarded"; codex skip-pin of a search-on-chip-activation contract REJECTED as aspirational, not current product behavior)
- [ ] M10.10 LIVE dynamic publish probe (gated)
- [x] M10.11 PARITY: cam1->front_door migration on scratch copy
- [x] M10.12 PARITY: production DB single-camera invariants
