# HANDOFF — Home Camera System

Snapshot date: **2026-05-03** (iter-356.27 just shipped). For ongoing engineering knowledge read `CLAUDE.md` first; this doc is the time-anchored "where I left off" summary.

---

## 1. What this project is, in one paragraph

A self-hosted Ring-style camera + doorbell PWA. The **Jetson Nano 2GB** with an attached **Raspberry Pi camera** is the SERVER (runs MediaMTX + a FastAPI control plane + a host-side detection worker). Phones and laptops are CLIENTS running the same installable PWA. The PWA is served over **Tailscale** at `https://homecam.tail4a6525.ts.net` (Let's Encrypt cert, no port forwarding) so it works from cellular too. Live video uses **WebRTC via MediaMTX** (~200 ms LAN). Object detection uses **SSD-MobileNet-v2 via TensorRT FP16** on the Jetson GPU; recognized faces flow through optional dlib `face_recognition`. Push notifications via Web Push (VAPID) keep working when the PWA is closed.

**Architecture stack:**
```
RPi Cam → nvarguscamerasrc → nvv4l2h264enc → rtspclientsink
                                                    ▼
                                            MediaMTX :8554 RTSP
                                                    │  ▼
                                            ┌───────┴── :8889 WebRTC
                                            │           │
                                       (re-decode      (browser <video>)
                                        via NVDEC)
                                            ▼
                                  Detection worker (host)
                                  jetson-utils videoSource +
                                  jetson_inference detectNet
                                            │
                                            ▼  POST /api/_internal/event
                                  FastAPI (Docker container)
                                            │
                                  WebSocket │ Web Push
                                            ▼
                                       Client UI
```

Read `CLAUDE.md` § "Architecture" for the full picture. The Jetson is reachable from the dev machine via `ssh jetson` (key auth, NOPASSWD sudo). The Jetson rootfs is `sshfs`-mounted at `~/jetson` for direct file work.

---

## 2. Where the code lives

| Folder | What it is | Tests |
|---|---|---|
| `client/` | Vite + React 19 + TS + Tailwind v4 PWA. Mobile-first, **light theme + cat brand** (iter-356.25..27, see § 5 below). | Vitest + Testing Library, **637/637 passing as of iter-356.27**. Run from `client/`: `npm test -- --run`. |
| `server/` | FastAPI app, runs in Docker on Jetson. REST control plane + `/api/events/ws` WebSocket + Web Push delivery + SQLite events store. Python 3.11 in container; tests against `/tmp/homecam-venv` on dev machine. | pytest + FastAPI TestClient, 417 tests as of iter-199 (cycle since hasn't fully audited count). Run from `server/`: `/tmp/homecam-venv/bin/python -m pytest`. |
| `detection/` | Python 3.6 worker on the Jetson HOST (not in container). RTSP → SSD-MobileNet → POST events to server. Optional face-recognition wrapper at `detection/face_recog/`. | 135 stdlib tests (iter-191). 3.6-compat enforced by `tests/test_py36_compat.py` AST scanner. |
| `deploy/` | `Dockerfile.server`, `docker-compose.yml`, `mediamtx.yml`, `entrypoint.sh`, systemd units. | n/a |
| `memory/` | `loop_audit_log.md` (running iter log, **read iter-356.21..27 entries first** for the current thread), `MEMORY.md` (index), `feature_<N>_state.md` (per-feature trackers), state-of-the-project audits, persona/charter docs. | n/a |
| `HANDOFF.md` | THIS document. | n/a |
| `CLAUDE.md` | Engineering bible — sharp edges, conventions, dev-loop guide. **Read this second.** | n/a |

---

## 3. Where work just left off — iter-356.27 (2026-05-03 ~08:28)

**The /loop is currently PAUSED** waiting for user reaction to the iter-356.27 deploy. The next firing of `/loop` will resume the iter-356 mega-overhaul thread — see § 4.

**Most-recent iters in reverse order:**

- **iter-356.27 (just shipped)** — Diagnosed + fixed the latent **Tailwind v4 arbitrary-CSS-var syntax bug**. Sed-wrapped `bg-[--color-XXX]` → `bg-[var(--color-XXX)]` across the entire src tree. Fixed Login.tsx Sign-in button text from `text-[var(--color-text-primary)]` → `text-white` (was invisible: dark-on-orange muddy). Plus toast.tsx error/success bg-fill text → white. **637/637 tests, deployed 08:28.** Browser-harness screenshot confirmed: Sign-in button now renders as bright calico-orange pill with white text.
- **iter-356.26** — Bulk sed across 24 files. `bg-neutral-9XX` → `bg-[var(--color-surface)]` etc. The "make every page interior actually use the light theme" sweep, after Maya called the iter-356.25 chrome-only Phase 1 "broken — worse than yesterday."
- **iter-356.25** — Light theme flip Phase 1: design tokens dark→light (calico cream + warm-dark text + calico-orange accent replacing cold blue). Chrome only (SideNav with CatTrioMark, BottomNav with paw print, ConnectionBanner soft tones, Skeleton warm tiles, App skip-link, PageFallback spinner). Page interiors deferred to .26.
- **iter-356.24** — Sweep Training (× 2) + Review (× 1) plain-text empty states into `<CatEmptyState>` primitive. Plus EventList `cameraOffline` prop + Events.tsx wiring from `useStatus()` so the sleeping-cat empty state pivots to "Camera looks offline" when worker dead OR detection paused (Frank's wife-anecdote carryover).
- **iter-356.23** — Extracted `<CatEmptyState>` primitive (`client/src/components/CatEmptyState.tsx`, ~70 lines + 6 tests). Sleeping calico illustration WITH z-z-z (was plain CalicoSprite blob — Frank: "small colored smear"). 3 first-wave consumers: EventList, People, Timelapses.
- **iter-356.22** — First substantive cat-theme carry-through beyond CatLayer + Login. Events page empty state: generic eye-glyph + "No detections yet" → cat-themed Coco-snoozing empty state. Inline JSX (refactored to primitive in .23).
- **iter-356.21** — Cat physics teleport fix (dt clamp 100→33ms + removed `transition: transform 80ms linear` that was queueing CSS ease against per-frame React updates). Plus baked the cat-theme directive into the loop prompt + memory after the user reminded me it had drifted from earlier sessions.

**Earlier iter-356.X work** (mega UI/UX overhaul, ~iter-356.0..20): design-token foundation, Login redesign, `<Button>` primitive + sweep, CatLayer with Panther/Mushu/Coco, ambient walking layer + Settings toggle, cold-load FOUC fix with `LivePageSkeleton`, ClipModal event-header bar, Live action-panel hierarchy, People page polish, etc. Each is a row in `memory/loop_audit_log.md`.

---

## 4. The /loop autonomous mode + the iter-356 mega-overhaul

**Operating mode:** the user has been running `/loop <prompt>` (Claude Code skill, defined in `bundled:loop`). Each /loop firing picks ONE substantive target, ships it (test + build + rsync to Jetson), spawns 3 background auditors (Maya BRUTAL polish + Frank ux-grandpa + Priya mobile-desktop coherence), logs to `memory/loop_audit_log.md`, schedules the next wakeup.

**Active loop prompt (since iter-356.21, see `memory/loop_directives.md`):**

> "keep iterating on the MAJOR UI overhaul + CAT THEME (iter-355c1 mandate, see memory/feedback_major_ui_overhaul.md). Each iter must move the needle toward paid-SaaS-tier polish AND carry the user's three real cats — Panther (Bombay), Mushu (Tuxedo), Coco (Calico) — through the brand identity (logo, mascot, copy, chrome, microcopy where natural). Pick one substantive target..."

**The mandate** (from `memory/feedback_major_ui_overhaul.md`, iter-355c1): user said "I would not pay for this level of UI/UX. The UI/UX needs a major overhaul to be super polished." Subsequent reinforcements: "i meant it" → "I want a full theme, meaning background, icons, personal touches, paw prints in places. go with option A." (Option A = light theme).

**Acceptance gate:** Maya returns zero Critical/Major OR user types "ship it." We are NOT at acceptance — see § 8.

**The audit cycle** (CLAUDE.md § "The audit cycle"): every ~50 iters or when the roadmap thins, spawn 7 Domain Manager sub-agents (Frontend / Backend / Detection / Infra / QA / Security / Docs) for a state-of-the-project synthesis. Last full cycle was iter-235 (`memory/state_of_the_project_iter235.md`). Next cycle should fire around iter-285 OR when the iter-356 mega-overhaul is closed out — whichever first.

---

## 5. The light-theme flip + cat brand identity (the big iter-356.25..27 thing)

**Pre-iter-356.25:** dark Ring-doorbell-style theme. Near-black `#0a0a0a` page bg, dark-grey cards, white text, cold blue `#2196f3` accent.

**Post-iter-356.27 (current state):** **light + warm + cat-themed**. All tokens in `client/src/index.css` `@theme` block:

| Token | Value | Where it shows |
|---|---|---|
| `--color-bg` | `#faf6ee` calico cream | Page background everywhere |
| `--color-surface` | `#ffffff` white | Cards, modals, SideNav, BottomNav |
| `--color-surface-raised` | `#f5efe3` warmer cream | Hover/selected, input bg, skeleton tiles |
| `--color-text-primary` | `#1a1410` warm near-black | Headings, body text on neutral surfaces |
| `--color-text-secondary` | `#5d564b` warm mid-grey | Metadata, sub-labels |
| `--color-text-tertiary` | `#6b6358` warm-mid | Hints, timestamps (~4.7:1 AA) |
| `--color-accent-default` | `#d97706` calico orange | Buttons, links, focus rings, active nav |
| `--color-accent-bright` | `#f59e0b` | Hover state of accent |
| `--color-accent-subtle` | `#fef3c7` cream-yellow | Selected chip / nav row bg |
| `--color-success` | `#047857` emerald-700 | Face match badges, success toasts |
| `--color-warning` | `#b45309` amber-700 | Thermal pills, connecting state |
| `--color-danger` | `#b91c1c` red-700 | Destructive buttons, error pills |
| Tinted-surface tokens | `color-mix(...)` | Soft success/danger/warning bg fills |
| Shadows | `rgb(60 40 20 / 0.08-0.18)` | Warm brown low-alpha for paper feel |

**The three cats** (Panther / Mushu / Coco — user's real cats):

| Cat | Sprite | Personality | Where seen |
|---|---|---|---|
| **Panther** | `BombaySprite` (mostly black with yellow eyes) | Aloof, judgmental | CatLayer ambient walker; CatTrioMark logo |
| **Mushu** | `TuxedoSprite` (white face + black body) | Playful instigator | CatLayer; CatTrioMark |
| **Coco** | `CalicoSprite` / `SleepingCatIllustration` | Sleepy, cuddly | CatLayer; CatTrioMark; **the empty-state mascot** (sleeping pose) |

**Where the cats land:**

- `client/src/components/CatIcons.tsx` — sprite library (`BombaySprite`, `TuxedoSprite`, `CalicoSprite`, `CatTrioMark`, `SleepingCatIllustration`)
- `client/src/components/CatLayer.tsx` — ambient walking strip at the bottom of every authed page (Settings → Account toggle, defaults on)
- `client/src/components/CatEmptyState.tsx` — the universal empty-state primitive (default illustration = sleeping Coco with z-z-z)
- `client/src/components/SideNav.tsx` — CatTrioMark next to "Home Camera" wordmark, paw indicator on active row
- `client/src/components/BottomNav.tsx` — paw-print SVG above active tab label
- `client/src/pages/Login.tsx` — large CatTrioMark above "HomeCam" + "Watching the door so the cats don't have to. / Panther, Mushu & Coco" subtitle
- `client/src/index.css` — `--paw-svg` shared variable + `.paw-active::before` (SideNav) + `.bottomnav-paw-active::after` (BottomNav)

---

## 6. The Tailwind v4 CSS-var bug (recent discovery — read this!)

**Symptom:** `bg-[--color-accent-default]` lints clean, typechecks clean, the class IS in the rendered className string, but the computed CSS shows `background-color: rgba(0,0,0,0)` (transparent). Buttons render with no fill. Skip-link is invisible. Card borders disappear.

**Root cause:** Tailwind v4's arbitrary-value bracket `[...]` does NOT auto-resolve naked CSS-var references. Naked `--var` is treated as a literal token and silently dropped. Must wrap in `var()`:

| WRONG (silent failure) | RIGHT |
|---|---|
| `bg-[--color-accent-default]` | `bg-[var(--color-accent-default)]` |
| `text-[--color-text-primary]` | `text-[var(--color-text-primary)]` |
| `border-[--color-border]` | `border-[var(--color-border)]` |
| `outline-[--color-accent-default]` | `outline-[var(--color-accent-default)]` |
| `divide-[--color-border]` | `divide-[var(--color-border)]` |

**Affected lifetime:** the bug was latent since iter-356.0 (the design-token foundation). It was MASKED by the dark theme — most components used hardcoded `bg-neutral-9XX` Tailwind classes that bypassed tokens entirely. The iter-356.25 light-theme flip exposed it everywhere because suddenly the tokens needed to actually resolve.

**Fix scope:** iter-356.27 sed-wrapped every site in the codebase. Any NEW arbitrary-CSS-var class added going forward must use the `var()` form. Lint doesn't catch this — Tailwind v4 silently accepts both forms.

**How it was caught:** **browser-harness** (just installed, see § 9) opened the live PWA in the user's Chrome and `js("getComputedStyle(b).backgroundColor")` returned `"rgba(0, 0, 0, 0)"` despite the className containing the orange-bg token class. Maya audits (4 of them) never caught this because they read code. Visual verification was load-bearing.

---

## 7. The iter-356.21..27 invisible bugs that the bulk sed introduced (and one that wasn't a bulk-sed fault)

When iter-356.26's bulk sed replaced `text-white` → `text-[var(--color-text-primary)]` everywhere, it broke buttons + toasts that needed white text on a colored fill (orange button bg, red error toast bg, green success toast bg). The Button primitive's primary variant + toast.tsx error/success kinds + Login.tsx hand-rolled Sign-in button all rendered invisible-on-orange. **iter-356.27 reverted those specific spots back to `text-white`.**

**General rule going forward:**
- Text on a TOKENIZED neutral surface (white card, cream bg, surface-raised hover) → `text-[var(--color-text-primary)]` etc.
- Text on a SEMANTIC FILL (accent-default orange button, danger red toast, success emerald toast) → **`text-white`** (deliberate, not a token, because the dark mode is gone and white is universally readable on these saturated fills)

If you add a new colored-fill component, follow this rule. Don't auto-tokenize text color when the bg is a saturated semantic.

**Components that have been re-verified visually (browser-harness screenshot):**
- Login page — confirmed working iter-356.27
- SideNav (chrome) — visible in Login screenshot, working

**Components that have NOT been re-verified visually:**
- Live page interior (action panel, VideoTile, LiveStats card, JetsonSection toggles)
- Events page interior (EventCards, ClipModal, EventHeatmap, day headers)
- People page (PersonCards, search input, train links)
- Settings page (Tabs, parts.tsx, NotificationsSection, JetsonSection, DangerZone, UserMgmt, TimelapsesSection, DetectionSection, Slider, ZoneEditor)
- Training page (visitor photos, per-person galleries)
- Review page (uncertain face queue)

**These ALL went through the iter-356.26 bulk sed + iter-356.27 var() wrap.** They _should_ be working. But the only one I've visually verified is Login. **A natural iter-356.28 = walk every page in browser-harness with a logged-in session and screenshot each, fix invisible elements as found.** This requires either (a) a dev account login I can scripts, or (b) the user logs in once in their Chrome and the cookie carries to browser-harness.

---

## 8. Outstanding auditor findings — open Maya / Frank / Priya items not yet shipped

Across iter-356.22..24 audits, the auditors flagged these. Most are still open as of iter-356.27.

**iter-356.24 Maya audit (read `loop_audit_log.md` iter-356.24 for full text):**
- **Minor M1**: EventList camera-offline heuristic conflates "worker dead" (restart needed) vs "user toggled detection off" (just turn back on). Both currently get "restart the camera box" copy. Need to split into 2 branches with distinct copy.
- **Nit N1**: EventList offline hint reads "restart the camera box OR check that detection is turned on in Settings." Reads as "do both." Split into two sentences.
- **Nit N2**: Training dirs-empty hint says "Check that face recognition is turned on in Settings." There's NO toggle for face recognition (gated on `detection/face_recog/encodings.pkl` existence — see CLAUDE.md sharp edges). Copy promises something that doesn't exist.

**iter-356.24 Frank audit:**
- **G1**: "Check Settings" in offline + Training hints should be a tappable React Router `<Link>`, not plain text. One extra tap → zero.
- **D1**: Review body needs "...you'll see it here so you can tell the camera who it is." Currently doesn't describe the user's physical action.

**iter-356.24 Priya audit:**
- **D1 (carryover from .22 + .23)**: Events desktop layout still renders `CatEmptyState` in left column + an empty `EventHeatmap` in the right `<aside>`. Two empty surfaces side-by-side reads as broken. Fix: gate the aside on `events.length > 0`.
- **C1**: Review uses `max-w-5xl` but Training uses `max-w-4xl` — sister pages, different desktop band widths. Standardize to `max-w-4xl`.
- **A1**: `<CatEmptyState>` has `role="status"` which re-announces to screen readers on EVERY parent re-render. On Review where parent re-renders during approve/reject, SR users get re-read mid-action. Add `aria-live="off"` for non-transition contexts.

**iter-356.25 Maya audit (light theme Phase 1):**
- **Critical C1** (FIXED iter-356.27): slider styling hardcoded #2a2a2a + #2196f3 thumb (was unfixed in Phase 1; iter-356.27 tokenized).
- **Critical C2** (FIXED iter-356.27): skip-link amber-on-amber (white outline now).
- **Critical C3** (FIXED iter-356.27): paw indicators inconsistent — SideNav was a vertical bar despite class name `paw-active`. Now both use shared `--paw-svg` mask.
- **Critical C4** (FIXED iter-356.27): `.paw-active` class name lied (rendered a bar). Now an actual paw.
- **Major M1**: accent contrast `#d97706` on `#faf6ee` is ~4.42:1 — UNDER WCAG AA 4.5:1 for small text. Currently the button-fill compound (white-text-on-orange) measures ~5:1 which is fine. **But active BottomNav tab label uses `text-[--color-accent-default]` directly** which means dark cream-bg text at 4.42:1 — that's the borderline-fail spot. iter-356.28 candidate: switch primary accent to `#b45309` (amber-700, ~5.7:1) for text use; keep `#d97706` for FILL surfaces only.
- **Major M2** (FIXED iter-356.26 sweep): LiveIcon recording dot was hardcoded `#ef4444`.

**Browser-harness visual finding (not yet auditor-flagged):**
- After iter-356.27 deploy, Login page renders correctly. NO visual audit of /live, /events, /settings, /people, /training, /review yet because the test browser session wasn't logged in. **Highest-confidence iter-356.28 candidate: spawn auditors AFTER walking each page in browser-harness with a logged-in session.**

---

## 9. Tools that just got set up

**browser-harness** (just installed today). Direct browser control via CDP, connects to the user's running Chrome.

- Repo cloned to `~/Developer/browser-harness/`
- Binary at `~/.local/bin/browser-harness` (`uv tool install -e .`)
- Skill imported: `~/.claude/CLAUDE.md` contains `@~/Developer/browser-harness/SKILL.md` so future Claude Code sessions auto-load the helpers
- Connection method: Way 1 (user enabled remote debugging at `chrome://inspect/#remote-debugging`)

**Use cases proven in this session:**
- `browser-harness -c 'goto_url("https://homecam.tail4a6525.ts.net/login"); wait_for_load(); print(capture_screenshot())'` opens the page in user's actual Chrome, screenshots to `/tmp/shot.png`. The Read tool can then load the PNG into context.
- `browser-harness -c 'js("...")'` runs arbitrary JS to inspect computed styles, DOM state, etc. **This is how the Tailwind v4 bug was diagnosed.**
- `browser-harness --doctor` confirms daemon + connection state.

**Key gotchas learned:**
- After lazy-loaded React routes, add `time.sleep(1.5)` before screenshot — `wait_for_load()` only waits for the document load, not the React hydration + Suspense chunk fetch.
- For cache-bust, append a `?nocache=<timestamp>` query string instead of trying to unregister the SW (JS escaping in `-c` is hostile).
- The `js()` helper takes an **expression**, not a statement. Use `(...)` parens around the expression: `js("var b=...; ({a:b.x, b:b.y})")`.

---

## 10. Feature state matrix

12 product features were curated post-scope-expansion (iter-177, `memory/feature_ideas_iter177.md`). State as of iter-356.27:

| # | Feature | State doc | Status |
|---|---|---|---|
| 1 | Event clip recording | `feature_1_state.md` | **PAUSED** at slice 4/5 (iter-204). Remaining work is operator-side. |
| 3 | Per-user RBAC | `feature_3_state.md` | **DONE** (iter-192/196/197/198). Owner / family / viewer / admin roles with require_role decorator. |
| 4 | Notification routing | `feature_4_state.md` | **DONE** through slice 4 (iter-205..209). Per-user push filtering. Slice 5 (zone_id) optional. |
| 5 | Detection zones | (in-code) | **DONE** (iter-191..). Polygon masks, normalized [0,1]. SVG ZoneEditor at `client/src/components/ZoneEditor.tsx`. |
| 6 | Event search + SQLite + heatmap | `feature_6_state.md` | **DONE** dev-side (iter-216..228). Retention sweeper (slice 5) optional. |
| 7 | Hero thumb in push | (folded in) | **DONE** (iter-188 + iter-334 unauth-carve-out for SW push). |
| 8 | Daily timelapse summary | `feature_8_state.md` | **DONE** dev-side (iter-213..214 + iter-306 ffmpeg-in-container). |
| 9 | NVENC thumbs / encode obs | `feature_9_state.md` | **PAUSED** — operator-blocked on Jetson measurement. |
| 10 | Backup + restore | `feature_10_state.md` | **DONE** dev-side (iter-210..212). Slice 4 host-helper deferred to operator. |
| 11 | Prometheus + Grafana | `feature_11_state.md` | **DONE** (iter-189 endpoint + iter-199 dashboards). |
| 12 | OTA update flow | `feature_12_state.md` | **DEV-COMPLETE** through slice 6 (iter-230..234, 237). Slices 3c/4/5 operator-side. |
| — | Active learning / face capture for retraining | (in-code) | **DONE** through Phase 3 (iter-351..353). PWA /training + /training/review pages live. |

**Operator-blocked work** (the user has to wire host-side scripts, sudoers entries, hardware):
- Feature 1 slice 5 (clip retention sweeper)
- Feature 9 (NVENC thumb encode benchmarks)
- Feature 10 slice 4 (host-helper backup script + sudoers)
- Feature 12 slices 3c/4/5 (OTA update host-helper)
- Two-way audio iter-309..312 (USB mic + outdoor speaker hardware not yet purchased — `memory/two_way_audio_plan_iter308.md`)
- Multi-camera (iter-303 deferred — `memory/multicam_plan_iter177.md`)

---

## 11. Immediate next-iter candidates (ranked, when /loop resumes)

1. **HIGHEST PRIORITY:** Walk every page in browser-harness with a logged-in session. Screenshot Live + Events + Settings + People + Training + Review. Catch any other invisible-element bugs the iter-356.26 sed introduced. The user MUST log in once in their Chrome OR provide a test admin password I can submit.
2. **Maya M1 + Nit N1 + N2 + Frank G1 + D1 from iter-356.24** — small copy + branching fixes. ~30 min total.
3. **Priya D1 (Events desktop empty heatmap aside)** — single-line conditional in Events.tsx. XS.
4. **Maya M1 from iter-356.25 (accent contrast)** — switch text-use accent to amber-700.
5. **Drop the `/login` corner-cases** if the screenshot pass surfaces any (e.g., card border too subtle, error message styling).

After iter-356.X is at acceptance, the project goes back to:
- The 7-Manager **state-of-the-project audit cycle** (next due ~iter-285 or post-mega-overhaul)
- The remaining `memory/mega_roadmap_iter177.md` items
- Operator-blocked work waiting on hardware/sudoers

---

## 12. Dev environment quirks (essential before touching code)

These bite EVERY new contributor. Read CLAUDE.md § "exFAT quirks" too.

- **The repo is on an exFAT external drive** (`/media/israel/Drive/...`). exFAT can't host symlinks. Two consequences:
  1. **Python venvs must live in `/tmp`** — `/tmp/homecam-venv/` is the canonical dev-machine venv. `python3 -m venv .venv` inside the repo silently produces a broken venv.
  2. **`node_modules/.bin` shims don't work**. `client/package.json` scripts spell out `node ./node_modules/<pkg>/.../bin.js` literally. Don't use `npx`.
- **Server is in Docker on Jetson**. SHARP EDGE (iter-317 lost-3-iters incident): `server/app/` is **NOT bind-mounted**. Code is baked at `docker compose build` time. Always use `docker compose up -d --build server` for server changes — never `restart server`.
- **Detection worker is on the Jetson HOST**, NOT in container. Needs libargus / TensorRT / NVDEC. systemd unit `homecam-detect`.
- **MediaMTX owns the camera** via `nvarguscamerasrc` — only one process can hold libargus. Don't add a `tee` or a second nvarguscamerasrc. Detection re-decodes the H.264 from MediaMTX over NVDEC.
- **Python 3.6 compat for detection worker** — JetPack 4.x ships 3.6. AST scanner at `detection/tests/test_py36_compat.py` enforces no `from __future__ import annotations`, no PEP 604 unions (`int | None`), no walrus, no `match`. The 3.6-compat modules are listed in CLAUDE.md sharp edges.

---

## 13. Deploy story

**Client-only change** (most iters):
```bash
cd client && npm run build
rsync -a --delete client/dist/ jetson:/home/israel/HomeCameraSystem/client/dist/
```
The PWA auto-updates on next page-load (`vite-plugin-pwa registerType: 'autoUpdate'` + `clientsClaim()` + `skipWaiting()`). Open tabs serve the previous bundle until refresh.

**Server change**:
```bash
ssh jetson 'cd /home/israel/HomeCameraSystem && \
  sudo docker compose -f deploy/docker-compose.yml up -d --build server'
```
NEVER `restart server` — the iter-317 sharp edge above.

**Detection worker change**:
```bash
rsync -a detection/ jetson:/home/israel/HomeCameraSystem/detection/
ssh jetson 'sudo systemctl restart homecam-detect'
```

**MediaMTX config change**:
```bash
ssh jetson 'sudo systemctl restart mediamtx'
```

---

## 14. Recovery procedures (when things wedge — see CLAUDE.md § "Jetson recovery quick-reference" for full)

| Symptom | Fix |
|---|---|
| systemd unit hit `StartLimitBurst=5` | `sudo systemctl reset-failed <unit> && sudo systemctl start <unit>` |
| MediaMTX silently dropped frames | `sudo systemctl restart mediamtx` (the iter-26 worker watchdog also auto-restarts) |
| Worker stuck mid-iter not heartbeating | `Liveness.bump()` gate (iter-8) means heartbeat stops within 30s; just `sudo systemctl restart homecam-detect` |
| Server container OOM-killed | iter-167 `restart: unless-stopped` auto-respawns; verify `docker compose -f deploy/docker-compose.yml up -d server` |
| Verify perf knobs after reboot | `systemctl is-active homecam-jetson-perf` should report `active`; `sudo jetson_clocks --show` should show GPU CurrentFreq=921600000 |
| All three need clean reset | `sudo systemctl restart mediamtx homecam-server homecam-detect` |

---

## 15. Testing conventions

**BDD-lite** (iter-243 user directive). All NEW tests use Given/When/Then naming + AAA body structure. Existing 1142 tests grandfathered, migrate on touch.

**Wire-contract symmetry rule**: when changing a route or payload on the server, expect to update both `client/src/lib/api.test.ts` and a matching `server/tests/test_*.py`. Tests pin the wire shape.

**Run commands** (from `client/`):
```bash
npm test -- --run     # 637 tests, ~13 sec
npm run typecheck     # tsc -b --noEmit
npm run lint          # ESLint flat config
npm run build         # produces dist/
```

From `server/`:
```bash
/tmp/homecam-venv/bin/python -m pytest
```

From `detection/`:
```bash
/tmp/homecam-venv/bin/python -m pytest
```

---

## 16. Where to find context

- **`CLAUDE.md`** — engineering bible. Sharp edges, conventions, dev loop, sub-agent reference. **Read second after this doc.**
- **`memory/MEMORY.md`** — auto-loaded into Claude Code context every session. Index of all memory docs.
- **`memory/loop_audit_log.md`** — running iter-by-iter log. Read most-recent ~5 entries before doing any /loop iter.
- **`memory/feedback_*.md`** — user-given directives (sequential per-feature work, BDD-lite, polish auditor always-on, major UI overhaul mandate, sequential per-feature).
- **`memory/feature_<N>_state.md`** — per-feature trackers.
- **`memory/state_of_the_project_iter*.md`** — periodic synthesis snapshots (iter-161, 169, 180, 190, 200, 225, 235).
- **`memory/mega_overhaul_iter356.md`** — the iter-356 mega plan (8 phases).
- **`memory/multicam_plan_iter177.md`**, **`memory/auth_plan_iter177.md`**, **`memory/two_way_audio_plan_iter308.md`** — feature plans.
- **`memory/polish_auditor_persona.md`** — Maya BRUTAL prompt (drop into `general-purpose` Agent calls).
- **`memory/loop_directives.md`** — the active /loop prompt + revertable history.

---

## 17. The user's preferences I've absorbed

- **Cat names**: Panther (Bombay), Mushu (Tuxedo), Coco (Calico). Real cats.
- **Theme preference**: light + warm + cat-themed (Option A among the 3 I offered).
- **UI mandate**: paid-SaaS-tier polish. Linear / Things 3 / Cron / Raycast tier reference. "I would not pay for this level of UI/UX" + "I meant it" + "i thought i told you to change the loop to ui overhaul AND cat theme change based on my cats."
- **Style**: caveman-mode ON (terse, drop articles). Activated by hook.
- **Sequential per-feature work** (iter-197): finish each in-flight feature fully before starting a new one.

---

## 18. The two real risks right now

1. **iter-356.26 bulk sed left subtle bugs in pages I haven't visually verified.** The Tailwind v4 var() bug was caught only because I screenshotted Login. Equivalent silent failures may exist on Live, Events, Settings, People, Training, Review. **Whoever picks this up next should do the visual sweep BEFORE shipping more iters.**
2. **The `text-white` exception is fragile.** If a future iter runs another auto-replace + sweeps `text-white` again, buttons + toasts will go invisible AGAIN. Consider introducing a `--color-on-accent: #ffffff` token in `index.css` so the contract is documentable instead of magic. Not urgent but it's the cleaner long-term design.

---

If you have questions, the entire iter-by-iter rationale is in `memory/loop_audit_log.md` (4500+ lines as of iter-356.27). Each iter entry has Target / Why-now / Change / Validation / Files / Risks-follow-ups. The "Risks/follow-ups" lines are the natural next-iter seeds.

Good luck. The cats are good cats.
