I have enough context. The inventory is exhaustive and I've confirmed the key chokepoints (main.py:22 basicConfig, tokens.decode:106-121, api.ts req:84-104). Writing the plan now.

# Comprehensive Logging Implementation Plan — HomeCameraSystem

Goal: no failure on any path goes unexplained. Every silent `except`, every `return None`/`return False`/`return []` swallow, every bare `raise HTTPException` becomes a greppable line stating the **operation + express reason + identifying ids**, while honoring existing CLAUDE.md pins (hot-path silence, DEVNULL-vs-PIPE, metric whitelist, `_SuppressNoisyAccess`).

---

## 1. Logging conventions to adopt

Three tiers, three regimes. Each keeps its existing transport; the plan standardizes *shape* and *coverage*, not infrastructure.

### 1.1 Server (in-container, Python 3.11)

Keep `logging.basicConfig` (`server/app/main.py:22`) and per-module `log = logging.getLogger(__name__)`. Three changes:

- **Add a level knob.** `server/app/main.py:22` becomes:
  ```python
  logging.basicConfig(level=os.environ.get("HOMECAM_LOG_LEVEL", "INFO"),
                      format="%(asctime)s %(levelname)s %(name)s: %(message)s")
  ```
  This makes every DEBUG proposal below dormant-but-flippable during triage. No structured/JSON — keep plain text, `%s` lazy interpolation (NEVER f-strings — defeats level-gating and matches the detection-side parity habit).
- **Introduce `log.error` as a distinct level.** Today the convention collapses error+warning into `warning`. Reserve `error` for genuine 500-class failures (DB read failed, write OSError, startup-step abort, ZIP build crash) so they grep apart from benign `warning`. Use `exc_info=True` whenever an exception object is in scope and the failure is unexpected.
- **No new helper module is strictly required**, but introduce one small shared helper to standardize auth-rejection lines and the once-flag idiom:

  **New file `server/app/log.py`:**
  ```python
  import logging
  def once(flagholder, attr, logger, level, msg, *args):
      """Log msg once per process; re-arm via clearing flagholder.attr elsewhere.
      Mirrors event_bus._sub_overflow_warned / push_service._persist_warned."""
  def reason_line(logger, method, path, sub, reason, present):
      logger.warning("auth rejected on %s %s: %s (sub=%r cookie=%s)",
                     method, path, reason, sub, present)
  ```
  This is optional sugar; the established once-flag pattern in `event_bus.py:136-145` is the canonical reference and may simply be copied.

**Context pattern (server):** every line carries `operation` + `reason` + `id(s)` + (where useful) `path`/`db`/`actor`. Example shape:
`events_db.search failed on /data/events.db: database is locked (OperationalError) [camera_id=… before=…]`.

### 1.2 Detection worker (Jetson host, Python 3.6, NOT in container)

This is the #1 systemic finding: **two inconsistent regimes** — `print("[detect] …", flush=True)` in `detect.py`/`recording.py`/`preroll.py`/`tracks.py`, and stdlib `logging` (mostly `log.debug`, silently dropped because `detect.py` never calls `basicConfig`) in the leaf libs (`recognizer.py`, `face_recog/detector.py`, `memory_guard.py`, `thermal_guard.py`, `mediamtx_watchdog.py`).

**Baseline fix — one new module `detection/applog.py` (Py3.6-safe, no f-strings/walrus/PEP-604/annotations):**
```python
import logging, os, sys
def configure():
    logging.basicConfig(
        level=os.getenv("DETECT_LOG_LEVEL", "INFO"),
        format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
        stream=sys.stdout)
def emit(prefix, msg):
    # EPIPE-safe print for the modules that must stay logger-light
    try:
        print("[" + prefix + "] " + msg, flush=True)
    except OSError:
        pass
```

Call `applog.configure()` as the **first line of `main()` in `detect.py`** (before the inference loop / heartbeat threads spawn). Consequences:
- Every existing `log.debug` in `recognizer.py` / `detector.py` now *has a handler* and, once raised to `WARNING` per §2, becomes visible.
- The `[detect]`/`[recording]`/`[preroll]` prints and the stdlib lines now share one timestamped format in journald (`homecam-detect.service`).

**Per-module decision:**
- `recording.py` / `preroll.py` / `tracks.py` were designed "log-free" but that pin is **already broken** (`[recording-merge]` prints exist). Thread `applog.emit("recording", …)` / `emit("preroll", …)` through them. Unit tests mock subprocess and don't need a logger fixture — `emit` is a free function.
- Leaf libs keep stdlib `logging`; **raise the failure-class `log.debug` → `log.warning`** (face_locations/face_encodings/capture-save). These are the exact failures an operator needs and they're currently dropped.
- Use `log.exception()` (available in 3.6, currently unused everywhere) for the merge-thread and face-recog catch-alls so multi-frame stacks survive.

**Levels (detection):** ERROR = pipeline-dead (ffmpeg spawn fail, makedirs fail, atomic-rename fail = clip 404-forever, detectNet load fail, net.Detect CUDA fault, RTSP never-up). WARNING = degraded/self-healing (capacity drop, watchdog restart, concat fallback, sensor-dark). INFO = notable state transitions (gear off↔on, face mode, segment copy shortfall). DEBUG = high-frequency detail.

