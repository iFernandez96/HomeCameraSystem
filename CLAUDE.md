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

# Deploy server — REBUILD (server/app/ NOT bind-mounted; `restart` ships the OLD image)
ssh jetson 'cd /home/israel/HomeCameraSystem && sudo docker compose -f deploy/docker-compose.yml up -d --build server'

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

## Don't reintroduce

### Theme
- Tailwind v4 CSS-vars need `var()`: `bg-[--color-x]` lints clean but renders nothing. Use `bg-[var(--color-x)]`.
- Light calico theme is baseline. No `bg-neutral-9XX`, `border-neutral-8XX`, `text-blue-XXX`. EXCEPTION: `text-white` on colored fills (primary button, danger/success toasts).
- Cat brand identity (Panther / Mushu / Coco) is load-bearing at runtime — SideNav, Login, ambient `CatLayer`, `CatEmptyState`, paw-mask active-nav. Cat-themed copy is also pinned by EventList/Events tests.
- `CatLayer`: `dt` clamp 33ms, NO CSS `transition` on per-frame `transform` (collapses with React state updates → "teleport"). Keep `willChange: transform`.
- `<CatEmptyState>` is the only empty-state primitive. Don't render plain-text empty states.

### Client wiring
- WHEP config: `iceServers: []` (no STUN), single recv-only video transceiver (no audio). Adding either adds hundreds of ms to first frame. Camera has no audio.
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
- `/api/events/export` 50-cap + `Semaphore(2)`. Don't raise without switching to streaming `zipfile`.
- `/snapshots/thumb_<digits>.jpg` unauth carve-out — push notification `image:` is fetched by OS push daemon WITHOUT cookies. ONLY filenames matching `^thumb_[0-9]+\.jpg$` are unauth; everything else 308-redirects to auth-gated `/api/snapshots/`.

### Detection / Jetson
- `detection/*.py` MUST stay Python 3.6 compatible (JetPack 4.x). No `from __future__ import annotations`, PEP-604 unions, `match`, walrus. Pinned by `tests/test_py36_compat.py` AST scanner.
- If you add `cv2` to `detect.py`, import it BEFORE `jetson_inference` / `jetson_utils`. CUDA fills static-TLS first → libgomp can't load.
- Single-owner libargus (`mediamtx.yml`): one `nvarguscamerasrc → nvv4l2h264enc → rtspclientsink` branch; detection re-decodes via NVDEC. Don't add `tee` or a second `nvarguscamerasrc`.
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

Anti-recommendations: no STUN, no PrivateTmp, no rate-limiting middleware, no GStreamer tee, no eager `face_recognition` import, no ffmpeg re-encode in the recorder, no pixel-burn-in for bboxes.
