# HomeCameraSystem — Source-Derived Codebase Analysis

Analysis date: 2026-07-09. Everything below was derived from reading the source code, config files, and image assets directly (documentation deliberately ignored). File references point at the load-bearing code.

## What this is

A self-hosted, Ring-style home security camera system built around a single **Jetson Nano 2GB** with an Arducam IMX477 camera (96° M12 lens). The Jetson is the server; phones and laptops are clients running the same installable PWA. The whole system runs on the owner's LAN/Tailscale tailnet — there is no cloud component. It has a strong cat-brand identity (three real cats: Panther, Mushu, Coco) baked into the UI at runtime.

Four tiers, three runtimes:

| Tier | Tech | Runs where |
|---|---|---|
| `client/` | Vite + React 19 + TS + Tailwind v4 PWA | Any browser / installed PWA / Android WebView wrapper |
| `server/` | FastAPI, Python 3.11 | Docker container on the Jetson (512 MB mem cap) |
| `detection/` | Python **3.6** worker | Bare-metal on the Jetson host (needs libargus / TensorRT / NVDEC) |
| `android-wrapper/` | Java WebView shell | Android phone (new, untracked) |

## Video pipeline (end to end)

```
IMX477 sensor
  → nvarguscamerasrc (sensor-mode 1: 1920x1080@60 center-crop)
  → nvvidconv (VIC scale to 1280x720, zero-copy NVMM)
  → nvv4l2h264enc (hardware NVENC, CBR 2.5 Mbps, GOP ~0.27 s, insert-sps-pps)
  → h264parse → watchdog(5 s) → rtspclientsink → MediaMTX :8554/cam
```

- **MediaMTX** (native systemd service, deliberately NOT containerized — needs host libargus/L4T GStreamer) owns the single `nvarguscamerasrc`. Exactly one publisher branch, no `tee` (`deploy/mediamtx.yml`).
- **Browsers** pull WebRTC via WHEP on `:8889`. ICE config includes Google STUN plus extra host candidates (Tailscale IP + MagicDNS name) and ICE-TCP on `:8189`, because on cellular the in-browser media socket does not ride the Tailscale tunnel — only the HTTPS control plane does.
- **Adaptive quality rungs** `cam_lq` (854×480 ~700 kbps) and `cam_uq` (640×360 ~400 kbps) are `runOnDemand` transcodes: hardware NVDEC decode → **software** `x264enc tune=zerolatency`. Software encode is mandatory here: transcode-fed NVENC emits non-monotonic PTS that MediaMTX misreads as B-frames and kills every WebRTC reader. Zero cost when nobody selects them (`runOnDemandCloseAfter: 10s`).
- **The detection worker** re-decodes `rtsp://localhost:8554/cam` via `jetson_utils.videoSource` (NVDEC).

## detection/ — the Python 3.6 worker (`detect.py`, ~3100 lines)

The most intricate tier. Main loop per frame: capture → watchdog/guard bookkeeping → gear selection → inference → filtering → emit gating → clip recording → event POST.

