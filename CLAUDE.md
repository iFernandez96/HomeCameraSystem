# CLAUDE.md

Guidance for Claude Code working in this repo.

> **Picking this up cold?** Read in order: **Project status → Working environment & paths → The /loop autonomous mode → Sharp edges**. Then check `memory/loop_audit_log.md` for the most recent ~3 iterations to see what was just done. Iteration labels (`iter-N`) throughout this file and in code comments are entries in that log.

## Project status

Home Camera System: a self-hosted Ring-style camera app. The Jetson Nano 2GB (with attached RPi camera) is the **server**; phones/laptops are **clients** running the same installable PWA.

Four pieces:

- `client/` — Vite + React 19 + TypeScript + Tailwind v4 PWA (installable to Android home screen, also runs in any modern browser). **Light, calico-cream warm theme + cat-themed brand identity (iter-356.25..27 mega-overhaul; was Ring-style dark pre-iter-356.25 — see `HANDOFF.md` for the full theme story).** Mobile-first. Tests via Vitest + Testing Library + jsdom; lint via ESLint flat config.
- `server/` — FastAPI app on the Jetson. Handles control plane (REST), live event stream (WebSocket), and Web Push delivery. Tests via pytest + FastAPI TestClient. Runs in a Docker container on the Jetson because JetPack 4.x ships only Python 3.6 and FastAPI/Pydantic v2 want 3.8+.
- `detection/` — Python 3.6 worker that lives on the Jetson host (NOT in the container). Reads frames over RTSP from MediaMTX via jetson-utils `videoSource` (NVDEC), runs SSD-MobileNet-v2 via jetson-inference (TensorRT FP16), POSTs detection events to the server's `/api/_internal/event` endpoint. The optional `detection/face_recog/` subdir adds per-person identification (dlib-backed `face_recognition`); when `encodings.pkl` is present, the worker crops the top person bbox, looks the face up, and emits `person_name` in the event payload — otherwise the field stays null and the rest of the pipeline is unaffected.
- `deploy/` — `Dockerfile.server`, `docker-compose.yml`, `mediamtx.yml`, `entrypoint.sh`, `install-jetson.sh`, and systemd units for `mediamtx`, `homecam-server`, and `homecam-detect`. Video plane is intentionally separate from FastAPI so detection and control don't share a process with the streamer.

Most pieces are now real, not stubbed. Detection, heartbeat, push, persistence, idle-gear thermal management, schedule windows, and per-person UI are wired end-to-end. The notable stub is `/api/system/reboot` (the server runs in a container, so wiring it requires a host-side helper). Treat regressions in tests/lint/typecheck as real failures.

## Architecture

```
RPi Camera ──► nvarguscamerasrc ──► nvv4l2h264enc ──► rtspclientsink
                                    (NVENC, 720p30,         │
                                     iframeinterval=8)      ▼
                                                       MediaMTX :8554 (RTSP)
                                                       MediaMTX :8889 (WebRTC)
                                                            │  │
                                              ┌─────────────┘  │
                                              │  RTSP          │ WebRTC (WHEP)
                                              ▼                ▼
                                       Detection worker  Browser <video>
                                       (jetson-utils
                                        videoSource +
                                        detectNet,
                                        SSD-MobileNet-v2)
                                              │
                                              │ on `person` ≥ threshold:
                                              │   crop top bbox, run
                                              │   face_recognition (hog),
                                              │   match → person_name
                                              │
                                              │ POST /api/_internal/event
                                              │   {label, score, boxes,
                                              │    person_name?}
                                              ▼
                                       FastAPI (Docker container)
                                              │
                                     WebSocket │ Web Push
                                              ▼
                                       Client UI / Phone

Client ──REST──► FastAPI ──► reboot / capture / settings / push subscribe
```

- Live video: WebRTC via MediaMTX (low latency, ~200ms). Client uses WHEP, no STUN, no audio transceiver.
- Camera ownership: only one process holds libargus at a time, so `nvarguscamerasrc` lives in MediaMTX's `runOnInit` GStreamer pipeline. Detection re-decodes the H.264 from MediaMTX's RTSP. NVDEC handles that in hardware (<10 % of decoder capacity on the Nano), so single-pass-encode-then-decode is cheaper than tee'ing raw frames into a shmsink (and works around JetPack's apt OpenCV not having GStreamer support).
- Events: WebSocket `/api/events/ws`. Server pushes detection events as JSON; client renders bounding boxes on a canvas overlay synced to video.
- Push: Web Push (VAPID). Subscriptions persisted server-side. Detection events trigger push when client is offline. When `person_name` is set on the event, the notification title uses the matched name ("Israel detected" instead of "Person detected").
- Control: REST under `/api/*`. Use WebSocket only for streaming telemetry/events, not request/response.
- Detection-to-server: `POST /api/_internal/event` from the host worker into the containerized server. No auth, single-host LAN-trusted.
- Detection gate: the UI's "Detect" toggle flips `detection_service.active`. When off, the internal endpoint returns `{ok: true, dropped: "detection paused"}` instead of publishing — the worker keeps running but its events never reach clients.
- Worker → server heartbeat: `POST /api/_internal/heartbeat` every 10 s with a small whitelisted metrics snapshot (`fps`, `gear`, `face_recog_names`, etc.). The server's `WorkerHealth` window expires after 30 s with no heartbeat; UI shows the OFFLINE pill. Heartbeat is gated on a `Liveness.bump()` from the inference loop so a wedged worker can't lie.
- Face recognition: when `detection/face_recog/encodings.pkl` exists and the pip `face_recognition` library is importable, the worker matches the highest-confidence person bbox per emit. Matched name flows through to the event as `person_name`, into the heartbeat as `face_recog_names`, and into the UI as filter chips, an emerald bbox, a Recognized pill on Events rows, and a Settings status row. Missing encodings or a missing library degrades cleanly — events still flow with `person_name: null`.

## Build & run (development)

Client (host machine):

```bash
cd client
npm install
npm run dev          # http://localhost:5173, proxies /api → http://localhost:8000
npm run build        # output to client/dist/
npm run preview
```

Server (Jetson, or host for early dev):

```bash
cd server
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements-dev.txt   # includes pytest; for prod use requirements.txt
cp .env.example .env
python -m app.scripts.gen_vapid        # generates VAPID keys for Web Push
uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
```

MediaMTX (Jetson):

```bash
# Download static binary for arm64 from https://github.com/bluenviron/mediamtx/releases
./mediamtx deploy/mediamtx.yml
```

> **Dev machine note:** the user's working repo is on an exFAT drive, which breaks `python3 -m venv .venv` (no symlinks). The project venv on the dev machine lives at `/tmp/homecam-venv` instead. See "Working environment & paths" below.

## Working environment & paths

Where things live and the non-obvious gotchas of this dev setup. Read this first when picking up cold — most "why doesn't X work?" answers are here.

### Dev machine

