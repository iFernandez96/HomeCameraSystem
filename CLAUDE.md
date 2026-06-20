# CLAUDE.md

Self-hosted Ring-style camera. Jetson Nano 2GB is the **server** (camera attached); phones/laptops are **clients** running the same installable PWA.

## Layout

- `client/` — Vite + React 19 + TS + Tailwind v4 PWA. Light calico-cream theme, cat brand identity (Panther / Mushu / Coco). Vitest + Testing Library + jsdom; ESLint flat.
- `server/` — FastAPI in Docker. JetPack ships Python 3.6, FastAPI wants 3.8+, hence the container. REST + WebSocket events + Web Push. pytest + TestClient.
- `detection/` — **Python 3.6** worker on the Jetson host (NOT in the container — needs libargus / TensorRT / NVDEC). Reads RTSP from MediaMTX via jetson-utils, runs SSD-MobileNet-v2 (TensorRT FP16), POSTs to `/api/_internal/event`.
- `deploy/` — Dockerfile + compose + `mediamtx.yml` + systemd units (`mediamtx`, `homecam-server`, `homecam-detect`).

Pipeline: camera → MediaMTX (`nvarguscamerasrc → nvv4l2h264enc → rtspclientsink`) → detection re-decodes via NVDEC. Browser pulls WebRTC from MediaMTX.

## Commands

```bash
# Dev
npm run dev | npm test | npm run typecheck | npm run lint     # in client/
/tmp/homecam-venv/bin/python -m pytest                        # server / detection (venv lives in /tmp — exFAT)

# Deploy client
cd client && npm run build && rsync -a --delete dist/ jetson:/home/israel/HomeCameraSystem/client/dist/

# Deploy server — CROSS-BUILD on the x86 dev machine, ship the ARM64 image (the norm).
# NEVER `up --build` natively on the Jetson: it recompiles cryptography/Pillow/argon2
# from source on the Nano 2GB → 30-45 min + wedges the live server. Cross-build uses
# prebuilt aarch64 wheels → a few min on the laptop, ~0 load on the Nano.
deploy/cross-deploy-server.sh            # one-time setup: docker run --privileged --rm tonistiigi/binfmt --install arm64

# Deploy detection
rsync detection/ jetson:.../detection/ && ssh jetson 'sudo systemctl restart homecam-detect'
```

`ssh jetson` (key auth, NOPASSWD sudo). Tailscale URL `https://homecam.tail4a6525.ts.net`.

## Repo lives on exFAT

No symlinks → `python -m venv` breaks (workaround: `/tmp/homecam-venv`). No `node_modules/.bin` shims → `package.json` scripts call binaries via direct node paths; `npx` won't find them.

## Conventions

- Client API → `client/src/lib/api.ts` (REST throws `HttpError` on non-2xx; branch on `err.status`, not message). WebSocket → `lib/ws.ts`. WebRTC → `lib/webrtc.ts`. Bbox-draw helper → `lib/drawBoxes.ts` (live tile + clip modal share it).
- Server routes → `server/app/routes/`. Long-running work → `server/app/services/`.
- Event payloads versioned: `{"v": 1, "type": "...", ...}`. Times are unix epoch seconds.
- Worker heartbeat metric whitelist: `_internal.py::_ALLOWED_METRIC_FIELDS`. Unregistered metrics are silently dropped.
- New tests use BDD-lite naming (`Given/When/Then`) + `// arrange / act / assert` body blocks. Existing tests migrate on touch.
- Lib tests pin wire shape — change a server route, expect to update `client/src/lib/api.test.ts` AND `server/tests/test_*.py`.
- Prefer `getByRole` / `getByLabelText` over `getByText`. `eslint-plugin-jsx-a11y` enforces accessible names.
- **Logging** (see `docs/logging_plan.md`): every failure path logs WHY (operation + express reason + ids), never a bare swallow. Three tiers: server uses `logging.getLogger(__name__)` + `%s` lazy interp (NEVER f-strings — defeats level-gating); helpers in `server/app/log.py` (`auth_rejected`, `RateLimitedLog`). Detection worker calls `applog.configure()` first in `main()`; leaf libs use stdlib `logging`, hot-loop modules use `applog.emit("tag", msg)` (EPIPE-safe). Client uses `lib/log.ts` (`log.error/warn/info/debug` + `errFields`); error-toasts pair with `useReportError(event, msg, fields)` from `lib/toast`. Levels flip via `HOMECAM_LOG_LEVEL` (server) / `DETECT_LOG_LEVEL` (worker). Guardrails: NEVER log passwords, token/cookie bytes, full request bodies, or full SDP (log candidate counts). Honor the once-flag / `RateLimitedLog` idiom on hot paths — no per-frame logging.