**New failure-rate counters in `metrics.py`** (surfaced via heartbeat, must be registered in `_internal.py::_ALLOWED_METRIC_FIELDS` — see Guardrails): `clips_dropped_capacity`, `clip_start_failures`, `face_recog_failures`, `event_post_failures`, `thumb_save_failures`. Without these the operator sees individual journal lines but never *rates over time*.

### 1.3 Client (browser, devtools console — operator can't see a phone)

No logger exists today (`sentryCat.ts` is the cat-mascot, not Sentry). Bare `console.error(e)` at 8 sites; everything else swallows or routes to ephemeral toasts.

**New file `client/src/lib/log.ts`:**
```ts
type Fields = Record<string, unknown>
// scope tokens: 'api' | 'ws' | 'webrtc' | 'drawBoxes' | 'push' | 'auth' |
//   'videoTile' | 'clipModal' | 'events' | 'timelapses' | 'notifications' |
//   'detectionSettings' | 'dangerZone' | 'userMgmt' | 'errorBoundary' | 'login'
export const log = {
  error(event: string, fields: Fields = {}) { emit('error', event, fields) },
  warn(event: string, fields: Fields = {})  { emit('warn',  event, fields) },
  info(event: string, fields: Fields = {})  { emit('info',  event, fields) },
  debug(event: string, fields: Fields = {}) { emit('debug', event, fields) },
}
function emit(level, event, fields) {
  if (typeof window === 'undefined') return            // SSR-safe
  console[level === 'debug' ? 'log' : level](`[${event}]`, fields)
  if (level === 'error' || level === 'warn') void ship(level, event, fields) // best-effort
}
// ship(): fire-and-forget POST to /api/client-log (NEVER awaited,
// NEVER throws, swallows its own failure — must not recurse into log.error).
```

**Server sink — route `POST /api/client-log`** (moved out of the authenticated worker router by PR-102 so it still works on the anon login screen). Apply: `extra='forbid'` Pydantic body, a small field-size cap, and the existing global app-level rate cap so a looping client can't flood. Logs at the requested level with a `client_log:` prefix so device-side failures land in the same journald stream as the server.

**Client conventions:**
- Every message states the **express reason**: HTTP status + server detail (`HttpError.status`/`.path`/`detail`), WS `close.code`+`reason`, ICE `gatheringState`+candidate count, `errName:errMessage`. Always include `navigator.onLine` on network-edge failures so "server down" vs "request rejected" vs "client offline" are distinguishable.
- **Centralize at the chokepoints** (`api.ts req()` line 94-104 throw site, `getCachedJSON()` 369-378) so no REST failure is ever fully silent — don't depend on the 4-of-8 callers that swallow.
- **NEVER** log passwords (Login/ChangePassword/AddUser/Reset have them in scope), cookie/token values, or full SDP (private IPs — log candidate counts + `a=candidate` summaries only).
- Log **before** the `cancelled`/unmount guard so an in-flight failure during unmount is still recorded; keep logging in `.then/.catch/.finally` (React 19 `set-state-in-effect` rule).
- Pair every `showToast(msg,'error')` with a `log.*` via a thin `reportError(event, fields, {toast})` helper in `lib/toast.tsx` so the user-message and the structured log can't drift (the inventory's `toast.tsx:72-83` convention note).

---

## 2. Coverage matrix by feature

Checklists grouped by user-facing feature. `[ ]` = add the line; level in **bold**. File:line references are from the inventory.

### Live view (WebRTC/WHEP)
Client transport (`webrtc.ts`) + tile (`VideoTile.tsx`) + control route.
- [ ] **WARN** `webrtc.ts:236-263` — ICE gathering hit 2500ms timeout vs natural complete; log `gatheringState` + candidate count + whether srflx present. *Highest-value single client log — the documented cellular root cause, 100% silent today.*
- [ ] **ERROR** `webrtc.ts:215-223` — WHEP POST non-OK: status + body tail + `404→wrong rung / 503→MediaMTX cold`. (Throws plain `Error`, not `HttpError`.)
- [ ] **ERROR** `webrtc.ts:215-219` — WHEP POST network reject; **AND fix the PC leak** (pc.close only runs in `!res.ok` branch — wrap try/finally).
- [ ] **ERROR** `webrtc.ts:224-225` — `setRemoteDescription(answer)` reject (B-frame/H264-profile on transcode rung); **also fix leak**.
- [ ] **ERROR** `webrtc.ts:209-213` — cold-path `createOffer`/`setLocalDescription` reject (local SDP vs network).
- [ ] **DEBUG** `webrtc.ts:113-124` — warmup swallow (best-effort, but log so an always-failing warmup is visible).
- [ ] **DEBUG** `webrtc.ts:199-203` — `ontrack` fired (breadcrumb so its *absence* is diagnosable).
- [ ] **ERROR** `VideoTile.tsx:256-259` — replace generic `console.error('WHEP connect failed')` with `quality`+`effectiveSrc`+`retryNonce`+structured cause.
- [ ] **WARN** `VideoTile.tsx:172-182,226-229,240-248` — the four silent mid-stream error paths (videoError / 3s stall / 8s media-timeout / pcState failed-disconnected-closed); log `cause` + `connectionState`+`iceConnectionState`. *Most user-visible Live failure class, zero signal today.*
- [ ] **DEBUG** `VideoTile.tsx:392-394,423-431,436-438` — fullscreen/orientation-lock fallbacks.
- [ ] **DEBUG** `control.py:108-112` — `/api/capture` 503 (cause already in `camera.py`; debug breadcrumb only).