**Inference.** `jetson_inference.detectNet` (SSD-MobileNet-v2, TensorRT) loaded once with a fixed low floor of 0.05; the user-facing confidence threshold is applied in Python post-inference so slider changes never reload the ~6 s TRT engine. Class filter defaults to `["person"]`. Boxes are normalized by `box_norm.py` (clamped in pixel space so `x+w<=1` exactly, matching the server's validator). Detection-zone gating (`zones.py`) tests 5 sample points per box (center + quartiles, ≥2/5 inside any polygon) — pure ray-casting, no deps.

**Gear ladder.** The worker degrades rather than dies: `off / scheduled-off / low-memory / thermal-throttled / idle (1 fps inference) / active (5 fps)`. `memory_guard.py` (low 80 MB / recover 150 MB) and `thermal_guard.py` (hot 80 °C / cool 70 °C) are hysteretic gates that fail open when `/proc`/`/sys` are unreadable. Capture never stops — only inference throttles.

**Two mutually exclusive event/clip paths** (hard XOR at runtime, flippable live via config poll):

1. *Legacy presence-coalescing* (`presence.py::PresenceTracker`): one continuous IoU-matched presence (IoU ≥ 0.3, gap ≤ 20 s) = one event + one per-event clip. `ClipRecorder.start_clip` forks an `ffmpeg -c copy` post-roll subprocess; pre-roll comes from `preroll.py::PrerollBuffer`, a long-running ffmpeg segment ring (60 × 1 s segments, `-segment_wrap`), whose segments are copied to a per-event scratch dir before merge (ring slots are rewritten in place).
2. *Continuous capture* (`visit.py` + `visit_runtime.py`, currently default ON): a per-subject "visit" state machine (IDLE/PRESENT/POST_ROLL) where IoU is advisory only. One visit = one clip; visits cap at `max_visit_s` (150 s) with seamless continuation segments, finalize after `absence_finalize_s` (30 s) of absence. `recording.py::finalize_visit` concats the visit's scratch segments (`-c copy -f mp4`, bytes-scaled timeout ~300 s/GB), then **real-decode validates** the output (`ffmpeg -f null -` — ffprobe rc=0 alone is not trusted), duration-window checks it, and atomically `os.replace`s into place. Serialized by a process-wide `Semaphore(1)` (2 GB Nano).
   - *Crash recovery*: open visits are persisted to `.open_visits.json` (fsync file + dir) on every open/extend; on boot, `recover_open_visits()` re-finalizes surviving scratch or marks done if the MP4 already validates. Max 3 attempts, then abandon loudly.
   - *Disk floor*: worker stops creating footage at 450 MB free — deliberately above the server's 300 MB eviction floor so the producer stops before the reaper starts.
   - `clip_state.py` writes a `.clip_state.json` ledger shared with the container so the server can answer "recording / finalizing / available / failed" instead of a bare 404.

**Face recognition** (`face_recog/recognizer.py`) has three modes resolved at boot: full match mode (dlib `face_recognition`, HOG + 128-d encodings, tolerance 0.55) when `encodings.pkl` exists; capture-only mode (cv2 Haar cascade) that banks unlabeled crops to `face_captures/__unknown__/` for the Training page; or fully dormant. The library is lazy-imported (eager dlib import deadlocks the Nano at boot). Up to 4 person boxes per frame get per-person face + full-body crops with JSON sidecar metadata; `person_name` + `person_names` flow into the event.

**Self-healing.** Multiple independent liveness layers:

- *Process liveness*: systemd `Type=notify` + `WatchdogSec=90`; `READY=1` after model+camera up, then `WATCHDOG=1` from a dedicated thread (never the main loop — `Capture()` blocks) via a stdlib `sdnotify.py`.
- *Camera-wedge recovery*: `mediamtx_watchdog.py` is a pure decision ladder — after 30 consecutive capture failures: restart mediamtx ×2 → restart nvargus-daemon ×2 → reboot — with per-rung cooldown multipliers (nvargus gets 2.5× dwell) and `level` + `last_action_at` **persisted to disk before acting**, so a fast-failing worker restart cannot reset the climb. Bounded diagnostics (free/tegrastats/dmesg/nvargus RSS) are snapshotted on every escalation. Reboot has a 30-min boot-loop guard and an env opt-out. Open visits are finalized at `last_seen` before any disruptive action.
- *Mid-stream stalls*: the GStreamer `watchdog timeout=5000` element in the publish pipeline; systemd `BindsTo=nvargus-daemon.service` couples mediamtx to the camera daemon.
- *Remote actuation*: a host-action poll thread claims reboot/recover/log-fetch requests from the server's host bridge (God-mode console) and executes them under the same recovery lock.

**Server communication** (all loopback-enforced at startup — non-loopback `EVENT_URL` is a fatal exit): `POST /api/_internal/event` (detections), `/live_detection` (ephemeral overlay boxes), `/heartbeat` (metrics every 10 s, gated on main-loop liveness so a wedged loop reads OFFLINE), `GET /detection/config` (30 s poll, per-field validation so one bad field doesn't discard the update), and the `/host_action` claim/result trio.

Distinct fatal exit codes: `3` = startup memory-floor gate, `4` = model load failure, `1` = 100 consecutive capture failures.

## server/ — FastAPI in Docker

**Boot** (`app/main.py` lifespan): seed admin from env → init events/audit/sessions DBs → load host bridge → retention sweep (non-fatal) → start camera/detection service shims. Middleware, outermost-in: 1 MB body cap (rejects chunked with 411) → security headers on every response (+ `no-store` on auth/face/snapshot/timelapse paths) → GZip. Serves the built PWA as an SPA catch-all with a `resolve()`/`relative_to()` path-traversal guard.

**Auth.** Cookie-based HS256 JWTs, two kinds: access (15 min) and refresh (7 d), `HttpOnly + SameSite=Strict + Path=/api`. `tokens.decode` re-validates the `kind` claim post-signature (PyJWT alone accepts a mismatched kind). Login uses a dummy-hash verify on unknown users (timing-oracle defense). Roles: `owner / family / viewer` plus legacy `admin` treated as owner. `require_role` prefers the DB role over the JWT claim so role changes and deletions bite immediately. Every login/refresh/logout writes a session row (`sessions_db`, no token bytes stored) and an audit event; owners can list sessions (with "watching now" derived from WS subscribers) and revoke by jti. Owner/admin accounts cannot be deleted through the API at all (2026-07-09 policy).

**Event pipeline.** `event_bus` is in-memory pub/sub only: `publish()` write-throughs to SQLite (`events_db`, idempotent `INSERT OR IGNORE`) then fans out to up to 32 WS subscribers with per-queue backpressure (maxsize 64). `events_db` carries id/ts/camera/label/score/person(s)/thumb/clip/boxes/seen with cursor-paginated search (strict `<` on `before_ts`), local-time day bucketing, people summaries, and unread tracking. The WS endpoint accepts first, then closes 1008 on origin-mismatch or auth failure (full netloc equality on Origin).

**Worker-facing API** (`routes/_internal.py`, never auth-gated, loopback-trusted): the event ingest with a strict Pydantic `DetectionPayload` (`extra='forbid'`, box count [1,32], coords [0,1], off-frame geometry rejected, regex-pinned thumb/clip URLs); the heartbeat (raw-body parse that never 422s, per-field whitelist `_ALLOWED_METRIC_FIELDS` + type/bounds coercion — bool excluded from the numeric path, NaN/Inf rejected); a rate-capped unauth client-log sink for the PWA; live-detection overlay ingest; and the host-action bridge. Event ingest also fans out Web Push in a background task (strong-ref set against GC) with per-subscription filters.

**Clips & retention** (`services/recording_service.py`): clips live as `recordings/{event_id}.mp4` + `.tracks.json` (bbox track sidecar for overlay) + the worker's clip-state ledger. Retention = age-based sweep (days resolved from the user's retention preset) plus an age-independent byte-floor evictor (300 MB). Deleting an event unlinks its clip (recent fix — deletes used to orphan MP4s). Export builds ZIPs on disk (not RAM — a previous 512 MB-container OOM), capped at 50 clips, `Semaphore(1)`.

**Timelapse** (`services/timelapse.py`): stitches a day's clips with the concat demuxer, ffprobe-validating every input and the output (`-c copy` silently drops bad clips at rc=0), de-overlapping consecutive clips via `inpoint` front-trims on a wall-clock timeline (fixes playhead jumping backward), writing atomically via `.tmp` + `os.replace`, with a JSON sidecar mapping reel offset → capture time that the client paints as a ticking clock overlay. Builds run as background asyncio tasks; the route returns `{building:true}` instantly and the client polls status.

**Other surfaces**: `/api/status` (aggregated camera/worker/thermal/disk health with once-per-transition "dark probe" logging), multicam registry (`HOMECAM_CAMERAS` env JSON → `/api/cameras`), Web Push with VAPID keys generated on first container boot, per-user push filters (cameras/persons/schedule window with midnight wraparound), owner-only face/person training-data browsing with two-tier traversal defense, backup/restore and OTA update orchestration (owner-only, ledger-audited, maintenance lock), Prometheus `/metrics` and `/healthz` at root (unauth — scrapers don't speak cookies), and an unauth carve-out serving only `thumb_<ts>.jpg` (the OS push daemon fetches notification images without cookies; everything else 308s to the authed route).

**House patterns**: every SQLite store is stdlib `sqlite3`, WAL, connection-per-call, file pre-created `0o600` before connect, `CREATE TABLE IF NOT EXISTS` + guarded `ALTER` migrations. Every sensitive file serve stacks regex validation + `resolve()/relative_to()`. Hot paths log through rate-limited/once-flag gates.

## client/ — the PWA

**Shell** (`src/App.tsx`): React Router 7, all pages lazy-loaded with a shape-matched loading fallback. Routes: `/` (Watch — live view + today's timeline), `/events`, `/people`, `/training` + `/training/review` (face-recog labeling and an active-learning triage queue for 0.3–0.75-confidence crops), `/settings`, `/god` (owner crash-cart console: worker logs, recovery/reboot actions, sessions, wedge-ladder status), `/login`, catch-all → home. Chrome: top WatchRibbon, desktop SideRail, mobile floating pebble BottomNav, connection/push-denied banners, per-page ErrorBoundaries, an Android back-button trap at `/`.

**The lib layer is the architecture**:
- `lib/api.ts` — the only fetch boundary. Central `req<T>()` adds cookies, single-flight silent refresh-then-retry on 401, full failure logging, and throws typed `HttpError`. ETag/If-None-Match caching for heavy GETs. Every REST endpoint has a typed wrapper; `lib/types.ts` is the client's half of the wire contract (pinned by mirror tests on both sides — there is no shared schema or codegen).
- `lib/ws.ts` — singleton reconnecting WebSocket with capped exponential backoff, except close-1008 (policy) which never retries and instead dispatches `homecam:auth-failed` so AuthProvider re-checks `/me`. A second signal, `homecam:session-expired`, drives the Login banner.
- `lib/webrtc.ts` — WHEP client with STUN (+optional TURN via `VITE_TURN_*`), connection pre-warming (PC + offer + ICE gathered before the user reaches Watch, 30 s TTL), and a privacy-safe attempt ledger (outcome + candidate-type counts, never SDP/IPs) dumpable from the console for cellular triage.
- `lib/theme.ts` + `index.css` + an inline pre-paint script in `index.html` — three-way lockstep dual theme ("Playroom Modern": light wall `#f3f1ea` / dark playroom `#232019`) via `data-theme`, with an **identity color palette** where hue encodes WHO appeared (named people get stable djb2-hashed wheel hues, unrecognized person = cobalt, cats = marmalade; red is reserved for danger and unproducible by the identity system).
- Module-scope singletons (WS socket, WHEP warm cache, refresh in-flight, session-expired flag) deliberately live outside React so they survive unmounts and exist pre-mount.

**PWA** (`src/sw.ts`, injectManifest): `skipWaiting` + `clientsClaim` immediate takeover; precache excludes the cat sprites (runtime CacheFirst, 30 d); NetworkFirst cache for `/api/events*` so the Events page works offline; push handler builds per-event notifications with a `dismiss` action that marks-seen without opening the app and a click deep-link to `/events?event=<id>`; app-icon unread badge via the Badging API.

**Brand assets**: `public/icon.svg` is a calico-orange tile with a black cat face and a red recording dot (plus a maskable variant with adaptive-icon safe-zone padding); `public/cats/*.png` are raster sprites of the three real cats (face/sit/sleep/walk/hiss/play/stretch/on-post states) powering empty states and the Login brand row.

**Testing**: near-every module has a co-located Vitest + Testing Library test (jsdom); wire shapes, theme contrast floors, and hard-won invariants are pinned by tests on both sides of each tier boundary. Playwright config exists for e2e.

## android-wrapper/ — new native shell (untracked)

A thin Java WebView wrapper around the deployed PWA (`versionName 2.14`, minSdk 24, targetSdk 36). One activity, ~all logic in `MainActivity.java`:

- Loads the Tailscale URL (`https://homecam.tail4a6525.ts.net/`); on main-frame failure falls back once to a hardcoded LAN URL (`http://10.0.0.9:8000/`, hence `usesCleartextTraffic`); if both fail, shows a hand-built native recovery view with "Open Tailscale" (launches the Tailscale app) and "Try again" buttons.
- Native HTML5-video fullscreen via `onShowCustomView` with immersive-sticky system bars; autoplay enabled; cookies (incl. third-party) enabled for the auth flow; custom UA suffix `HomeCamNative/1.1`.
- `configChanges` suppresses activity recreation on rotation (protects the live video), WebView state saved/restored otherwise.
- On every app-version bump, injected JS unregisters all service workers and clears Cache Storage once, then reloads — the wrapper forcibly bypasses the PWA's own SW update flow.
- Back button: exit fullscreen → WebView back → `moveTaskToBack` (never kills the activity). Predictive-back (Android 13+) handled alongside legacy.
- No native notifications, deep links, or launcher icon resources yet (ships with the default icon).

## deploy/ — how it ships and survives

- **Server**: cross-built ARM64 image on the x86 dev machine (`cross-deploy-server.sh`: buildx → `docker save | ssh load` → `compose up --no-build` → poll `/healthz`). Container capped at 512 MB (self-OOM before the system OOM-killer reaps the detection worker). Bind mounts for all media dirs; `client/dist` mounted rw for OTA client swaps; VAPID keys generated on first boot.
- **Systemd**: `mediamtx.service` is `BindsTo=nvargus-daemon.service`; `homecam-detect.service` is deliberately only `Wants=/After=` mediamtx (a hard `Requires` would restart the worker on every mediamtx bounce and reset the escalation ladder), `Type=notify`/`WatchdogSec=90`/`NotifyAccess=all`, and has `NoNewPrivileges` removed because recovery shells `sudo -n systemctl restart …`. `homecam-jetson-perf.service` pins MAXN + `jetson_clocks` at boot. No `PrivateTmp` anywhere (libargus needs `/tmp/argus_socket`).
- **Ops tooling**: idempotent `install-jetson.sh` (swap, docker, MediaMTX v1.18.0 pinned, units); `recover-camera.sh` manual escalation mirroring the autonomous ladder; `build-ota-artifact.sh` (client dist + detection tarball with sha256 manifest); `fetch-jetson-data.sh` read-only snapshot puller (events DB dump, recent clips, journals, config — never secrets) feeding gated real-data tests so all dev runs with the Jetson off; a soak-test harness and optional Grafana/Prometheus stack.

## Cross-cutting observations

- **No shared schema anywhere.** The wire contract between the three runtimes is held together entirely by mirrored tests (client `api.test.ts` ↔ server `test_*.py` ↔ a three-way set-equality pin on the heartbeat metric whitelist).
- **Pure cores, injected hardware.** Every hard decision (presence coalescing, visit state machine, watchdog ladder, gear transitions, zones, box normalization, memory/thermal hysteresis) lives in a stdlib-only module with its own offline test suite; hardware is wired in via injection and mocked only at the SDK import boundary.
- **Persistence as a correctness tool.** Escalation level, open visits, host-action dedupe ids, clip states, and watchdog timestamps all survive process restarts on disk — the codebase repeatedly treats "the worker restarted" as an expected event, not a failure.
- **Subprocess paranoia.** ffmpeg rc=0 is never trusted: inputs are ffprobe-validated, outputs are real-decode validated, timeouts scale with bytes, and everything writes `.tmp` → atomic replace.
- **The 2 GB ceiling shapes everything**: the container mem cap, the export-to-disk ZIP, the finalize semaphore, the worker's memory gear, the startup mem-floor gate, and the ban on native builds all trace back to the Nano's RAM.