## Don't reintroduce

### Theme
- Tailwind v4 CSS-vars need `var()`: `bg-[--color-x]` lints clean but renders nothing. Use `bg-[var(--color-x)]`.
- Light calico theme is baseline. No `bg-neutral-9XX`, `border-neutral-8XX`, `text-blue-XXX`. EXCEPTION: `text-white` on colored fills (primary button, danger/success toasts).
- Cat brand identity (Panther / Mushu / Coco) is load-bearing at runtime — SideNav, Login, ambient `CatLayer`, `CatEmptyState`, paw-mask active-nav. Cat-themed copy is also pinned by EventList/Events tests.
- `CatLayer`: `dt` clamp 33ms, NO CSS `transition` on per-frame `transform` (collapses with React state updates → "teleport"). Keep `willChange: transform`.
- `<CatEmptyState>` is the only empty-state primitive. Don't render plain-text empty states.

### Client wiring
- WHEP config: `ICE_SERVERS` in `lib/webrtc.ts` = STUN (`stun.l.google.com:19302`) + optional TURN from `VITE_TURN_*` (iter cellular-ice, 2026-06-17). Single recv-only video transceiver (no audio). STUN was added because on CELLULAR the in-browser WebRTC media socket does NOT route through the Tailscale tunnel (only the WHEP control plane does) — host candidates (LAN / Tailscale IP) are unreachable, so both peers need a server-reflexive candidate to hole-punch over the public internet. MediaMTX mirrors this via `webrtcICEServers2` in `mediamtx.yml`, and also offers ICE-TCP (`webrtcLocalTCPAddress`). The ICE-gathering wait in `webrtc.ts` was raised 250ms→2500ms so the STUN srflx candidate is gathered before the WHEP POST. Tradeoff vs the old `iceServers: []`: slightly slower first frame on LAN. Pinned by `webrtc.test.ts`.
- WHEP ICE gathering (`lib/webrtc.ts`): 250ms LAN-fast fallback uses a `done` flag so it can't resolve after natural completion.
- WHEP `connectionstatechange` (`VideoTile.tsx`) flips to error on failed/disconnected/closed. Manual Retry only — no auto-retry (would tight-loop on outage).
- Three visibility-aware listeners close the mobile-resume gap; don't rip any out: `useStatus.ts` (status polling), `Events.tsx` (refetch on visible), `ConnectionBanner.tsx` (cancels WS backoff).
- WS close-1008 has NO auto-retry. Used by both origin-gate and auth-gate. Dispatches window `homecam:auth-failed` so AuthProvider can self-heal.
- Two distinct window auth signals: `homecam:auth-failed` (re-checks `/me`) vs `homecam:session-expired` (toasts + flips anon). Don't merge.
- React 19 `react-hooks/set-state-in-effect`: synchronous setState in `useEffect` body trips the rule. Inline fetch with `cancelled` flag, setX in `.then`/`.catch`/`.finally`.