- **Repo:** `/media/israel/Drive/Projects/Android/HomeCameraSystem/` (exFAT-formatted external drive — see "exFAT quirks" below). The Claude Code session starts with `cwd=client/`; cd elsewhere by absolute path.
- **Server / detection test venv:** `/tmp/homecam-venv/` (built once with `python3 -m venv`; required because **exFAT can't host the symlinks** that `venv` creates). Invoke via `/tmp/homecam-venv/bin/python -m pytest` from `server/` or `detection/`. If the venv goes missing after a reboot (it lives in `/tmp`), rebuild with `python3 -m venv /tmp/homecam-venv && /tmp/homecam-venv/bin/pip install -r server/requirements-dev.txt`.
- **Client tests:** `npm test` (Vitest) from `client/`. `package.json` scripts call `node ./node_modules/<pkg>/.../bin.js` directly — see "exFAT quirks".
- **Sshfs mount of Jetson rootfs:** `~/jetson/` (covered in "Jetson dev access" below).

### Jetson

- **Repo on Jetson:** `/home/israel/HomeCameraSystem/` (rsynced from dev machine; **not** git-cloned, so don't expect `git status` to be meaningful there).
- **Client dist target:** `/home/israel/HomeCameraSystem/client/dist/` — served by FastAPI's static-mount in `server/app/main.py` via `settings.client_dist`.
- **Server lives in Docker** via `deploy/docker-compose.yml`; logs flow through `docker compose -f deploy/docker-compose.yml logs -f`. Push-subs JSON persists at `/app/secrets/push_subs.json` (named-volume bind that also holds VAPID keys; the env var `PUSH_SUBS_PATH` controls the location).
- **Detection worker** runs as systemd unit `homecam-detect` on the **host** (NOT in the container — it needs direct access to libargus / TensorRT / NVDEC). Wrapper script: `detection/run-detect.sh` (filters `nvbuf_utils` log spam, see iter-4).
- **MediaMTX** runs as systemd unit `mediamtx`, owns the camera (`nvarguscamerasrc` → `nvv4l2h264enc` → `rtspclientsink`). Config at `deploy/mediamtx.yml`.

### Deploy flow

**Client-only changes** (most iterations only touch the PWA bundle):

```bash
cd client && npm run build
rsync -a --delete client/dist/ jetson:/home/israel/HomeCameraSystem/client/dist/
```

The PWA auto-updates on the next page-load (`vite-plugin-pwa` with `registerType: 'autoUpdate'`), but existing open tabs continue serving the previous bundle until refreshed. Audit-log iterations that change UX should note "existing PWA tabs serve the previous bundle until reload."

**Server changes:** rebuild the Docker container on the Jetson — `ssh jetson 'cd /home/israel/HomeCameraSystem && sudo docker compose -f deploy/docker-compose.yml up -d --build server'`.

**SHARP EDGE — `restart` is NOT enough for server changes** (iter-317 lost-3-iters incident): the `server/app/` directory is **NOT bind-mounted** into the container — only `secrets`, `snapshots`, `recordings`, `timelapses`, `backups`, and `client_dist` are. Code is baked into the image at `docker compose build` time. So a workflow like `rsync server/app/ jetson:.../server/app/ && docker compose restart server` rsyncs to the host but leaves the container running stale image code. Symptoms: iters appear to deploy cleanly (rsync exits 0, container restarts cleanly), curl tests "look right" because the wire shape often hasn't changed, but the actual NEW behaviour never lands. Spent 3 iters of the iter-313/316/317 trio thinking they were live before noticing on iter-317 that the container's `/app/app/main.py` had no iter-313 code. **Always use `up -d --build server` for server changes** — never `restart server`. Same trap doesn't exist for client (bind-mounted via `client/dist:/app/client_dist:ro`) or detection worker (host-side, not containerized).

**Detection worker changes:** rsync `detection/`, then `ssh jetson 'sudo systemctl restart homecam-detect'`. Watch logs with `ssh jetson 'journalctl -u homecam-detect -f'`.

**MediaMTX config changes:** `ssh jetson 'sudo systemctl restart mediamtx'`. Note that the iter-26 watchdog in the detection worker will also restart MediaMTX automatically when it detects RTSP frame stalls.

### exFAT quirks

The repo sits on an exFAT drive. Two non-obvious failures it causes — workarounds are baked in:

- **No symlinks.** `python3 -m venv .venv` creates a venv whose `bin/python` and `bin/pip` are symlinks; exFAT silently drops them. Workaround: build venvs in `/tmp` (a real Linux fs) and reference by absolute path. See `memory/exfat_environment.md`.
- **No `node_modules/.bin` shims.** npm symlinks installed binaries into `.bin/` for `npx` / package-script resolution; exFAT drops those too. So `client/package.json` scripts spell out the full `node ./node_modules/<pkg>/.../bin.js` invocation literally. If you add a new dev-tool, follow the same pattern — `npx` won't find it.

If the repo is ever moved to ext4/btrfs, both workarounds become unnecessary; until then, anything that re-introduces a symlink dependency breaks the dev loop.

## The /loop autonomous mode

This repo is being optimised by a recurring `/loop 5m "..."` schedule that runs every 5 minutes in this Claude Code session. Each iteration: pick one small high-value improvement, implement, test, summarise. The full prompt body is captured in `memory/loop_audit_log.md`'s preamble.

**Audit log:** `memory/loop_audit_log.md` is the canonical record. Each iteration appends a section (Target / Why now / Change / Validation / Files / Risks-follow-ups). At the time of writing the loop is at iter-200; entries are in reverse chronological order (newest first **after** the legacy iter-1..8 standing-punch-list block at the top of the file).

**Before starting an iteration:**

1. Read `memory/MEMORY.md` (auto-loaded into context).
2. Skim the most recent ~3 entries in `memory/loop_audit_log.md` — especially "Risks/follow-ups" lines, which are the natural next-iteration seeds. Don't redo finished work.
3. Confirm green baseline: `npm test --run` (from `client/`), `/tmp/homecam-venv/bin/python -m pytest` (from `server/`), same from `detection/`.
4. Pick one item — either a follow-up from a recent entry, an item from the standing punch list (only WHEP trickle-ICE remains as of iter-200), or a fresh observation from the priority list (failing tests > security/validation > Jetson reliability > UX > observability > refactor > docs).

**During an iteration:**

- Touch as little as possible. One change, one rationale, tests for any behaviour change.
- If touching a route or payload, update **both** client and server tests (see "Tests as a contract surface" below).
- Run the narrowest validation (the targeted test file, then the full suite if green). Lint and typecheck after every client change.
- Build + rsync to Jetson if the change is in `client/`. Don't deploy server/detection changes without confirming with the user — they touch live systemd units.

**After the iteration:**

- Append an entry to `memory/loop_audit_log.md` **before** scheduling the next wakeup. Future iterations depend on it.
- Call `ScheduleWakeup` with the verbatim `/loop` input prefixed with `/loop ` (the runtime resolves the dynamic-mode sentinel; see the `loop` skill).
- Summarise to the user: change made, files touched, validation run, remaining risks/follow-ups.

**Stopping the loop:** omit the `ScheduleWakeup` call, or the user interrupts at the session level. The loop is dynamic-mode (no fixed cron), so each iteration is responsible for chaining the next.

### The audit cycle (engineering-team-style hierarchical review)

**Mode (operator directive, applied from iter-169 onward):** the audit cycle runs at the START of every /loop iter, not just at trigger conditions. Each iter regenerates `memory/state_of_the_project_iter<N>.md`, picks the top item, executes, logs. Justification: the user's explicit directive ("I want a full re-audit every time you loop"; "the project must be as optimal as possible"). Cost is real (~250k tokens per audit, 25-40 min wall-clock); throttle by raising the cron interval if needed. The CEO may exercise judgment to skip Phase 2 when no material code change has occurred since the previous audit (iter-170 documented this trade-off transparently). The first cycle ran at iter-161, the second at iter-169 (`memory/state_of_the_project_iter161.md` and `iter169.md`).

**Audit hierarchy (CEO → 7 Domain Managers → optional direct reports):**

1. **CEO (the main session)** spawns a single **VP Eng / Overseer** agent first. Overseer reads `CLAUDE.md`, recent audit-log entries, and a representative file or two; produces a **Product-Quality Charter** (~600-900 words) defining what "real product" means for THIS project, the per-domain quality bar, what's out of scope, the top 3 product-level risks, and the required reporting format every Manager must use.
2. **CEO** then spawns 7 **Domain Managers** in parallel, each receiving the full Charter verbatim plus a narrow domain scope: **Frontend** (`client/`), **Backend** (`server/`), **Detection** (`detection/`), **Infra** (`deploy/`), **QA** (tests/lint/typecheck across all), **Security** (cross-cutting), **Docs/PM** (READMEs, CLAUDE.md, in-code comments).
3. Each Manager produces a domain audit using the Charter's Section 5 reporting format: domain summary → issues by severity (Critical/Major/Minor/Nit) with `file:line` + what's wrong + what good looks like + effort + deploy surface → cross-domain dependencies → top 3 recommendations → ≥2 anti-recommendations citing sharp edges or audit-log iters.
4. **CEO** synthesizes the 7 reports into a state-of-the-project document under `memory/state_of_the_project_iter<N>.md`, identifies cross-cutting themes (issues that span ≥2 domains), and produces a roadmap of the next 8-12 iters in priority order. Add a pointer to `memory/MEMORY.md` so future sessions auto-load the doc.

**When to run the cycle:**

- After ~50 /loop iters, or when the most-recent audit's roadmap is exhausted (iter-161's roadmap covers 162-173; the next cycle should fire around iter-174).
- When the user asks for a "state of the project" / "audit" / "review."
- When two or more recent iterations end with "no obvious target" — that's the loop signaling the candidate space has thinned.

**Operational notes (lessons from cycle-1):**

- Sub-agents launched by Managers may hit a recursion-depth / tool-availability limit and have to perform the audit directly. Plan for that — Managers should be able to do the work themselves if their reports come back empty. Cycle-1 had 0 of 7 Managers successfully fan out; all did the audit directly. This is fine and saves a tier of context.
- Run all 7 Managers with `run_in_background: true` so they execute concurrently. Track them with `TaskCreate` (one per Manager + one for the synthesis).
- Charter Section 5 is load-bearing — it ensures all 7 reports are comparable. Don't trim it.
- Anti-recommendations sections across 7 reports are the single best protection against future cycles re-litigating settled decisions. Promote the most important to a dedicated section in the synthesis doc.
- The synthesis is the input for the next ~10 /loop iters. Each iter picks the next-highest-priority roadmap item, marks it done in the synthesis doc (or in a new `state_of_the_project_iter<N+1>.md` if the cycle re-runs), and continues.

## Jetson dev access

The Jetson is reachable from the user's dev machine over SSH. Use it directly when work needs to touch the actual hardware (camera capture, GStreamer/TensorRT pipelines, MediaMTX, systemd units).

- **SSH alias:** `ssh jetson` — configured in `~/.ssh/config`, key-based auth (`~/.ssh/id_ed25519`), no password.
- **Host details:** hostname `israel`, user `israel`, current IP `10.0.0.9` on `wlan0` (DHCP — verify with `ssh jetson 'ip -4 -br a'` if it has moved).
- **Passwordless sudo** is configured for `israel` on the Jetson, so `ssh jetson 'sudo <cmd>'` runs non-interactively.
- **Filesystem mount:** the Jetson rootfs is mounted on the dev machine at `~/jetson` via `sshfs`. Use the regular Read/Edit tools on `~/jetson/...` paths to view/modify files in place. To unmount: `fusermount -u ~/jetson`. To remount: `sshfs jetson:/ ~/jetson -o reconnect,ServerAliveInterval=15,ServerAliveCountMax=3`.
- **Environment:** L4T R32.7.6 (Ubuntu 18.04 arm64), kernel `4.9.337-tegra`, Docker installed (bridge `docker0` at `172.17.0.1/16`).

Prefer `ssh jetson '<cmd>'` for one-shots and `~/jetson/...` Read/Edit for file changes. For long-running services (uvicorn, mediamtx), use the systemd units in `deploy/` rather than foreground processes.

## Remote access via Tailscale

Tailscale is the project's chosen path for off-LAN access (PWA from a phone on cellular, dev access from anywhere). iter-238b installed it on the Jetson; the original anti-recommendation from iter-169 ("don't expose the Jetson directly") still applies — Tailscale lifts that by giving the Jetson a stable WireGuard-backed IP that's only reachable from devices on the same tailnet.

**Topology:**

```
phone (Tailscale client)  ─┐
laptop (Tailscale client) ─┼─►  tailnet (control plane: Tailscale)  ◄─►  homecam Jetson (Tailscale node)
                                                                              │
                                                                              ├─ Tailscale IP: 100.85.251.7 (stable per-node)
                                                                              ├─ MagicDNS FQDN: homecam.tail4a6525.ts.net
                                                                              ├─ Tailscale Serve: HTTPS :443 → http://localhost:8000
                                                                              │     (auto-issued Let's Encrypt cert, 90 d, auto-renewed)
                                                                              └─ Direct listens (tailnet only): :8000 (FastAPI),
                                                                                  :8554 (RTSP), :8889 (WebRTC)
```

Phone reaches the PWA at **`https://homecam.tail4a6525.ts.net`** (publicly-trusted cert; lock icon in browser; no warnings) from anywhere on the internet, as long as it's logged into the same tailnet. No port forwarding, no public IP, no reverse proxy of our own — Tailscale Serve terminates TLS and forwards plain HTTP to localhost:8000 inside the Jetson host.

**Jetson install (already done at iter-238b — recipe for repro):**

```bash
ssh jetson '
  curl -fsSL https://pkgs.tailscale.com/stable/ubuntu/bionic.noarmor.gpg \
    | sudo tee /usr/share/keyrings/tailscale-archive-keyring.gpg >/dev/null
  curl -fsSL https://pkgs.tailscale.com/stable/ubuntu/bionic.tailscale-keyring.list \
    | sudo tee /etc/apt/sources.list.d/tailscale.list >/dev/null
  sudo apt-get update && sudo apt-get install -y tailscale
  sudo tailscale up --hostname=homecam --ssh --accept-routes
'
```

Flags chosen:
- `--hostname=homecam` — pins the MagicDNS name (default would be `israel`, the Linux hostname). Stable URLs across reboots.
- `--ssh` — enables Tailscale SSH; lets `ssh root@homecam` work via tailnet identity (separate codepath from the normal `~/.ssh/id_ed25519` flow). Useful when the home Wi-Fi network address changes.
- `--accept-routes` — accepts subnet routes from other tailnet nodes. Future-proof if the dev machine ever advertises a LAN subnet.

The `tailscale up` step prints an auth URL — operator opens it in a browser, signs in to the Tailscale account, approves the new node. URL expires in ~10 min.

**Verify after install:**

```bash
ssh jetson 'tailscale status'      # should show "homecam ... online"
ssh jetson 'tailscale ip -4'       # prints the 100.x.y.z address
```

**Phone setup:**

1. Install the Tailscale Android app from Play Store, sign in to the same Tailscale account.
2. Toggle Tailscale on. Phone gets a 100.x.y.z IP.
3. Open the PWA at **`https://homecam.tail4a6525.ts.net`**.
4. Log in with an admin user (seeded via `gen_admin` — see "Admin user seeding" below).
5. Add to home screen — works the same as on LAN.

**HTTPS setup (live since the iter-243 follow-up deploy):**

Done. Tailscale Serve runs as a TLS-terminating reverse proxy on `:443` of the Jetson's tailnet interface. Cert is auto-issued by Let's Encrypt (free; gated only on the per-tailnet "HTTPS Certificates" toggle at https://login.tailscale.com/admin/dns) and auto-renewed by `tailscaled` ahead of the 90-day expiry. The FastAPI process inside the Docker container stays on plain HTTP `localhost:8000` — TLS never hits the app, so no uvicorn/Starlette TLS code path to maintain.

To re-issue or change the proxy mapping:

```bash
ssh jetson 'sudo tailscale serve --https=443 off'                       # disable
ssh jetson 'sudo tailscale serve --bg --https=443 http://localhost:8000' # re-enable
ssh jetson 'sudo tailscale serve status'                                # show what's wired
```

**Cookie behavior is correct for HTTPS by default.** `config.py::cookie_secure` defaults to `true`; the Jetson has no `.env` file overriding it; cookies get the `Secure` flag and are accepted by the phone over `https://`. If you ever roll the proxy off and revert to HTTP, you'd need to set `COOKIE_SECURE=false` in a Jetson `.env` — but don't, because that breaks Web Push (browsers refuse `PushManager.subscribe` on plain HTTP).

**Admin user seeding (one-time after first server build):**

The auth track requires at least one user in `users.db` before login works. After the first container build the DB is empty; you'll see this in `docker logs homecam-server`:

```
users.db is empty and HOMECAM_ADMIN_USER/_PASSWORD_HASH not set —
skipping env-seed. Run `python -m app.scripts.gen_admin <user>` to
create the first admin.
```

Two ways to seed:

1. **Interactive (recommended for first user)** — open a TTY-attached shell into the container and run `gen_admin`. The `-t` flag is required because `getpass` needs a real terminal:

   ```bash
   ssh -t jetson 'cd /home/israel/HomeCameraSystem && \
     sudo docker compose -f deploy/docker-compose.yml exec server \
     python -m app.scripts.gen_admin <username>'
   ```

   Prompts for password twice. Persists into the named volume `homecam-secrets` so the user survives container rebuilds.

2. **Env-seed (for redeploys / Phase 2 bootstrap)** — generate the argon2 hash once via `gen_admin --hash-only` (locally or in the container), put it in a Jetson-side `.env`:

   ```
   HOMECAM_ADMIN_USER=admin
   HOMECAM_ADMIN_PASSWORD_HASH=$argon2id$v=19$m=...
   ```

   Then restart the container — `seed_from_env_if_empty` (iter-179) inserts the user only when `users.db` is empty, so this is idempotent. Don't commit the hash; it's bcrypt/argon2 so cracking is costly but a leaked hash is still a downgrade attack.

**Sharp edge — don't drop:** the iter-184 auth gate + iter-184 `client` test fixture mean every cookieless GET on `/api/*` returns 401. If a phone resumes from background and the Tailscale tunnel hasn't re-established yet, requests fail with NETWORK_ERROR (not 401), which is the correct UX — the iter-158 ConnectionBanner pattern handles this.

**Recovery:**

```bash
ssh jetson 'sudo systemctl restart tailscaled'                                # if the daemon wedges
ssh jetson 'sudo tailscale down && sudo tailscale up --hostname=homecam --ssh --accept-routes'  # re-auth
ssh jetson 'sudo tailscale serve --bg --https=443 http://localhost:8000'      # re-arm proxy after re-auth
```

Logs: `ssh jetson 'sudo journalctl -u tailscaled -f'`.

## Jetson performance settings

The Nano 2GB has a tight thermal + memory envelope; this is the configuration the project assumes is in place. Verify with the commands below before attributing perf regressions to code.

- **Power mode** — `sudo nvpmodel -m 0` (MAXN, ~10 W). This is what's set in the field. Mode 1 (5 W) caps CPU to 2 cores at 918 MHz and the GPU at 640 MHz; under that cap inference latency roughly doubles and the camera pipeline starts dropping frames. Don't switch to 5 W unless explicitly trading perf for power. Verify: `sudo nvpmodel -q | tail -1` should print `MAXN` or `0`.
- **Clocks** — `sudo jetson_clocks` pins CPU/GPU/EMC at their MAXN ceilings and disables DVFS for the duration. Run after every reboot if you want stable encoder/inference latency. Without this, you get ~50-150 ms of variable encode warmup on the first frame after a quiet stretch (the `nvv4l2h264enc maxperf-enable=true` flag in `mediamtx.yml` covers the encoder side independently). Verify: `sudo jetson_clocks --show` should show GPU CurrentFreq=921600000.
- **Fan** — the Nano 2GB ships fanless. Add a 5 V PWM fan if you see `cpu_temp_c >= 85 °C` in `/api/status` regularly; `cpu_freq_pct < 100` in the same response confirms the kernel is throttling. Detection's idle gear (iter-3) keeps the SoC at ~50 °C in normal use, so a fan is rarely needed.
- **Swap / zram** — JetPack's defaults plus a 4 GB `/swapfile` work fine: ~1 GB zram across 4 partitions (priority 5) handles the hot path; the disk-backed swapfile (priority -1) catches overflow. Don't disable zram on this hardware — `MemAvailable` routinely sits below 200 MB and zram-compressed pages are the difference between graceful degradation and the OOM killer reaching for `python3 detect.py`. The detection worker's `MemoryGuard` (iter-33) pauses inference when MemAvailable drops below 80 MB.
- **Expected steady state** — at MAXN with the idle-gear detection (active 5 fps / idle 1 fps): CPU 45-55 °C, `cpu_freq_pct` 100, `infer_ms_recent` 35-50 ms, video first-frame on LAN ~250-400 ms, RAM ~1.7-1.8 GB used. Anything outside that envelope is signal worth chasing.

## Jetson recovery quick-reference

When something on the Jetson is stuck — most of these are one-liners.

- **A systemd unit hit its `StartLimitBurst=5`** (worker crash-loop after a syntax error or pipeline misconfig): `sudo systemctl reset-failed homecam-detect && sudo systemctl start homecam-detect`. Same recipe for `mediamtx.service`. The reset-failed step is mandatory — without it, `start` is a no-op while the unit's still in `failed` state.
- **MediaMTX silently dropped frames but is still "active" in systemd**: `sudo systemctl restart mediamtx` — and watch for the `[detect] mediamtx restarted by watchdog` line in `journalctl -u homecam-detect` confirming the iter-26 watchdog noticed too. If the worker's `mediamtx_restarts` counter is climbing, the camera/USB hub side needs investigating, not the gateway.
- **Worker stuck mid-iteration (not crashing, not heartbeating)**: the `Liveness.bump()` gate (iter-8) means the heartbeat thread will stop POSTing within 30 s and `/api/status.worker_alive` flips to `false`. Restart with `sudo systemctl restart homecam-detect`. If it wedges again immediately, look for the iter-22 dlib trap (`encodings.pkl` present + dlib hangs at import) or memory pressure (`MemAvailable` < 80 MB → check `gear: 'low-memory'`).
- **All three services need a clean reset**: `sudo systemctl restart mediamtx homecam-server homecam-detect`. Order doesn't matter — the unit dependencies fan out correctly.
- **Verify perf knobs are still applied** (after a reboot or manual override): `systemctl is-active homecam-jetson-perf` (iter-39 oneshot) should report `active`. If `inactive`, run `sudo systemctl start homecam-jetson-perf` and confirm `sudo jetson_clocks --show` shows GPU CurrentFreq=921600000.
- **Verify swap is on** (after a reboot if `/etc/fstab` got edited): `swapon --show` should list both `/swapfile` (4 GB, prio -1) and the four zram partitions.
- **Tail the right journal**: detection — `journalctl -u homecam-detect -f`; mediamtx — `journalctl -u mediamtx -f`; server — `docker compose -f deploy/docker-compose.yml logs -f`.
- **Server container OOM-killed** (post-iter-330 export route adds a transient ~10 MB-per-build RAM surface; an iter-337 Semaphore caps concurrent zip builds at 2 but a runaway leak elsewhere can still trip the 512 MB `mem_limit`): confirm via `sudo docker inspect homecam-server --format '{{.State.OOMKilled}}'` — if `true`, the iter-167 `restart: unless-stopped` policy will respawn within seconds. Bring it back with `sudo docker compose -f deploy/docker-compose.yml up -d server`. The `/api/status` JSON's `worker_alive` field will flip back to true once the heartbeat resumes (~10 s post-restart). Investigate the cause via `docker compose logs --tail=200 server` for the last requests before kill.

## Quality gates

Both sides have working test + lint pipelines. **Keep them green** — treat regressions like a build break.

```bash
# client (run from client/)
npm test                 # Vitest run, jsdom env (274 tests as of iter-199)
npm test -- --run        # explicit non-watch mode (matches CI behaviour)
npm run test:watch
npm run test:coverage    # text + HTML in coverage/
npm run typecheck        # tsc -b --noEmit
npm run lint             # ESLint flat config: js/ts + react-hooks + jsx-a11y
npm run lint:fix

# server (run from server/) — dev machine venv at /tmp/homecam-venv (see exFAT note)
/tmp/homecam-venv/bin/python -m pytest    # FastAPI TestClient + EventBus + PushService + gen_vapid + auth + /metrics + zones + RBAC + Grafana (417 tests as of iter-199)
/tmp/homecam-venv/bin/python -m pytest -k push    # filter

# detection (run from detection/) — same venv; tests are pure stdlib so any pytest works
/tmp/homecam-venv/bin/python -m pytest    # box_norm, memory_guard, thermal_guard, schedule, recognizer,
                                          # mediamtx_watchdog, metrics, zones, py36_compat scanner (135 tests as of iter-191b added zones helpers; iter-171 scanner covers PEP 585/604/walrus/match across 10 guarded modules including iter-191b zones.py)
```

The "in-prod" recipe (Jetson container, fresh checkout) still uses the canonical `python3 -m venv .venv && source .venv/bin/activate` flow — those are real ext4 filesystems. The `/tmp/homecam-venv` workaround is dev-machine-only.

Tests colocate with source: `Foo.tsx` ↔ `Foo.test.tsx` on the client; `tests/test_*.py` mirroring `app/` on the server. Mock external surfaces (`fetch`, `WebSocket`, `RTCPeerConnection`, `pywebpush.webpush`, `navigator.serviceWorker`) — don't make real network calls.

## Toolchain

- Node **20+** (the user runs Node 18, which produces EBADENGINE warnings; Vite 7 still works), Vite **7**, React **19**, TypeScript **5.7+**, Tailwind **v4** (no `tailwind.config.js` — config inline via `@theme` in CSS)
- Vitest **3** + Testing Library + jsdom; ESLint **9** flat config
- Python **3.11** for the server (runs in `python:3.11-slim-bookworm` Docker container; see `deploy/Dockerfile.server`). Python **3.6** for the detection worker (Jetson host; JetPack 4.x ships only 3.6, so `detection/*.py` must stay 3.6-compat — see Sharp edges + the iter-163 AST scanner). Dev-host venv at `/tmp/homecam-venv` is **3.10+** (system Python on the user's Linux distro), used to run server + detection unit tests on the dev machine.
- pytest **8**, pytest-asyncio (auto mode), httpx for FastAPI TestClient
- MediaMTX latest (Go binary)
- Web Push: `pywebpush` server-side, browser `PushManager` client-side, VAPID keys for auth

## Conventions

- Client API calls go through `client/src/lib/api.ts` (REST) and `client/src/lib/ws.ts` (WebSocket). Don't sprinkle `fetch()` across components. Non-2xx responses throw `HttpError` (iter-122) — branch on `err.status` (e.g. `e instanceof HttpError && e.status === 503`) instead of stringifying and substring-matching the message.
- WebRTC consumer logic lives in `client/src/lib/webrtc.ts`. Components consume the resulting `MediaStream`.
- Server route modules live under `server/app/routes/`. Long-running work (detection, camera) goes under `server/app/services/`.
- Event payloads are versioned: `{"v": 1, "type": "...", ...}`. Bump `v` on breaking changes.
- All time fields are unix epoch seconds (float, server-side `time.time()`). Render locally on the client.
- Secrets (VAPID keys, auth tokens) live in `.env` on the server. Never commit them.
- Skeleton/loading components live in `client/src/components/Skeleton.tsx` — reuse, don't recreate per page.
- Face recognition wrapper lives in `detection/face_recog/recognizer.py` — `FaceRecognizer.recognize_in_crop(rgb)` returns the matched name or None. The `face_recog/` dir is **deliberately not** named `face_recognition/` (see Sharp edges). Adding a new backend (InsightFace, etc.) means swapping the wrapper internals; `detect.py` and the rest of the stack only see the abstract interface.
- Worker heartbeat metrics field whitelist lives in `server/app/routes/_internal.py::_ALLOWED_METRIC_FIELDS`. Add fields here when extending what the worker reports; anything not whitelisted is silently dropped.
- **BDD-lite test convention** (iter-243 user directive). All NEW tests written from iter-243 onward use Given/When/Then phrasing in `it(...)` / `test_*` names AND arrange-act-assert (AAA) structure inside the body. Existing 1142 tests stay as-is and migrate **on touch** — when an iter edits a test for any other reason, also rename + restructure it. No new tooling (no pytest-bdd, no jest-cucumber, no Gherkin); pure convention. Full rules in "Tests as a contract surface" below.

### Sharp edges that have been ground down — don't reintroduce them

- **Tailwind v4 arbitrary CSS-var classes MUST use `var()` wrapper** (iter-356.27, discovered via browser-harness visual screenshot). The class `bg-[--color-accent-default]` looks valid + lints clean + typechecks BUT silently renders no background — Tailwind v4 doesn't auto-resolve naked `--var` references inside the `[...]` arbitrary-value bracket. Correct form: `bg-[var(--color-accent-default)]`. This bug existed latent since iter-356.0 (the design-token foundation) and was masked by the dark theme that mostly used hardcoded `bg-neutral-9XX` classes. The iter-356.25 light-theme flip exposed it everywhere — buttons, badges, card surfaces, focus rings all rendered transparent. iter-356.27 sed-wrapped every `[--color-`, `[--space-`, `[--radius-`, `[--shadow-` site across the codebase. Pattern when adding NEW arbitrary-CSS-var classes: always wrap with `var()`, e.g. `text-[var(--color-text-primary)]` not `text-[--color-text-primary]`. The Button.test.tsx + Settings.test.tsx assertions also moved to the var() form — keep them in lockstep.
- **Light theme + cat-themed brand identity is now the design baseline** (iter-356.25..27 mega-overhaul; full story in `HANDOFF.md`). Calico-cream page bg (`#faf6ee`), white cards, warm-dark text (`#1a1410`), calico-orange accent (`#d97706`). The full @theme block lives in `client/src/index.css`. **Don't re-introduce `bg-neutral-9XX`, `text-white` (except on accent fills — see below), `border-neutral-8XX`, `text-blue-XXX`** — they all read as broken now (dark island floating on cream page). The iter-356.26 bulk sed swept 24 files; corner cases on rarely-touched components MAY still need cleanup. **EXCEPTION**: `text-white` IS correct on a colored fill (orange/red/emerald button bg) where dark text would be muddy/invisible. Button primitive's primary variant + danger/success toasts deliberately keep `text-white`. The general rule: text on a TOKENIZED neutral surface uses `text-[var(--color-text-primary)]`; text on a SEMANTIC FILL uses `text-white`.
- **Cat brand identity is load-bearing at runtime.** Three cats — Panther (Bombay, aloof), Mushu (Tuxedo, playful), Coco (Calico, sleepy) — appear across: (1) `CatTrioMark` SVG in SideNav brand row + Login card header; (2) Ambient `CatLayer` walking strip at the bottom of every authed page (toggle in Settings → Account, defaults on); (3) `SleepingCatIllustration` in `<CatEmptyState>` primitive used by 5 surfaces (Events, People, Timelapses, Training × 2, Review); (4) Paw-print SVG mask via `--paw-svg` CSS variable on the active SideNav row + active BottomNav tab (`.paw-active::before` + `.bottomnav-paw-active::after` in `index.css`). Removing any of these breaks the brand consistency the user explicitly demanded — see `memory/feedback_major_ui_overhaul.md` for the cat-theme directive ("I would not pay for this level of UI/UX... go with option A. I said I wanted a complete overhaul on how the app's UI looked and i meant it"). The cat-themed copy ("All quiet out there. The camera's as quiet as a sleeping cat...") is also load-bearing — `EventList.test.tsx` + `Events.test.tsx` pin specific phrases.
- **CatLayer `dt` clamp + no CSS transition** (iter-356.21, `client/src/components/CatLayer.tsx`): the rAF tick clamps `dt` at **33 ms** (was 100 ms pre-iter-356.21 — chase-frame jumps of ~9 px read as teleports when tab regained focus). Per-cat sprite uses `transform: translateX(...)` directly per frame WITHOUT a CSS `transition` property — adding `transition: transform 80ms linear` will queue an 80 ms ease against every 16 ms React state update and the browser collapses them into jittery catch-up jumps that the user reports as "teleport." Keep `willChange: transform` (compositor promotion) but never the transition.
- **`<CatEmptyState>` primitive at `client/src/components/CatEmptyState.tsx`** (iter-356.23). Single shape for every empty surface across the app. API: `heading`, `body`, optional `hint`, optional `illustration` override (default = `SleepingCatIllustration size={96}`), optional `ariaLabel` override (default = heading). 5 consumers as of iter-356.24: EventList, People, Timelapses, Training (× 2 — dirs-empty + per-person gallery), Review. Don't render plain-text empty states next to these; they'll read as forgotten. The contract is pinned by 6 tests in `CatEmptyState.test.tsx` + 1 each in EventList/People/Events/Timelapses tests.
- **EventList `cameraOffline` prop branches the empty state** (iter-356.24). When true (parent passes from `useStatus()`'s `worker_alive=false || detection_active=false`), the sleeping-cat "All quiet" message swaps to "Camera looks offline" with a different aria-label. Reserved the sleeping-cat for the emotionally-accurate "camera is on and nothing happened" case. Frank's wife-anecdote: pre-iter-356.24 same surface rendered for both → "She'd stare at the sleeping cat for two hours wondering why the front door wasn't showing up." Maya iter-356.24 audit Minor: the heuristic conflates "worker dead" (restart needed) with "user toggled detection off" (just turn it back on) — both currently get "restart the camera box" copy. Iter-356.28 candidate: split the branch.
- **SPA path-traversal guard** in `server/app/main.py`. The catch-all calls `Path.resolve()` and `Path.relative_to(_CLIENT_ROOT)` to block requests like `GET /%2E%2E/etc/passwd`. If you simplify the handler, keep that check.
- **`react-hooks/set-state-in-effect`** (React 19 / `eslint-plugin-react-hooks` v7+) — calling a setState helper synchronously inside a `useEffect` body trips the rule. Either (a) inline the fetch in the effect with a `cancelled` flag and put `setX` calls in `.then`/`.catch`/`.finally`, or (b) keep the synchronous setState inside an event handler. See `client/src/pages/Events.tsx` for the pattern.
- **WHEP ICE gathering** (`client/src/lib/webrtc.ts`): `iceGatheringComplete` uses a `done` flag so its **250 ms** LAN-fast fallback timeout never resolves the promise after natural completion. iter-1 tightened this from the original 3 s; the `done` flag is the load-bearing part — don't drop it.
- **`/api/events?limit`** is bounded to `[1, 1000]` — keep that bound (or tighten it) when extending the route.
- **WHEP client config**: `iceServers: []` (no STUN, LAN-only) and a single recv-only video transceiver (no audio). Don't re-add STUN or an audio transceiver "for completeness" — the camera has no audio and adding either lengthens first-frame latency by hundreds of ms.
- **Import order in `detection/detect.py`** (forward-looking constraint): `detect.py` does NOT import `cv2` today — but **if** you ever do, it MUST come before `jetson_inference` / `jetson_utils`. The CUDA runtime fills the static-TLS block first and libgomp can't load afterwards (`ImportError: libgomp.so.1: cannot allocate memory in static TLS block`). The current file uses jetson-utils' `videoSource` for NVDEC and never needs cv2; if a future feature pulls in OpenCV, this is the order.
- **`detection/*.py` must stay Python 3.6 compatible.** JetPack 4.x ships Python 3.6 on the host where the detection worker runs, while the rest of the stack runs newer Python (server in a 3.11 container, tests in dev-host 3.10+). Don't add `from __future__ import annotations`, PEP-604 unions (`int | None`), `match` statements, walrus operators, or `:=` typings to anything imported by `detect.py` — they'll boot-loop the systemd unit at import time. The 3.6-compat modules today are: `detect.py`, `box_norm.py` (iter-96), `memory_guard.py`, `thermal_guard.py` (iter-89), `schedule.py`, `metrics.py`, `mediamtx_watchdog.py`, `zones.py` (iter-191b), `face_recog/recognizer.py`, `face_recog/encode_known_faces.py` (iter-163). Backed by `detection/tests/test_py36_compat.py` (iter-163) — an AST-walk scanner that fails any of the listed modules on PEP 585 generics; iter-171 extended it to also flag PEP 604 unions, walrus, and `match` statements.
- **`PrivateTmp=yes` on systemd units** breaks `nvarguscamerasrc` because libargus connects via `/tmp/argus_socket`. Don't enable it on `mediamtx.service` or `homecam-detect.service`.
- **Single-owner libargus** (`deploy/mediamtx.yml`): the GStreamer pipeline is `nvarguscamerasrc → nvv4l2h264enc → rtspclientsink` — **one** branch from camera to RTSP. Detection re-decodes the H.264 from MediaMTX's `:8554/cam` over NVDEC instead of teeing raw frames into a shmsink. Reason: only one process can hold libargus at a time, and JetPack's apt OpenCV is built without GStreamer support so `cv2` can't read shmsrc anyway. NVDEC re-decode is <10 % of decoder capacity on the Nano, so single-pass-encode-then-decode is cheaper than maintaining two pipelines. Don't add a `tee` or a second `nvarguscamerasrc` — both produce the same `Failed to create CaptureSession` libargus error.
- **Bounding-box payload validation** (`server/app/routes/_internal.py`): `Box` and `DetectionPayload` use `extra='forbid'` so an attacker can't sneak unexpected fields into events. Boxes are `[1, 32]` long; coordinates `[0, 1]`. The iter-95 `Box._box_within_frame` model_validator additionally rejects payloads with `x + w > 1 + 1e-3` and `y + h > 1 + 1e-3` (≈ 1.3 px tolerance at 720p; 1 px at 720p is 1/1280 ≈ 7.8e-4) — geometry that would render bbox graphics off the visible video. The worker side (`detection/box_norm.py`, iter-96) clamps pixel coords *before* the divide so legitimate output stays within `x + w ≤ 1.0` exactly; the server epsilon is purely for malformed/malicious payloads. Tighten if you ever expose this endpoint outside localhost.
- **Heartbeat metric type coercion** (`server/app/routes/_internal.py::_coerce_metric`): per-field validation drops bad values without poisoning the snapshot — booleans excluded from the numeric path (Python's `isinstance(True, int)` quirk), NaN/±Inf rejected (iter-97; `json.loads` accepts them by default but they'd break the browser's `JSON.parse` on the next `/api/status`), `gear` stripped + bounded to ≤32 chars (iter-117) so a stray `gear=" "` or `"x"*1MB` can't reach the UI, `face_recog_names` validated as `list[str]` with ≤50 entries and ≤64 chars per name (iter-118). The all-bad-types path leaves prior metrics intact instead of wiping (iter-81 / iter-78). Routes pin both directions in `tests/test_internal.py`.
- **Server response middlewares**: `server/app/main.py` registers three HTTP middlewares: a 1 MB request-body cap (iter-75), a security-headers wrapper that adds `X-Content-Type-Options`, `X-Frame-Options: DENY`, and `Referrer-Policy: same-origin` to every response including 4xx (iter-103), and `GZipMiddleware` with `minimum_size=1000` (iter-106) so `/api/events` compresses while small status pings don't. Worker-side `urllib.request` doesn't send `Accept-Encoding`, so worker → server stays uncompressed. Don't reorder the registrations without re-reading the comment in `main.py` — Starlette's `add_middleware` does `insert(0, …)` so registration order maps to the response stack.
- **Persisted-config load-time defenses**: `app/services/detection_config.py::_safe_float` (iter-99) and `app/services/push_service.py::_is_valid_loaded_sub` (iter-109) re-validate disk content on load. A manually-edited `detection_config.json` with `{"threshold": "high"}` falls back to defaults instead of crashing the boot; legacy oversized push subscriptions are scrubbed instead of being re-fanned. Mirrors the route's Pydantic Field caps; if you tighten the route, mirror here.
- **`detection/face_recog/` dir name** is intentional. The pip-installed library is `face_recognition`; if our local dir matched that name, `from face_recog.recognizer import FaceRecognizer` would shadow the package and the wrapper's `import face_recognition as fr` would re-import itself. Keep the names distinct.
- **dlib v20.0 deadlocks at import on the Nano 2GB** — both the CUDA-linked wheel and a CUDA-disabled rebuild hang in `PyInit__dlib_pybind11`. gdb shows `pthread_once` calling an init routine that tries to `PyEval_AcquireThread` while the same thread already holds the GIL. The recognizer's `init_face_recognizer()` returns None gracefully when `encodings.pkl` is missing, so the worker boots fine without dlib — just don't try to run the encoder or load encodings until dlib is unblocked (pin to v19.x or swap to InsightFace; see `memory/jetson_dlib_no_cuda.md`).
- **`init_face_recognizer()` lazy-imports `face_recognition` only when `encodings.pkl` exists** — keep that gate. If you eagerly import the library at worker startup, the worker will hang on every Nano boot until the dlib bug is fixed.
- **Heartbeat metrics whitelist** (`server/app/routes/_internal.py::_ALLOWED_METRIC_FIELDS`). Adding a new metric to the worker without adding it here silently drops the field; tests in `server/tests/test_internal.py` pin both directions.
- **Visibility-aware channels in the client**: three independent listeners are wired to `document.visibilitychange` and together close the mobile-resume gap. Don't rip any one out without considering the other two — they cover three orthogonal channels.
  - `client/src/lib/useStatus.ts` (iter-37): pauses `getStatus` polling on `hidden`, resumes with an immediate tick on `visible`. Saves CPU/battery while backgrounded.
  - `client/src/pages/Events.tsx` (iter-157): re-runs `fetchEvents` on `visible` so events that arrived while the WS was closed are pulled from server-side history (deque maxlen=200).
  - `client/src/components/ConnectionBanner.tsx` (iter-158): calls `reconnectIfClosed()` from `lib/ws.ts` on `visible`, cancelling any pending exponential-backoff timer (capped at 30 s) so the banner clears within RTT instead of up to half a minute. The banner is always mounted, so this is the single global wiring point.
  - **Companion (NOT a visibility listener):** the WHEP video channel closes its own resume gap via `connectionstatechange` rather than `visibilitychange` — see iter-162 `client/src/components/VideoTile.tsx`. WebRTC's own peer-connection events fire when MediaMTX restarts / Wi-Fi blips / NVENC stalls, independent of tab visibility. Conceptually the fourth orthogonal channel; mechanism is different so it's not wired through the visibility hub.
- **WHEP mid-stream observability** (iter-162, `client/src/components/VideoTile.tsx`): a `connectionstatechange` listener on the peer connection flips `Status` to `'error'` on `failed` / `disconnected` / `closed`. Manual recovery only (Retry button bumps `retryNonce`, re-runs the effect) — **no auto-retry**, because (a) a persistent network outage would tight-loop, and (b) WebRTC `'disconnected'` can recover to `'connected'` on its own per spec. Don't add auto-retry without bounding via the iter-158 WS exponential-backoff pattern (capped at 30 s).
- **WebSocket Origin gate** (iter-168, `server/app/routes/events.py`): `_origin_matches_host` does same-origin validation via FULL `urlparse(origin).netloc` equality (NOT prefix match). On mismatch or missing Origin, the handshake closes with code 1008 (Policy Violation) BEFORE `ws.accept()`. Browsers always send Origin on WS upgrades; the WS endpoint has no non-browser consumer (the worker uses REST `/api/_internal/*`). Don't soften to prefix-match or skip-on-missing — that's the whole iter-168 defense against a malicious LAN page subscribing to live detection events. The 1008 close gives the iter-158 client reconnect logic a clean failure-mode signal; do not change to a different close code without re-checking the client side.
- **Server container resource caps + recovery directives** (iter-167, `deploy/docker-compose.yml` + `deploy/systemd/homecam-server.service`): server container has `mem_limit: 512m` + `mem_reservation: 256m` so a leak self-OOMs and `restart: unless-stopped` recovers it instead of OOM-killing the host-side `python3 detect.py`. systemd unit has `Restart=on-failure`, `RestartSec=10`, `StartLimitBurst=3`, `StartLimitIntervalSec=300`, `TimeoutStopSec=30` — symmetric with mediamtx/detect units. Don't drop these without re-thinking the recovery story; on a 2 GB Nano they're load-bearing.
- **VAPID key load is fault-tolerant** (iter-170, `server/app/services/push_service.py::load_keys`): `priv.read_bytes()` and `_read_public_key_b64(pub)` are wrapped in a try/except catching `(OSError, ValueError, TypeError)`. On corrupt/unreadable keys, both `private_pem` and `public_key_b64` are reset to None and a warning logs the exception class name. The server then starts cleanly with push disabled (`send_all` no-ops on `private_pem is None`). Pre-iter-170 a corrupt PEM crashed the FastAPI module-import chain. Symmetric with iter-99 `_safe_float` and iter-109 `_is_valid_loaded_sub` patterns: persisted-state errors must never break startup.
- **Auth track (iter-181..186) sharp edges:**
  - **Default-authed `client` test fixture** (iter-184, `server/tests/conftest.py`): the `client` fixture auto-seeds `testuser/testpass` and POSTs `/api/auth/login` BEFORE yielding the TestClient, so existing tests pass through the iter-184 auth gate without a 250-edit fixture migration. Tests that pin 401-on-anonymous behavior MUST explicitly use the `client_anon` fixture instead — convention not enforced by code, the load-bearing pin is `tests/test_auth_gating.py`. New gate-tests should follow the iter-185/186 examples (e.g., `test_websocket_rejects_anonymous_handshake(client_anon)`).
  - **`tokens.decode(token, kind='access' | 'refresh')`** (iter-181, `server/app/auth/tokens.py`): the `kind` claim is the load-bearing access/refresh boundary — PyJWT considers a kind-mismatched token "valid" (signature passes), so `decode` re-checks the claim itself and raises `InvalidToken` on mismatch. A refresh token presented in the access cookie slot MUST 401 even though the signature is valid; same in reverse. Pinned by `test_auth_tokens.py::test_decode_rejects_kind_mismatch_*`.
  - **WS close-1008 has NO auto-retry** (iter-182, `client/src/lib/ws.ts`): the close handler early-returns on `ev.code === 1008` instead of scheduling the iter-158 exponential-backoff reconnect. Applies to BOTH the iter-168 origin gate and the iter-185 auth gate (both use 1008). On 1008 close ws.ts also dispatches a window-level `homecam:auth-failed` CustomEvent so the AuthProvider can re-check `/api/auth/me` and self-heal (iter-185).
  - **Window-level auth signals** (iter-185/186): `lib/ws.ts` dispatches `homecam:auth-failed` on WS 1008 close → `lib/auth.tsx` re-checks `/me` → on 401 flips to anon (origin-gate 1008 stays authed; auth-gate 1008 redirects to /login). `lib/api.ts::_attemptRefresh` dispatches `homecam:session-expired` on `/api/auth/refresh` 401 → `lib/auth.tsx` toasts "Session expired" + flips to anon (functional-setState dedupes burst). The two signals are distinct: auth-failed re-checks; session-expired flips directly. Don't merge them — origin-gate 1008 must NOT toast.
  - **`/api/_internal/*` carve-out** (iter-184, Charter lock-in): the iter-184 `Depends(get_current_user)` gate is wired on `control` + `push` routers (router-wide) and `events.list_events` (per-route, so its WS sibling `events_ws` stays carved-out for Phase 6's separate handshake gate). `/api/auth/*` gates itself (login is the way IN; me/refresh/logout read cookies directly). `/api/_internal/*` is never gated — host-side detection worker posts events here without auth, by design. Don't add `dependencies=[...]` on the `_internal.router` include.
  - **Worker config-poll mirror at `/api/_internal/detection/config`** (iter-244, fix-forward from the iter-244 deploy that surfaced the latent bug). The user-facing GET `/api/detection/config` lives in `control.py` and is router-wide-gated by the iter-184 `Depends(get_current_user)`. Pre-iter-244 the worker's config-poll thread (`detection/detect.py::start_config_poll`) hit that gated route and 401'd silently — `[detect] config poll failed: HTTP Error 401: Unauthorized` in the worker journal. Worker fell through to compiled-in defaults (graceful) but never observed user-driven threshold / enabled changes. iter-244 added an unauth GET mirror at `/api/_internal/detection/config` (`server/app/routes/_internal.py::worker_detection_config`) returning `asdict(detection_config.get())` — same shape, same data, no auth. Worker URL composer now strips `/event` not `/_internal/event` so it stays inside the carve-out. **DO NOT** "consolidate" by deleting the user-facing route or by un-gating it; the user-facing route stays for the Settings UI's PATCH path which (correctly) requires owner role. Keep both. Tests pin the contract: `test_when_worker_polls_internal_detection_config_then_returns_canonical_shape`, `test_when_anonymous_client_polls_internal_detection_config_then_carve_out_returns_200`, `test_given_user_patches_config_when_worker_polls_internal_then_new_threshold_observed`.
- **`/metrics` is at root, NOT `/api/*`** (iter-189, `server/app/routes/metrics_prom.py`): Prometheus exposition-format endpoint mounted via `app.include_router(metrics_prom.router)` with no `prefix=` and no `dependencies=` — the route is OUTSIDE the iter-184 auth gate by design. Scrapers don't speak browser cookies; operator-side fronting (Tailscale, Caddy basic-auth, firewall rule) is the exposure-control tier. Don't move it under `/api/*` without re-thinking the scrape-from-Grafana story. Hand-rolled exposition format (no `prometheus_client` dep) — if histograms or summaries are ever needed, swap to the library then; the `_line()` helper is ~30 lines to convert.
- **`/healthz` is at root, NOT `/api/*`** (iter-195, `server/app/routes/healthz.py`): Docker / K8s liveness probe endpoint. Same exposure-tier reasoning as `/metrics` — probes don't speak cookies. The previous `deploy/docker-compose.yml` healthcheck hit `/api/status`, which iter-184's auth gate silently broke (cookieless curl → 401 → container reports unhealthy after deploy). iter-195 introduces `/healthz` and updates the compose healthcheck. Don't gate it; don't move it under `/api/*`. Semantics: "FastAPI event loop is alive" — deeper health checks (worker liveness, camera state, thermal) belong in the authenticated `/api/status` and the unauthenticated `/metrics`.
- **Detection zones** (Feature #5, iter-191/191b/191c) are normalized [0,1] polygon masks persisted as `zones: list[list[list[float]]]` in `DetectionConfig`. Three-way alignment: route Pydantic (`server/app/routes/control.py::_Polygon` Annotated bounds 3-32 vertices, coords [0,1]) ↔ service-layer validator (`detection_config.py::_valid_zones` belt-and-braces for disk-load) ↔ worker filter (`detection/zones.py::any_box_center_inside_any_zone` 3.6-compat duplicate of the algorithm). Empty zones list = no spatial gating (default, pre-iter-191 behaviour). The duplicated `point_in_polygon` (server `detection_config.py` 3.10+ syntax + worker `zones.py` 3.6-compat) is intentional — sharing requires pinning the worker syntax limit on the server, which is a worse trade. The client `<ZoneEditor>` (`client/src/components/ZoneEditor.tsx`) renders SVG (NOT canvas) with `viewBox="0 0 1 1"` so [0,1] coords are the SVG's native space. iter-191c chose SVG over the original `feature_ideas` `<canvas>` plan; declarative polygons + easier event handling.
- **Per-user RBAC** (Feature #3, iter-192/196/197/198) layers role on top of the auth track. `tokens.issue(username, kind, *, role='admin')` puts role in JWT claims; `dependencies.get_current_user_role()` returns `(username, role)`; `dependencies.require_role(required)` factory returns a 403-on-mismatch dep. `ROLE_VOCAB = ("owner", "family", "viewer", "admin")`; `admin` retained for legacy iter-178/179 seeded users. **Transitional `admin`-as-`owner` carve-out** lives in BOTH `require_role` (server) and `Settings.tsx::isOwner` (client) — both sides MUST drop together when the eventual cleanup iter migrates seeded users to explicit `owner`. Tests pin the carve-out (`test_require_role_owner_accepts_legacy_admin`, `test_reboot_legacy_admin_passes`, the iter-198 client `shows Reboot Jetson button for legacy admin role`) — they fire as the wakeup signal when the carve-out is removed.
- **Grafana dashboards live in `deploy/grafana/dashboards/`** (iter-199, opt-in compose extension `deploy/docker-compose.grafana.yml`). Every PromQL `expr` referenced in dashboard JSON MUST cite a metric name `metrics_prom.py` actually exposes — `server/tests/test_grafana_dashboards.py` cross-validates via regex extraction on both sides. Drift between dashboards and exposition silently renders "No data" in Grafana — the cross-validation test catches it at CI time instead. Don't add a dashboard panel referencing a metric you haven't yet added to `metrics_prom.py`.
- **Sequential per-feature work convention** (iter-197 user directive, `memory/feedback_sequential_features.md`): while a feature has unfinished slices, the /loop's next iter MUST default to that feature's next slice — no interleaving slices across multiple features. Per-feature state lives in `memory/feature_<N>_state.md`; the audit cycle remains the exception (iter-200 fires regardless of in-flight status because it's the project-level synthesis pass). Don't pivot mid-feature unless the iter discovers a fix-first regression (iter-184 silent break pattern).
- **`users.db` mode 0o600 pre-create** (iter-183, `server/app/auth/users_db.py::init_db`): the file is atomically created with mode 0o600 via `os.open(path, os.O_CREAT | os.O_RDWR, 0o600)` BEFORE `sqlite3.connect` opens it — closes the iter-180 Minor S1 chmod-after-create race. Mirrors the iter-178 `jwt_secret._generate_and_write` pattern. The post-connect `path.chmod(0o600)` belt-and-braces stays for legacy DBs upgraded from pre-iter-183 installs.
- **Stub-with-note pattern for operator-deferred routes** (`server/app/routes/control.py`): `/api/system/reboot` (iter-197), `/api/system/backup` (iter-210), `/api/system/restore` (iter-212). Each returns `{"ok": True, "note": "scaffold: <verb> is stubbed"}` until the host-helper is wired by the operator (NOPASSWD sudo entries + scripts in `deploy/scripts/` — operator deploy queue). Client (Settings.tsx) branches on `r.note` to show an honest "stubbed — nothing happened" toast instead of pretending success. Don't drop the `note` field from the response when wiring the helper — instead, REMOVE the field entirely so the client's truthy check flips. Never substitute "" or "ok" for a real `note` in the stub path; the assertion `"stub" in body["note"].lower()` in `test_control.py` pins the wording.

- **`/api/system/timelapse` was wired up at iter-306** (was iter-213 stub-with-note). `server/app/services/timelapse.py` queries `events_db` for clips on the given local-time day → writes a concat list → invokes ffmpeg via subprocess. Deploy choice: ffmpeg lives **in the container** (added to `deploy/Dockerfile.server` apt install — `+80 MB` image growth) NOT on the host via sudo. Reason: host-side helpers require NOPASSWD sudo widening + chroot path translation; the container has bind-mounted `recordings/` + `timelapses/` already, so the in-container path is cleaner. The route still returns `{ok: True, note: ...}` for the no-clips path + ffmpeg-failure path (so the iter-211 client toast pattern still surfaces honest errors), but on success returns `{ok: True, date, url}` with NO `note` (client truthy-checks `r.note`, so dropping it flips the toast to success). Concat is `-c copy` (no re-encode) — fast (~0.1s/clip) and lossless. `+faststart` flag puts moov atom up-front for inline browser play. **Don't** switch to true-timelapse mode (`-vf "setpts=0.2*PTS"` + re-encode) without first adding a per-second snapshot sampler thread to detect.py — today's `latest.jpg` is overwritten per second, so there's no per-second archive to sample from. The current "concat all of today's event clips" matches the Settings UI copy ("speed up a whole day of camera footage into a short video you can scan in seconds") because if a day had 30 events of 5-15s each, the resulting video IS short relative to 24h.
- **Backup/restore path-traversal two-tier defense** (iter-212, `server/app/routes/control.py::system_restore`): `_RestoreBody.backup_path` has a Pydantic regex `^[A-Za-z0-9_./-]+$` (rejects shell metas, whitespace) — friendly 422 path. THEN a substring check rejects `..` (400) AND a `Path.resolve().relative_to(settings.backup_target_dir.resolve())` check rejects anything that escapes the target root (400). The regex permits `.` and `/` (legitimate filename + subdir uses), so the resolve+relative_to is the actual security guarantee. Mirrors the iter-? SPA traversal-guard in `app/main.py::spa`. When wiring the host-helper (slice 4), keep BOTH tiers — don't trust user input even after a regex pass.
- **Static `/timelapses` mount + listing-regex defense** (iter-213, `server/app/main.py` + `server/app/routes/control.py::list_timelapses`): timelapses MP4s are served via `StaticFiles(directory=settings.timelapses_dir)` mounted at `/timelapses` — same pattern as the existing `/snapshots` mount. The listing route only matches strict `^[0-9]{4}-[01][0-9]-[0-3][0-9]\.mp4$` filenames; an operator dropping random files (READMEs, partial `.tmp` files, symlinks) is filtered out — so even if the dir is shared with the host-helper write path, only well-formed timelapse files appear in the listing. The regex pattern `_DATE_PATTERN` in `control.py` is the same regex used for the POST trigger body validation; if a future iter adds time-of-day or per-camera variants to the filename, both ends must update together.
- **`localhost` bypass risk on backup/restore in dev** — `_patch_backup_target` in `tests/test_control.py` monkeypatches `settings.backup_target_dir` per-test; production `BACKUP_TARGET_DIR` defaults to `./backups` (relative to server CWD). When operator deploys, MUST set `BACKUP_TARGET_DIR` to a path on the homecam-secrets volume OR a mounted USB drive — `./backups` resolves to wherever the docker WORKDIR is, which is fine for the stub but the slice-4 host-helper expects a stable path. Mirrors the iter-? `PUSH_SUBS_PATH` deployment caveat.
- **`events_db` ↔ `event_bus` circular-import dance** (iter-216..218, `server/app/services/event_bus.py::_persist_event` + `recent`): `events_db` imports `DetectionEventDict` from `event_bus`, so `event_bus` can't import `events_db` at module top — that's a cycle. Both write-through (`_persist_event`) and read (`recent()`) lazy-import `events_db.insert_event` / `events_db.recent` + `..config.settings` inside the function body. Don't hoist the imports to module-level. Bus `publish` write-through wraps the insert in try/except so SQLite hiccups don't break WS fanout (logs once per process via `_persist_warned` flag, resets on success); read `recent()` falls back to `[]` on exception so a corrupt DB doesn't 500 `/api/events`. Persistence failure is fully visible since iter-218 (deque was dropped); the live WS fanout is the only remaining safety net for in-flight events when SQLite is down.
- **`_isolate_events_db` autouse fixture cost** (iter-217, `server/tests/conftest.py`): per-test SQLite `init_db` + WAL setup roughly doubled server suite duration (55s → 107s). Acceptable for now — required for test isolation since `event_bus.publish` write-through hits `settings.events_db_path`. If a future iter adds a large test cohort and the suite passes ~3 min, swap to a session-scoped `tmp_path_factory` DB + per-test `events_db.reset()` truncate. Same shape as the iter-? push_service test fixture.
- **`/api/events/search` cursor + empty-filter semantics** (iter-219, `server/app/routes/events.py::search_events` + `server/app/services/events_db.py::search`): `before_ts` cursor is strict `<` (NOT `<=`) so a tied-ts pair doesn't appear on both pages; an empty-string filter (`?camera_id=`) matches NO rows (exact equality on `""`, NOT "match all"); `next_cursor: null` on last page so the client knows to stop paginating. Distinct semantics — don't soften any of them without re-checking the iter-220 client `loadMore` + iter-219 cursor tests.
- **EventBus.recent reads from SQLite, deque is gone** (iter-218, `server/app/services/event_bus.py::recent`): pre-iter-218 the bus had an in-memory `deque(maxlen=200)` history; iter-218 dropped it cleanly since the only non-test caller (`/api/events` route) is wire-shape-stable across the swap. `recent()` lazy-imports `events_db.recent`, returns `[]` on exception (read-side fail-open). `EventBus.reset()` is now a no-op kept for `tests/conftest.py::_reset_event_bus` API stability — per-test events_db isolation via `_isolate_events_db` is the actual cleanup. Don't reintroduce a deque "for performance" without measurement; SQLite reads cost ~ms.
- **Heatmap day-bounds use local-time `new Date(year, monthIdx, day)`** (iter-223, `client/src/components/EventHeatmap.tsx::dayBounds`), NOT `Date.parse('YYYY-MM-DD')` which interprets the string as UTC. Same convention as iter-222 server SQLite `date(ts, 'unixepoch', 'localtime')` modifier — both ends use the running process's local time. If operator deploys without setting `TZ=...` in compose, the container runs UTC; the client runs the user's local TZ. Mismatch → off-by-one days at TZ boundaries. Documented on iter-222/223 risks; operator action.
- **`face_unrecognized` mutually exclusive with `person_name=...`** (iter-227/228, `server/app/services/events_db.py::search` + `count_by_day`, `client/src/lib/api.ts::EventSearchFilters`): both filters can be passed simultaneously but the SQL composes to `WHERE person_name = ? AND person_name IS NULL` which always returns 0 rows. Sentinel of "you confused yourself," NOT a 422 — the iter-221 client UI gate (chip is exactly one of `'all' | '__unknown__' | <name>`) is the actual enforcement. Don't add a 422 server-side without re-thinking the client gate.
- **`/api/events/export` 50-event cap + Semaphore(2)** (iter-330 + iter-337, `server/app/routes/clips.py`): `_EXPORT_MAX_IDS = 50` is enforced at the Pydantic body validator (`_ExportBody.event_ids: List[str] = Field(..., min_length=1, max_length=50)`) AND `_EXPORT_SEMAPHORE = asyncio.Semaphore(2)` caps CONCURRENT zip builds at 2 across all clients. The 50-cap bounds per-request RAM (~10 MB at 50 × 200 KB clips); the Semaphore bounds thread-pool pressure (Nano's default asyncio thread pool is 8; without the cap, 8 simultaneous exports block heartbeat DB writes + events search + people list). Don't raise the 50-cap without first switching to streaming `zipfile.ZipFile` over a chunked generator (the in-route comment notes the threshold is ~200). Don't drop the Semaphore without re-thinking the multi-client failure mode — the export route is the only RAM-heavy long-blocking surface in the API.
- **iter-332 SW `actions` use `clientsClaim` immediate-takeover** (`client/src/sw.ts`, vite-plugin-pwa `registerType: 'autoUpdate'` + `skipWaiting()` + `clientsClaim()`): a fresh client/dist deploy via rsync activates the new SW IMMEDIATELY on all open clients (not on next page-load as the docs say for the bundle). For iter-332 specifically: a phone with a stale SW will silently drop the `dismiss` notification action (it falls through to default open-app), but the auto-takeover narrows the window to ~seconds post-rsync. Awareness only — the existing CLAUDE.md "auto-updates on next page-load" line refers to the JS bundle, not the SW.
- **iter-334 `/snapshots/thumb_<digits>.jpg` unauth carve-out** (`server/app/main.py::snapshots_unauth_thumb_or_redirect` + `_THUMB_FILENAME_RE = ^thumb_[0-9]+\.jpg$`): push notification hero images need to be reachable WITHOUT cookies because the OS push daemon (Android Chrome / Firefox push) cannot carry the iter-184 HttpOnly auth cookie when fetching the notification's `image:` field. iter-318 308-redirected the entire `/snapshots/` tree to auth-gated `/api/snapshots/`, breaking the iter-188 push-image feature silently for ~16 iters until iter-333's broad security audit caught it. iter-334's carve-out: ONLY filenames matching `^thumb_[0-9]+\.jpg$` (digits-only between `thumb_` and `.jpg`) serve unauthenticated; latest.jpg, snap_*.jpg, and anything else continue to 308-redirect to `/api/snapshots/` (auth-gated). Don't widen the carve-out to `[A-Za-z0-9_-]+` even if a future thumb-naming scheme uses dashes — the unauth surface scales with the regex permissiveness. If the worker's `save_thumb` filename pattern changes, narrow `_THUMB_FILENAME_RE` AT THE SAME TIME and update the test pin in `test_snapshots_route.py`.

### Tests as a contract surface

- The client's lib tests pin the wire shape (`/api/...` URLs, request bodies, the Push-subscription JSON). When you change a route or payload on the server, expect to update both `client/src/lib/api.test.ts` and a matching `server/tests/test_*.py`.
- Prefer `getByRole` / `getByLabelText` over `getByText` so refactors don't break tests. New interactive elements need accessible names — that's also what `eslint-plugin-jsx-a11y` is enforcing.

### BDD-lite test convention (iter-243 onward)

All NEW tests use this shape. Existing tests migrate on touch (no big-bang rewrite).

**Naming.** The test-name string MUST read as a behavior sentence in one of these forms:

- `it('given <preconditions>, when <action>, then <observable outcome>')`
- `it('when <action>, then <observable outcome>')` — when no preconditions are interesting.
- `it('returns <outcome> when <condition>')` / `it('rejects <input> when <condition>')` — verb-first form is acceptable when it reads more naturally than the full GWT shape.
- Python: `def test_when_<action>_then_<outcome>(...):` — same idea, snake_case. Or `def test_returns_<outcome>_when_<condition>(...):`.

What this rules out: bare-fact names like `it('refreshes')`, `it('works')`, `test_login`. The name must say what BEHAVIOR is verified, not what FUNCTION is called.

Good (pre-iter-243 examples that already match):
- `it('shows em-dash when getServerVersion rejects (iter-234)')`
- `def test_decode_rejects_kind_mismatch_access(...)` — verb-first, observable outcome.
- `it('caps the in-memory event list at 200 entries')`

Bad (would not pass agent review):
- `it('handles errors')` — what error, what outcome?
- `def test_login(...)` — what about login?
- `it('works correctly')` — describes nothing.

**Body structure.** Three blocks separated by blank lines, each with a one-line comment header (`// arrange`, `// act`, `// assert` in TS; `# arrange`, `# act`, `# assert` in Python). Helper-only tests (a single line that does both act and assert, e.g. `expect(formatBytes(0)).toBe('0 B')`) are exempt — keep those one-liners.

```ts
it('returns 304 when If-None-Match matches the response ETag (iter-240)', async () => {
  // arrange
  const initial = await client.get('/api/events/count_by_day')
  const etag = initial.headers.get('ETag')!

  // act
  const second = await client.get('/api/events/count_by_day', {
    headers: { 'If-None-Match': etag },
  })

  // assert
  expect(second.status).toBe(304)
  expect(second.headers.get('ETag')).toBe(etag)
})
```

```python
def test_when_corrupt_pem_loaded_then_private_pem_is_none(tmp_path):
    # arrange
    bad_key = tmp_path / "vapid_priv.pem"
    bad_key.write_bytes(b"not a real pem")

    # act
    push_service.load_keys(bad_key, tmp_path / "vapid_pub.txt")

    # assert
    assert push_service.private_pem is None
```

**Migration policy.** When an iter edits an existing test for any reason (assertion change, fixture swap, new case added), rename + restructure it to BDD-lite at the same time. Don't migrate untouched tests on a separate cleanup pass — the on-touch policy keeps the diff narrow.

**Enforcement.** The two `.claude/agents/` auditors (test-integrity-auditor, test-coverage-auditor) flag non-compliant NEW tests. Pre-iter-243 tests that haven't been touched are NOT flagged — they're grandfathered until they get edited.

**Why no Gherkin / pytest-bdd / jest-cucumber.** This project is solo-developer with no PM/QA reading specs; the Gherkin-feature-file layer adds ~30-50% per-iter overhead with no audience to consume it. Tighter naming + AAA bodies captures the readability win at zero tooling cost. If a future iter has a stakeholder who needs `.feature` files (e.g., for an accessibility audit, compliance review, hand-off to another team), revisit then — limited to the relevant test surface, not project-wide.

## Out of scope (for now)

- ~~Multi-camera~~ **LIFTED at iter-177** — user explicit override. Plan at `memory/multicam_plan_iter177.md`. Single Jetson + many cameras topology, grid + tabs UI. Implementation iter-186+. While this lands, single-camera deploys remain default-supported.
- Two-way audio (Ring talk button) — UI placeholder only, no WebRTC mic upstream yet.
- Cloud relay / remote access — assume Tailscale or LAN. Don't expose the Jetson directly.
- ~~Auth — single-user, LAN-trusted for now.~~ **LIFTED at iter-177** — user explicit override. Plan at `memory/auth_plan_iter177.md`. Per-user JWT auth (sqlite users, HttpOnly cookies, full-page `/login`). `/api/_internal/*` stays unauthenticated (loopback-trusted carve-out). Implementation iter-178+. Hard cutover at Phase 5 (iter-183) — operator must seed a user before that deploys.
- iOS — Web Push on iOS Safari needs homescreen install (16.4+). Targeting Android + desktop browsers first.

**Active mega-roadmap:** `memory/mega_roadmap_iter177.md` — combines auth (7 phases, **DONE iter-181..186**) + multi-camera (8 phases, MC Phase 0 operator-blocked) + 12 product features (3 partial/full as of iter-189: #7 hero thumb in push, #9 thumb-encode observability, #11 Prometheus /metrics endpoint). State-of-the-project at `memory/state_of_the_project_iter190.md` (lightweight inline audit; iter-180 attempted full 7-Manager hierarchy and truncated by API rate limits). Anti-recommendations from prior syntheses still apply (no STUN, no PrivateTmp, no rate-limiting middleware, no GStreamer tee, no eager face_recognition import, etc. — see iter-169 synthesis Section 3 for the full list).