### Recording / event clips (Feature #1)
Detection-side recorder is the silent-failure epicenter; server-side serve/retention secondary.
- [ ] **ERROR** `detection/recording.py:283-302` — ffmpeg Popen OSError/FileNotFoundError (the #1 deploy failure: ffmpeg not on host PATH); name `ffmpeg_bin`. *Highest-value missing recorder log.*
- [ ] **ERROR** `detection/recording.py:262-264` — `makedirs(recordings_dir)` OSError (volume unmounted/full/RO).
- [ ] **ERROR** `detection/recording.py:507-511` — cold-start promote rename OSError → clip 404-forever.
- [ ] **ERROR** `detection/recording.py:523-526` — pre-roll-only rename OSError → clip 404-forever.
- [ ] **ERROR** `detection/recording.py:570-582` — normal-merge fallback rename OSError (clip lost entirely) + **WARN** concat-fail-but-fallback-ok (pre-roll silently lost).
- [ ] **WARN** `detection/recording.py:76-89` — `_reap` must inspect `proc.returncode`; non-zero = clip missing/truncated. *Structural fix: the single observation point for clip failures.*
- [ ] **WARN** `detection/recording.py:294-296,283-297` — redirect post-roll stderr to a bounded per-event temp file (NOT PIPE — deadlock pin), log stderr tail on rc!=0 at reap, then unlink.
- [ ] **WARN** `detection/recording.py:247-253` (+ caller `detect.py:1570-1574`) — capacity-cap drop (`in_flight/max`); **detect.py must log the `False` return** (it only catches exceptions today).
- [ ] **WARN** `detection/recording.py:219-220` — malformed event_id (caller-side, worker id-gen bug).
- [ ] **WARN** `detection/recording.py:397-404` — post-roll `wait(120s)` timeout → force-kill (RTSP/MediaMTX stall).
- [ ] **WARN** `detection/recording.py:138-139` — distinguish "all segments dropped because ffprobe missing" from normal in-flight-moov drops.
- [ ] **WARN** `detection/recording.py:357-362` — scratch-dir create fail → live-ring fallback re-exposes iter-356.51 frame-corruption race.
- [ ] **INFO** `detection/recording.py:347-356` — per-segment copy shortfall (`copied/requested`).
- [ ] **WARN** `detection/recording.py:517-521` — pre-roll-only concat False.
- [ ] **DEBUG** `detection/recording.py:609-614` — scratch cleanup incomplete (slow disk leak).
- [ ] **ERROR** `detection/preroll.py:129-146` — segment-recorder spawn fail (ffmpeg missing / dir / RTSP-down) — caller `detect.py:854` only says "failed to start" with no reason.
- [ ] **WARN** `detection/preroll.py:176-191` — watchdog restart w/ consecutive-restart counter (flapping = RTSP/MediaMTX down).
- [ ] **WARN** `detection/preroll.py:287-298` — ring-resize restart `start()` False → buffer DOWN at larger size (return value ignored today).
- [ ] **WARN** `detection/preroll.py:209-221` — stop() escalated to SIGKILL / zombie holding RTSP.
- [ ] **WARN** `detection/preroll.py:313-316` — `segments_in_window` listdir OSError (buffer dir unmounted).
- [ ] **WARN** `detection/preroll.py:391-392` — `run_concat`: switch to `stderr=PIPE` (deadlock-safe: `subprocess.run` drains + timeout bounds), return/log rc + stderr tail; distinguish timeout vs OSError vs rc!=0.
- [ ] **ERROR** `detection/preroll.py:344-347` — `write_concat_list` OSError (no try/except today; propagates into silent merge catch).
- [ ] **WARN** `detection/tracks.py:127-138` — sidecar `write_sidecar` returns False on OSError without raising → caller's try never fires; log the False return (clip degrades to static overlay).
- [ ] **WARN** `detection/tracks.py:109-110` — event_id charset reject (worker/server drift → /tracks 404).
- [ ] **INFO** `clips.py:79-92` — clip 404 (recorder absent vs swept).
- [ ] **DEBUG** `clips.py:106-116` — tracks sidecar 404 (legacy clip).
- [ ] **WARN** `recording_service.py:110-120` — `delete_clip` unlink OSError (clip lingers despite event delete); distinguish FileNotFound (debug) from other OSError (warning).
- [ ] **WARN** `recording_service.py:142-149` — sweep retention preset lookup fell back to env default (user's Settings choice ignored).
- [ ] **WARN** `recording_service.py:192-193` — augment existing to note `deleted` count at failure.
- [ ] **DEBUG** `recording_service.py:97-109` — malformed event_id from internal caller.
- [ ] **WARN** `ClipModal.tsx:209-213(tracks),422/483(media)` — non-404 tracks fetch fail; clip+thumb both failing = systematic. **ERROR** `ClipModal.tsx:128-137` export fail (status discarded today). **WARN** `:162-167` share/clipboard fail. **DEBUG** `:99-103` iOS autoplay reject.

### Export ZIP
- [ ] **WARN** `clips.py:172-177` — `zf.write` OSError (clip swept mid-export, silently skipped).
- [ ] **WARN/INFO** `clips.py:196-198` — thumb path-escape ValueError (security) vs missing-on-disk (benign), both swallowed.
- [ ] **INFO** `clips.py:241-248` — 0 events resolved from N requested ids (add module logger); **ERROR** wrap `get_by_ids` DB exception.
- [ ] **ERROR** `clips.py:254-259` — stored event id fails charset re-validation = data-integrity alarm.
- [ ] **WARN/EXCEPTION** `clips.py:263-264` — semaphore both slots busy (queued) + wrap `to_thread` build in try/except.
- [ ] **ERROR** `api.ts:414-426,408-413` — export non-OK (413 over-cap / 503 semaphore) + unguarded `res.blob()` mid-stream drop.
- [ ] **ERROR** `api.ts:494-503` — training export (422 kind/size, 413 >5000, 401 non-owner) + unguarded blob.
- [ ] **ERROR** `training.py:44-65` — add logger; wrap `build_export_zip` (`log.exception` kind/size/root); 413 truncation; success audit (biometric export).
- [ ] **DEBUG** `training_export.py:111-114` — orphaned JPEG (no sidecar).
- [ ] **WARN** `training_export.py:163-171` — **add `ValueError` to the except tuple** — `letterbox()` zero-dim raises ValueError, currently uncaught → 500s the whole ZIP.

### Daily timelapse
- [ ] **ERROR** `timelapse.py:234-237` — concat-list temp create/write OSError (`timelapses_dir` full/unwritable) → bare 500 today.
- [ ] **WARN** `timelapse.py:201-209` — keep existing build() warning incl. stderr tail; add explicit FileNotFound→"ffmpeg not in container".
- [ ] **DEBUG** `timelapse.py:263-267` — leaked concat-list temp.
- [ ] **DEBUG** `timelapse.py:126-131` — per-clip skip reason (pruned vs malformed vs traversal); once-per-build summary count.
- [ ] **WARN** `control.py:399-438` — list timelapses: dir-missing vs iterdir OSError.
- [ ] **WARN/ERROR** `control.py:462-483` — delete: 400 path-escape (impossible-so-alarm) + unlink OSError.
- [ ] **WARN** `main.py:634-666` — timelapse file serve 404: regex / traversal / missing-on-disk (missing = iter-306 builder never produced MP4).
- [ ] **WARN** `TimelapsesSection.tsx:82-85(list),107-117(build),148-151(delete),301-308(playback)` — list-fail hides existing; build-fail no date/status; **the `<video>` has NO `onError`** — add one.

### Detection / events (Feature #6)
- [ ] **ERROR** `events.py:107-126,165-185,350-365` — wrap `to_thread` search/count_by_day/people; `log.exception` with all filter params.
- [ ] **WARN** `events.py:222-232` — mark_seen 422 (client/worker id drift).
- [ ] **INFO/EXCEPTION** `events.py:257-303` — delete one / delete-by-day audit (actor + count) + DB-fail wrap. *Destructive owner-only, no audit today.*
- [ ] **ERROR** `events_db.py:189-692` — **shared `_connect` context manager** (or per-helper wrap) that catches+re-raises with `op + db path + key args` at error, `exc_info`; covers search/count_by_day/mark_seen/delete/get_by_ids/people_summary. *people_summary window-fn (SQLite ≥3.25) is a silent landmine.*
- [ ] **WARN** `events_db.py:226-234` — unparseable `boxes_json` (event renders zero boxes); once-per-N.
- [ ] **DEBUG** `events_db.py:247-261` — unparseable `person_names_json` (multi→single degrade).
- [ ] **WARN** `events_db.py:162-165` — `chmod 0o600` OSError (privacy: DB world-readable).
- [ ] **WARN(reference)** `event_bus.py:122-145` — already correct once-flag; cite as the model.
- [ ] **WARN** `event_bus.py:147-173` — add event id + db path to persist-fail; re-log every 60s under sustained failure instead of full suppression.
- [ ] **WARN** `event_bus.py:185-196` — `recent()` add path + limit; rate-limit (floods on every poll today).
- [ ] **WARN** `event_bus.py:136-145` — add subscriber index to overflow line.
- [ ] **ERROR** `_internal.py:399-410` (success **DEBUG** only — hot path); **DEBUG** `:363-380` heartbeat coercion drops (once-flag); **DEBUG** `:396-397` event dropped while paused.
- [ ] Worker-side: **ERROR** `detect.py:245-255` event POST fail (event LOST, no retry — distinguish transient-network vs permanent-422-schema-drift; add `event_post_failures` counter). **WARN** `detect.py:389-393,335-344` config poll + per-field cast (one bad field discards whole update). **ERROR/WARN** `detect.py:433-461` heartbeat stale-skip (loop wedged) + POST fail. **INFO** `detect.py:1124-1156` gear transitions (off/scheduled-off/low-memory/thermal) — *the "healthy but zero events" footgun*. **WARN** `detect.py:1184-1197` empty wanted-class set; **INFO** `:1257-1259` zone-gate suppression (throttled). **WARN** face-recog batch/per-person `detect.py:1342-1343,1487-1501`; raise `recognizer.py:131-136,166-170,207-219` and `detector.py:124-138` **debug→WARN**. **ERROR** `detect.py:869-872` detectNet load (no try today) + `:1166-1174` net.Detect CUDA fault. **ERROR** `box_norm.py:37-38` non-positive dims crashing the loop. **ERROR/WARN** import-disable sites `detect.py:68-71,803-817,856-858,936-943`.
- [ ] Client: **ERROR** `Events.tsx:255-258/293-298/330-332/451-455` load fails (op name); **ERROR** `:513-517` loadMore `catch{}` (pagination silently stops = looks like end-of-history); **ERROR** `:614-740` bulk delete/export per-id reasons; **WARN** `:344-353,550-555` mark-seen drift; **WARN/ERROR** `drawBoxes.ts:23-28` degenerate dims.
- [ ] **WARN** `ws.ts:46-75` close 1008 reason discarded (origin vs auth) + reconnect storm (code/attempt/delay); **WARN** `:74` error-event swallowed; **WARN/ERROR** `:38-45` parse error w/ raw sample; **ERROR** `:32` constructor throw; **DEBUG** `:124-133` resume no-op.

### Push notifications (Feature #4)
- [ ] **ERROR** `push.py:96-101` — VAPID key requested but none loaded (push fundamentally dead).
- [ ] **WARN** `push.py:119-142` — unsubscribe owner-mismatch (the iter-356.x A2 attack, silent).
- [ ] **DEBUG** `push.py:104-116,173-190`; **INFO** `push.py:262-272` test-push summary; **ERROR** `push.py:232-259` known_filter_options full-scan fail.
- [ ] **WARN** `push_service.py:435-438` — add endpoint host + distinguish 404/410-prune vs 401/403-VAPID-misconfig vs 429.
- [ ] **INFO** `push_service.py:463-477` — dead-sub prune audit (subs vanish silently today).
- [ ] **WARN** `push_service.py:439-457` — transient: add host + escalate-once when ALL fail same exc type (PEM regression looks "transient" forever).
- [ ] **INFO** `push_service.py:405-409` — no-key skip: rate-limited INFO (DEBUG invisible at INFO default).
- [ ] **WARN** `push_service.py:239-262,264-287` — preserve corrupt `push_subs.json` as `.corrupt`; temp cleanup.
- [ ] **ERROR** `_internal.py:517-524` add event id; **ERROR** `:417-419` `add_done_callback` must check `task.exception()`.
- [ ] **ERROR** `push.ts:28-46` enable-chain per-step reason; **WARN** `push.ts:67-71` add endpoint tail; **ERROR** `NotificationsSection.tsx:189-194` toggle direction; **WARN** `:159-170` filter-load 5xx masquerading as empty (re-save wipes real filters); **ERROR** `:214-244` test/save.

### Auth / RBAC
*Tailnet exposure makes auth-rejection a security requirement → all auth-fail at WARNING (survives prod WARNING level).*
- [ ] **WARN** `dependencies.py:80-92` — strict gate: reason ∈ {no cookie, invalid/expired (incl. exc text), malformed sub, user-row-gone (deleted-while-live = security event)}.
- [ ] **WARN** `dependencies.py:118-140` — role resolution fell back to claim/admin (silent privilege escalation today).
- [ ] **WARN** `dependencies.py:175-182` — RBAC 403 deny: user/role/required (household audit trail).
- [ ] **DEBUG** `dependencies.py:30-55` — optional-auth resolved anon despite present cookie (skip the normal no-cookie case).
- [ ] **DEBUG/WARN** `tokens.py:115-121` — decode chokepoint: DEBUG the InvalidTokenError type (expired vs bad-sig vs malformed), **WARN** the kind-mismatch branch (anomalous, the load-bearing PyJWT edge case).
- [ ] **WARN/INFO** `auth.py:130-138` login fail/ok; `:156-172` refresh reject reasons; `:213-222` change_password; `:240-244` admin reset audit; `:310-335` create (incl. **ERROR** on the re-raised non-UNIQUE IntegrityError); `:361-383` delete audit + last-owner near-miss; `:386-404` /me **DEBUG** (high-freq self-heal); `:292` **ERROR** list_users DB fail.
- [ ] **INFO/WARN** WS gates `events.py:380-389` (split origin: present-but-mismatch=WARN vs missing=INFO) + **WARN** `:396-418` all four auth branches (silent today while origin gate logs — asymmetric).
- [ ] **ERROR** `jwt_secret.py:58-112` — augment existing gold-standard warnings with "— ALL active sessions invalidated" consequence.
- [ ] **ERROR** `bootstrap.py:40-89` — wrap the seed DB ops (init_db/count_users/create_user) — bare traceback on boot today.
- [ ] Client: **WARN** `auth.tsx:83-96` /me non-401 masquerading as anon; **INFO** `:130-137` self-heal result, `:151-163` session-expired; **WARN** `:180-189` logout server-call fail (cookie not invalidated); **WARN** `Login.tsx:68-80` failed sign-in (username+status, NEVER password); **WARN** `UserMgmt.tsx:68-487` generic-fallback branches + list-load.

### OTA / Settings / Maintenance
- [ ] **WARN** `control.py:222-246` restore path-traversal reject (security, owner-authed-but-compromised).
- [ ] **WARN** `control.py:354-384` list backups: dir-missing vs iterdir OSError (silent empty dropdown = misconfig).
- [ ] **INFO/ERROR** `control.py:141-147` detection config patch audit + persist-fail (store warns but route returns 200).
- [ ] Face/privacy: **ERROR** `face.py:432-491` move (mkdir/rename OSError, swallowed sidecar); `:498-527` delete; `:582-640` bootstrap write; **WARN** `face.py:116-151` captures iterdir OSError; **DEBUG** `:168-205,322-369,382-389` sidecar/crop 404+traversal probes. **INFO** `training_admin.py:110-137` purge audit (GDPR), `:182-229` consent grant/revoke audit + mkdir/path-escape, **WARN** `:236-274` corrupt consent.json (legal-record tamper).
- [ ] **ERROR** `DangerZone.tsx:77-264` op fails (reboot/backup/update/restore/listBackups) — highest-consequence ops, toast-only today; **ERROR** `DetectionSection.tsx:61-79` save-fail patch keys/status; **DEBUG** `AccountSection.tsx:51-54` version fetch.

### App shell / startup / probes / WebSocket / static
- [ ] **ERROR** `main.py:60-96` — wrap each lifespan step (mkdir-snapshots / seed / init-events-db / camera-start / detection-start) with named error before re-raise; guard each `stop()` in finally; `log.info("server shutting down")`. *Single most important boot diagnostic.*
- [ ] **WARN** `main.py:123-151` body-cap rejections (chunked 411 / oversize 413 / unparseable CL pass-through) — client IP + path + CL value.
- [ ] **WARN/DEBUG** `main.py:536-560,584-619,634-666,676-687` static/SPA/thumb 404s — split regex / path-traversal (security) / missing-on-disk; thumb-missing re-opens iter-334 push-hero bug.
- [ ] **WARN/INFO** `main.py:668-671` — SPA bundle not mounted (UI 404s, clean boot).
- [ ] **DEBUG + WARN** `main.py:364-496` — host-probe family logs once-on-transition-to-None; **`_disk_free_gb` at WARNING** (dark disk probe hides disk-full that breaks recorder).
- [ ] **ERROR** `main.py:233-308` — `/api/status` probe aggregation wrap (once-flag — 5s poll); **ERROR** `main.py:190-230` — security-headers middleware try/except around `call_next` so no 500 is fully silent.
- [ ] **DEBUG** `metrics_prom.py:40-58` — *no log* (per-scrape; dark-probe visibility belongs at the probe layer).
- [ ] **WARN** `events.py:425-451` — capacity gate add count/cap/client; stream-loop crash add sub+client.

### Client transport core (cross-feature)
- [ ] **ERROR** `api.ts:94-103` non-2xx HttpError central log (method/path/status/detail); **ERROR** `:84` network-level fetch reject (TypeError, no `.status` — falls through every caller branch); **DEBUG** `:97-101` body-read fail; **DEBUG** `:89-93` 401 retry-after-refresh; same set for `getCachedJSON` `:358-378`; **DEBUG** `:366-368` 304 stale-cache; **ERROR** `:104,134,379,390,607` JSON-parse fail (SPA index served where JSON expected); **WARN** `:61-63` refresh network-fail, **INFO** `:57-59` session-expired-via-401, **ERROR** `bootstrapFace:589-608` (bypasses central refresh; 1MB body-cap 413).
- [ ] **ERROR** `ErrorBoundary.tsx:49-54` — region label + componentStack + route (today dev-console-only, lost in prod).

---

## 3. Prioritized rollout

### P0 — currently-silent failures on critical paths (data loss / pipeline-dead)
Files: `detection/recording.py`, `detection/preroll.py`, `detection/detect.py`, `detection/applog.py` (new), `server/app/main.py` (lifespan + level knob), `server/app/services/events_db.py`, `server/app/services/event_bus.py`, `client/src/lib/log.ts` (new), `client/src/lib/api.ts`, `server/app/routes/_internal.py` (client_log sink).

1. Add `detection/applog.py` + `applog.configure()` in `detect.py main()`; raise face-recog leaf `debug→warning`.
2. Recorder: `_reap` returncode inspection (recording.py:76-89), all atomic-rename OSErrors → ERROR (507/523/570), ffmpeg-spawn + makedirs ERROR (283/262), capacity-drop caller log (detect.py:1570), bounded-stderr-temp tail. preroll: spawn (129), `run_concat` PIPE switch (391), `write_concat_list` guard (344), watchdog counter (176).
3. Worker: event-POST fail ERROR + `event_post_failures` counter (detect.py:245); detectNet load + net.Detect + box_norm guards (869/1166/box_norm:37).
4. Server: lifespan step-wrap + `HOMECAM_LOG_LEVEL` knob (main.py:22,60); `events_db` shared `_connect` wrap; `event_bus` persist add-id + 60s re-log.
5. Client: `lib/log.ts` + `/api/client-log` sink; centralize `api.ts` req/getCachedJSON throw + network-reject; ErrorBoundary durable capture; webrtc PC-leak fix + ICE-timeout WARN + WHEP status.

### P1 — degraded / empty-result masking (looks-healthy-but-broken)
Files: `server/app/services/recording_service.py`, `timelapse.py`, `push_service.py`, `face_capture_sweeper.py`, `training_export.py`; `server/app/routes/events.py`, `clips.py`, `control.py`, `push.py`, `face.py`, `training.py`, `training_admin.py`; worker gear-transition + zone-gate + empty-class logs; client `Events.tsx`, `TimelapsesSection.tsx`, `NotificationsSection.tsx`, `auth.tsx`.

1. Worker gear transitions (detect.py:1124-1156) + zone/empty-class (1184/1257) — kills the "healthy but zero events" support load.
2. Retention/sweep fallback warnings (recording_service:142, face_capture_sweeper:45); `training_export` ValueError-in-except fix (163).
3. Route `to_thread` DB wraps (events:107/165/350); export 0-resolved + charset-alarm (clips:241/254); push dead-sub prune + VAPID-down (push_service:463, push:96).
4. Client empty-vs-error disambiguation: Events loadMore/load, Timelapses list+video onError, Notifications filter-load 5xx, auth /me non-401.

### P2 — auth/RBAC audit, client surfacing, debug breadcrumbs
Files: `server/app/auth/*`, `server/app/routes/auth.py`, `events.py` WS gates, `main.py` static/probe/middleware; client `Login.tsx`, `UserMgmt.tsx`, `DangerZone.tsx`, `DetectionSection.tsx`, `ClipModal.tsx`, `VideoTile.tsx`, `ws.ts`, `drawBoxes.ts`, `push.ts`; `lib/toast.tsx` `reportError` helper.

1. Auth-reason lines (dependencies / tokens / auth.py / WS auth gate) — all WARNING.
2. Static-route 404 split + body-cap + probe-dark + middleware catch-log (main.py).
3. Client `reportError` helper; pair every error-toast; ws close/error/parse; VideoTile mid-stream causes; debug breadcrumbs (304, autoplay, fullscreen, drawBoxes dims).

---

## 4. Guardrails

**Never log:** passwords (Login/ChangePassword/AddUser/Reset + server `auth.py` bodies — log username/role/status only), JWT/cookie/token bytes, full request bodies, full SDP (private IPs — log candidate counts + `a=candidate` summaries). Event payloads may contain `person_name` + thumb URLs (PII) — fine in server logs (already in the DB) but the `events.db` `chmod 0o600` line must itself flag privacy. Detection-config patch: log **keys** not values (zone geometry).

**Volume / noise control:**
- Honor `_SuppressNoisyAccess` (main.py:25-54) — do NOT add per-request logging on `/api/status` (5s poll), `/api/_internal/heartbeat` (10s), `/api/detection/config` (30s). These stay DEBUG or once-flag. Re-churning them defeats the SD-card-write reduction.
- Hot paths use the **once-flag idiom** (`event_bus._sub_overflow_warned`, `push_service._persist_warned`) — reuse it. Worker `detect.py` already does this for heartbeat-skip, latest.jpg, config-poll; extend to gear transitions (log on *transition*, not per-frame) and zone-gate (throttle).
- No per-frame logging in the inference loop. Failure-rate **counters in metrics.py** carry the rate; journal lines carry the *first* occurrence + transitions.
- Worker config-poll "warned-once" should re-arm so a *persistent* server regression isn't a single line then silence (inventory note at detect.py:389).
- `metrics_prom.py::_line` and `/api/status` per-request stay silent — dark-probe visibility lives at the probe functions (once-on-transition-to-None).

**CLAUDE.md pin interactions:**
- **DEVNULL → bounded temp file, not PIPE.** recording.py post-roll stderr and preroll `run_concat`: the deadlock pin forbids blind PIPE on the *async long-lived* post-roll; use a bounded per-event temp file there. `run_concat` is a **synchronous `subprocess.run` with a timeout** — PIPE is deadlock-safe (run drains it) and explicitly allowed (the iter-350 DEVNULL was over-cautious for the bounded case). Pin the distinction in tests.
- **Metric whitelist:** new heartbeat counters (`clips_dropped_capacity`, `face_recog_failures`, etc.) MUST be added to `_internal.py::_ALLOWED_METRIC_FIELDS` or they're silently dropped server-side (the exact gap at detect.py:455-461).
- **Worker `_internal` routes use a direct-peer bearer credential** — PR-102 moved the anonymous diagnostic sink to `/api/client-log`. Keep its `extra='forbid'` + size cap + global rate cap while keeping it outside the worker trust surface.
- **Py3.6 AST scanner** (`tests/test_py36_compat.py`) over `detection/*.py`: `applog.py` and all new worker lines must use `.format()`/`%`, no f-strings/walrus/PEP-604/PEP-585/annotations. `log.exception()` is 3.6-safe and encouraged.
- **`text-white` / theme pins** — irrelevant to logging; no client UI copy changes beyond `reportError` plumbing.

---

## 5. Test impact

**Existing tests that may break / need updates:**
- `client/src/lib/api.test.ts` + `server/tests/test_*.py` pin wire shape — the `/api/client-log` route must not change existing payloads. The body-cap/security-header middleware tests (main.py:123-230) assert response shape; adding a `call_next` try/except must re-raise so the 500 path is unchanged.
- `push_service` tests set `private_pem=b"fake-pem"` and mock `pywebpush.webpush` — new `send_one` log lines must NOT assume a real response object (use `urlparse(endpoint).netloc`, `code`, `msg[:200]` only).
- `recording.py`/`preroll.py` unit tests mock subprocess — adding `applog.emit` prints is fine, but any assert-on-stdout test needs the new line shapes. `run_concat` switching DEVNULL→PIPE changes the mocked `subprocess.run` call kwargs — update those mocks.
- `tests/test_py36_compat.py` AST scanner will reject any f-string/walrus in `applog.py` or new worker lines — run it as the gate.
- `test_mediamtx_adaptive_paths.py`, recorder `test_*_real_ffmpeg_*` — unaffected (no muxer/encode change), but the stderr-temp-file write adds a path; confirm the real-ffmpeg tests still find the final clip.

**New tests to pin (behavioral contracts):**
1. **`_reap` logs stderr tail on rc!=0** — feed a Popen mock with `returncode=1` + a temp stderr file; assert `[recording]` line contains `rc=1` + tail (recording.py:76-89,294-296).
2. **Atomic-rename OSError → ERROR with `event_id`** — patch `os.rename` to raise; assert the "Clip lost / 404" ERROR fires for all three rename sites (507/523/570).
3. **ffmpeg-missing → ERROR naming `ffmpeg_bin`** — patch Popen `FileNotFoundError`; assert ERROR (recording.py:283, preroll.py:129).
4. **`run_concat` captures PIPE + returns reason** — assert `subprocess.run` called with `stderr=PIPE` and a non-zero rc yields a logged tail (preroll.py:391) — *and* a Py3.6-compat assertion.
5. **events_db wrap re-raises but logs op+path** — patch `_connect` to raise `OperationalError`; assert ERROR line names the op + db path AND the original exception still propagates (route still 500s).
6. **event_bus persist re-log every 60s** — simulate sustained failure across a fake clock; assert it doesn't fully suppress after the first line (event_bus.py:147).
7. **Auth-reason lines at WARNING** — `client_anon` hitting a gated route asserts the `auth rejected … reason=…` WARNING with the right reason token; kind-mismatch token asserts the WARN branch (dependencies.py:80, tokens.py:119). Assert **no password/token bytes** appear in any captured log (negative test using `caplog`).
8. **WS auth gate logs all four branches** (events.py:396-418) — parallel to the origin gate test.
9. **lifespan step-wrap** — patch `events_init_db` to raise; assert the named ERROR fires before propagation (main.py:82).
10. **Client: `api.ts` central log fires once per failure** — mock fetch non-2xx + network-reject; assert `log.error` called with `{path,status}` / network fields; assert `bootstrapFace` 413 logs. Assert `Login.tsx` failed-submit logs username but a `caplog`/spy confirms the password var is absent.
11. **Client: WHEP PC not leaked** — mock fetch reject on `connectWhep`; assert `pc.close()` was called (regression for the try/finally fix) + the ERROR line.
12. **`/api/client-log` sink** — anon POST accepted (no auth), `extra='forbid'` rejects unknown fields, oversize body capped, rate-limit returns without flooding the server log.
13. **`training_export` ValueError caught** — feed a zero-dim image; assert it's skipped+logged, not a 500 (training_export.py:163).

---

Files referenced are absolute under `/media/israel/Drive/Projects/Android/HomeCameraSystem/`. The client diagnostic route now lives at `POST /api/client-log` in `server/app/routes/client_log.py`; PR-102 removed its old worker-router path. The single highest-leverage logging change remains `detection/applog.py` + `applog.configure()` (un-drops the entire face-recog leaf-log layer) paired with the `_reap` returncode inspection (the structural reason clip failures are invisible today).