### Server wiring
- SPA path-traversal guard (`main.py`): `Path.resolve()` + `relative_to(_CLIENT_ROOT)` blocks `GET /%2E%2E/etc/passwd`.
- Three middlewares (registration order = response stack since `add_middleware` does `insert(0, …)`): 1MB body cap, security headers on every response inc. 4xx, GZip with `minimum_size=1000`. Don't reorder.
- `extra='forbid'` on Box/DetectionPayload (`_internal.py`). Boxes [1, 32], coords [0, 1]. `model_validator` rejects geometry off-frame.
- Heartbeat metric coercion (`_internal.py::_coerce_metric`): bool excluded from numeric path (Python `isinstance(True, int)` quirk), NaN/±Inf rejected, `gear` ≤32 chars, `face_recog_names` ≤50 entries × ≤64 chars.
- `/api/_internal/*` is never auth-gated. Worker posts events without auth. Don't add `dependencies=[...]` on the `_internal.router` include.
- `/api/_internal/detection/config` mirrors the user-facing GET unauthenticated for worker config-poll. Keep BOTH routes.
- `/metrics` and `/healthz` live at root, not `/api/*`. Scrapers/probes don't speak cookies.
- WebSocket Origin gate: full `urlparse(origin).netloc` equality, close 1008 BEFORE `ws.accept()` on mismatch.
- Auth `kind` claim is load-bearing (`tokens.decode`). PyJWT considers a kind-mismatched token "valid" — `decode` re-checks and raises. Pin: `test_decode_rejects_kind_mismatch_*`.
- Default-authed `client` test fixture auto-logs in. Tests pinning 401-on-anon must use `client_anon`. Pin: `tests/test_auth_gating.py`.
- `users.db` mode 0o600 pre-create via `os.open(..., 0o600)` BEFORE `sqlite3.connect`.
- `event_bus` ↔ `events_db` circular import: bus lazy-imports inside function bodies. Don't hoist.
- `/api/events/search`: cursor `before_ts` is strict `<`; empty-string filter matches NO rows; `next_cursor: null` on last page.
- `face_unrecognized` + `person_name=…` are mutually exclusive → SQL composes to 0 rows. Sentinel of "you confused yourself," NOT 422.
- Daily timelapse (`services/timelapse.py` + `routes/control.py`, the "Build video" / "stitch all captures" feature). Hard-won invariants — don't regress:
  - `build()` MUST `_clip_has_video()`-validate (ffprobe) EVERY input clip AND the stitched output. `ffmpeg -f concat -c copy` returns rc=0 while SILENTLY dropping a 0-byte/truncated/moov-less clip AND every clip after it → a reel missing most captures while reporting success. Pre-filter skips bad inputs (WARN, names the event); post-validate refuses `ok=True` on a non-playable output.
  - Build writes to a `<day>.mp4.tmp` sidecar (needs `-f mp4`, can't muxer-infer `.tmp`) then ATOMIC `os.replace` → final, so the GET route never serves a partial; cleanup `.tmp` on every failure path. ffmpeg timeout SCALES with total input BYTES (`_ffmpeg_timeout_for(clip_count, total_bytes)`, ~300 s/GB, 120 s–30 min) — NOT clip count. The count-only formula (`2.5 s/clip`) silently failed few-but-HUGE-clip days: a long post-roll makes 32 clips × ~90 s = 1.44 GB that needs 212 s on the Nano but scored only 80 s → floored to 120 s → timed out (user-hit 2026-06-20). Build time is driven by the `-c copy` read + `+faststart` second pass over the bytes, so scale by bytes.
  - The route runs the build in the BACKGROUND (`asyncio.create_task` + strong-ref set + de-dupe guard); `POST /system/timelapse` returns `{building:true}` instantly, client polls `GET /system/timelapse/status?date=` until ready/error. NEVER `await build_async` inline — a big day blocks the request past the browser/proxy timeout. `_TIMELAPSE_STATUS` is a module global → reset it in tests (conftest `_reset_timelapse_state`).
  - DE-OVERLAP (the "people teleporting back in time" fix, user-reported 2026-06-20): event clips for a continuous presence OVERLAP massively (clip ~90 s but detection re-fires every ~5 s cooldown → consecutive clips share ~85 s). Concatenated whole, the reel replays the same seconds and the playhead jumps BACKWARD. `_events_with_clips_for_day` now places each clip on a wall-clock timeline (event `ts` + ffprobe `_probe_clip` duration) and front-trims the already-covered prefix via the concat-demuxer `inpoint` directive (keyframe-aligned, still `-c copy`). The shared pre-roll cancels out of the overlap math, so it's not needed. Don't revert to a plain `file '...'` concat — it reintroduces the teleport. Pinned by the de-overlap tests in `test_timelapse_build_real_ffmpeg.py`.
  - TIMESTAMP OVERLAY (same iter): `build()` also writes an atomic `<day>.json.tmp`→`<day>.json` sidecar `{v:1,date,segments:[{offset_s,capture_ts}]}` (reel-offset → original capture time). Served by the same auth-gated `/api/timelapses/{filename}` route (regex now `(mp4|json)`); `list_timelapses` exposes `manifest_url`; `delete_timelapse` unlinks it. Client paints a forward-ticking local-`HH:MM:SS` corner overlay via `lib/timelapseClock.ts` (the `drawBoxes.ts` paint-over-video pattern), fetched LAZILY on first play (preserves `preload="none"`). Overlay-only by design — NOT burned in (software-x264 burn-in is ~1.5–3 h on the Nano + violates `-c copy`; NVENC is barred by the transcode-PTS-scramble pin). Raw-MP4 download loses the overlay; acceptable. Older reels have no sidecar → 404 → overlay hidden, playback fine.
  - Pinned by `test_timelapse_build_real_ffmpeg.py` (real ffmpeg, incl. de-overlap + sidecar) + `test_control.py` (async route, manifest_url, sidecar serve/delete) + client `timelapseClock.test.ts` + `TimelapsesSection.test.tsx`. NOTE: still a CONCAT of (now de-overlapped) clips, not a true frame-sampled timelapse — a future improvement if size/speed matters.
- `/api/events/export` 50-cap + `Semaphore(1)`. Builds the ZIP to a `NamedTemporaryFile` on `recordings_dir` (data volume) and returns `FileResponse` + `BackgroundTask` unlink — NOT an in-RAM `io.BytesIO`. Clips average ~10.5 MB (H.264, incompressible) so 50 in RAM = ~400 MB × the old double-`BytesIO` × `Semaphore(2)` = >800 MB vs the 512 MB container cap → silent cgroup OOM-kill. Don't reintroduce in-memory buffering or raise the semaphore.
- `POST /api/_internal/client_log` (`_internal.py`): unauth sink for the PWA's `lib/log.ts` ship() — device-side error/warn lands in journald with a `client_log:` prefix. `extra='forbid'` + app-level rate cap (`_CLIENT_LOG_MAX_PER_WINDOW`, NOT middleware). Lives on `_internal` so it works on the anon login screen.
- Worker failure-rate counters (`metrics.py` ↔ `_ALLOWED_METRIC_FIELDS` ↔ client `WorkerMetrics`): `clips_dropped_capacity`, `clip_start_failures`, `face_recog_failures`, `event_post_failures`, `thumb_save_failures`. Three-way symmetry pinned by `test_internal.py::test_worker_snapshot_keys_match_whitelist`.
- `server/app/log.py::RateLimitedLog(window_s, clock=time.monotonic)` — once-per-window log gate for hot paths. Tests inject `clock=` to fake time; NEVER `monkeypatch.setattr(time, "monotonic", …)` (corrupts asyncio's event-loop clock → "no current event loop" in later tests).
- `/snapshots/thumb_<digits>.jpg` unauth carve-out — push notification `image:` is fetched by OS push daemon WITHOUT cookies. ONLY filenames matching `^thumb_[0-9]+\.jpg$` are unauth; everything else 308-redirects to auth-gated `/api/snapshots/`.

### Detection / Jetson
- `detection/*.py` MUST stay Python 3.6 compatible (JetPack 4.x). No `from __future__ import annotations`, PEP-604 unions, `match`, walrus. Pinned by `tests/test_py36_compat.py` AST scanner.
- If you add `cv2` to `detect.py`, import it BEFORE `jetson_inference` / `jetson_utils`. CUDA fills static-TLS first → libgomp can't load.
- `detect.py main()` calls `applog.configure()` FIRST (before any worker thread) so leaf-lib `logging` records + hot-loop `applog.emit()` prints share one journald format. Logging behavior pins: detectNet load failure → `SystemExit(4)` (distinct from mem-gate's 3) after an ERROR; `net.Detect` CUDA fault logs ERROR then re-raises (crash-and-restart preserved); `box_norm` ValueError is caught at the call site → dropped frame (was a loop-crash). Post-roll recorder stderr → bounded per-event temp file (NOT PIPE — deadlock pin); `preroll.run_concat` (sync `subprocess.run` w/ timeout) uses `stderr=PIPE` (drain-safe).
- Emit gate = PRESENCE COALESCING (`detection/presence.py::PresenceTracker`), NOT a flat cooldown (user fix 2026-06-20 "events triggered multiple times"). One continuous presence used to re-fire a fresh event+clip every `cooldown_s` (~5 s) → ~6 overlapping clips per visit (spam + storage + the timelapse "teleport"). Now: while the same subject stays IoU-matched (`bbox_iou`≥0.3 on `top_d.Left/Top/Right/Bottom`) AND its clip is still recording, re-emits are SUPPRESSED — one event per presence; re-arm to the next segment only when a long linger outlasts its clip (so coverage stays complete + segments tile without overlap). `cooldown_s` is now the min-gap FLOOR; `_PRESENCE_GAP_S`=20 s = absent-this-long ⇒ new visit. LOAD-BEARING: `last_detection = now` (active-gear keepalive) was MOVED ABOVE the emit gate — a coalesced-but-present subject emits only ~once/clip, so if the bump stayed on the emit path the worker would drop to idle 1 fps mid-presence. Don't move it back below the gate. Bias is toward EMITTING when unsure (a missed event is worse than an extra). Pinned by `tests/test_presence.py` + the py36 scanner. Pairs with the timelapse de-overlap (Server wiring) — both attack the same overlap, one at record time, one at stitch time.
- Single-owner libargus (`mediamtx.yml`): one `nvarguscamerasrc → nvv4l2h264enc → rtspclientsink` branch; detection re-decodes via NVDEC. Don't add `tee` or a second `nvarguscamerasrc`.
- Cellular-adaptive rungs `cam_lq`/`cam_uq` (`mediamtx.yml`) MUST encode with software `x264enc tune=zerolatency`, NOT hardware `nvv4l2h264enc`. The Tegra encoder emits NON-MONOTONIC output PTS when fed by NVDEC in a transcode (bitstream is clean IPPP, but MediaMTX's gortsplib DTS extractor reads the backwards-jumping PTS as reordering → kills every WebRTC reader with "WebRTC doesn't support H264 streams with B-frames" → phone shows black tile then error). The always-on `cam` HQ path encodes live sensor frames (monotonic PTS) so it MUST stay `nvv4l2h264enc`. Decode stays hardware NVDEC; only the small-rung encode is software (~0.75 core @ 480p60). Pinned by `test_mediamtx_adaptive_paths.py`.
- `PrivateTmp=yes` on systemd units breaks `nvarguscamerasrc` (libargus uses `/tmp/argus_socket`).
- `detection/face_recog/` dir name is intentional — pip lib is `face_recognition`; matching name would shadow it.
- `init_face_recognizer()` lazy-imports `face_recognition` only when `encodings.pkl` exists. Eager import hangs every Nano boot — dlib v20 deadlocks in `PyInit__dlib_pybind11`.
- Detection zones: three-way alignment — route Pydantic `_Polygon` ↔ service `_valid_zones` ↔ worker `zones.py` (3.6-compat duplicate). Empty list = no gating. Client uses SVG `viewBox="0 0 1 1"` so [0, 1] coords are native.
- RBAC `admin`-as-`owner` transitional carve-out lives in BOTH server `require_role` and client `Settings.tsx::isOwner`. Both sides drop together when seeded users migrate.
- ffmpeg muxer `-f mp4` is load-bearing in `recording.py::_build_args` and `preroll.py::run_concat`. `.tmp` output suffixes can't be muxer-inferred. Pin: `test_*_real_ffmpeg_*`.
- Recorder uses `-c copy` (NVENC bitstream, no re-encode). Don't add `drawbox`/filtergraphs to burn boxes into pixels — bbox overlay is client-side via `lib/drawBoxes.ts`.
- Pre-roll segments are COPIED into a per-event scratch dir before the merge thread waits. The segment-recorder ffmpeg uses `-segment_wrap` which rewrites slots in-place; the copy decouples merge timing from ring rotation. Don't drop the `shutil.copy2` step in `recording.py::start_clip`.
- Heatmap day-bounds use local-time `new Date(y, m, d)`, NOT `Date.parse('YYYY-MM-DD')`. Server uses `date(ts, 'unixepoch', 'localtime')`. Operator must set `TZ=...` in compose.
- SW `clientsClaim` immediate-takeover: fresh `client/dist` activates SW immediately. Stale SW silently drops `dismiss` notification action.

## Out of scope

- Two-way audio — placeholder UI only; plumbing post-hardware.
- Cloud relay — assume Tailscale/LAN. Don't expose Jetson directly.
- iOS Safari Web Push — needs homescreen install (16.4+); targeting Android + desktop first.

Anti-recommendations: no PrivateTmp, no rate-limiting middleware, no GStreamer tee, no eager `face_recognition` import, no ffmpeg re-encode in the recorder, no pixel-burn-in for bboxes. (STUN/TURN WERE on the no-list — reversed iter cellular-ice 2026-06-17 because cellular needs NAT traversal; see WHEP config note above.)
