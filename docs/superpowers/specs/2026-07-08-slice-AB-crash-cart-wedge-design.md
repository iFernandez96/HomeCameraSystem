# Slice A + B — God-Mode Crash-Cart Panels + Wedge-Diagnosis Panel (implementation spec)

Author: spec for codex gpt-5.5. Date: 2026-07-08.
Scope: `client/` (React 19/TS/Tailwind-v4 PWA), `server/` (FastAPI), `detection/` (Python-3.6 worker).
Read `CLAUDE.md` first — the wire-contract, py36, and theme rules below are load-bearing.

This is TWO clearly separable slices, each its own commit (or commit-pair):

- **Slice A** — read-only crash-cart panels in God View, fed by the EXISTING `GET /api/status` + `/metrics`. Plus a cross-cut refactor: unify the god-mode gate + the 4 copy-pasted `isOwner` checks behind one shared helper. **No server or worker changes.**
- **Slice B** — ship watchdog escalation state + last wedge-diagnostics over the heartbeat (a 3-tier wire-contract change: worker → server whitelist → client type), then render them in a God-View wedge panel.

Ship A first. B depends on A only for the panel scaffolding (the new `PipelinePanel`/`StatCard` primitives A introduces); B's wire-contract change is independent and could land before A's UI, but the recommended order is A then B.

---

## Shared current-state facts (grounded)

- God View page: `client/src/pages/GodView.tsx`. Today it renders only the admin **audit** log (sessions/per-user/views). It fetches `getAdminAudit` in a `useEffect` using the request-key-on-settled-result pattern (`GodView.tsx:57-94`) — DO NOT regress that pattern when adding the status poll; use `useStatus()` for the new panels (separate concern, separate hook).
- God-mode gate is `user?.username === 'admin'` in THREE places: `GodView.tsx:64` (`isAdmin`, also drives the `<Navigate to="/" replace/>` at `:96`), `SideRail.tsx:79`, `BottomNav.tsx:42`.
- `isOwner` is copy-pasted as `user?.role === 'owner' || user?.role === 'admin'` in: `client/src/pages/settings/AccountSection.tsx:18`, `client/src/components/ClipModal.tsx:141`, `client/src/pages/Settings.tsx:82`, `client/src/pages/Events.tsx:63`. `UserMgmt.tsx:292,295` inlines the same `role === 'owner' || role === 'admin'` predicate over OTHER users (owner-count guard), not `user`.
- `User` type: `client/src/lib/types.ts:406-409` → `{ username: string; role: string }`.
- Status hook: `client/src/lib/useStatus.ts` — `useStatus(intervalMs = 5000): ServerStatus | null`. Polls `/api/status`, holds last-known-good through 1 transient blip, pauses when tab hidden. Reuse it verbatim.
- `ServerStatus` type: `client/src/lib/types.ts:430-499` — already carries every field Slice A needs: `camera` (`'ok'|'missing'|'error'`), `detection_active`, `worker_alive`, `worker_last_seen_s` (nullable), `worker_metrics` (`WorkerMetrics | null`), `cpu_temp_c`, `gpu_temp_c`, `cpu_freq_pct`, `load_avg` (`[number,number,number]|null`), `memory_used_mb`, `memory_total_mb`, `disk_free_gb`, `fps`, `seconds_since_last_frame` (nullable).
- `WorkerMetrics` type: `client/src/lib/types.ts:284-399` — carries `fps`, `infer_ms_recent`, `infer_ms_p95`, `mediamtx_restarts`, `argus_restarts`, `uptime_s`, `gear`, the failure counters, etc. All optional (`?`).
- Server status builder: `server/app/main.py::_build_status` (:409-473), returned by `GET /api/status` (:384, auth-gated via `Depends(get_current_user)`).
- Empty/degraded state primitive: `<CatEmptyState>` (`client/src/components/CatEmptyState.tsx:98`) — the ONLY empty-state primitive (CLAUDE.md pin). `ErrorState`/`LoadingState` already imported in GodView.
- Theme: Tailwind-v4 CSS vars MUST use `bg-[var(--color-x)]` (never `bg-[--color-x]`), Playroom Modern dual-theme, `border-[1.5px] border-[var(--color-border)]`, `rounded-lg`/pill, `shadow-[var(--shadow-subtle)]`. Copy the card grammar already in GodView (`GodView.tsx:195-199`). NO `bg-neutral-9XX`, NO `text-blue-XXX`. Identity red is reserved for failure/destructive only — a DOWN pipeline stage MAY use it (it IS a failure signal); a healthy stage uses `--color-accent-*` / text-secondary, never identity-wheel hues.
- a11y: prefer `getByRole`/`getByLabelText`. Every panel is a `<section aria-labelledby>` with an `<h2 id>`; stat grids use `<dl>/<dt>/<dd>` (mirror `GodView.tsx:203-216`).

---

# SLICE A — read-only crash-cart panels + gate/isOwner unification

## A0. Cross-cut: shared `isOwner` + god-mode helper (do this first, its own commit)

**Create** `client/src/lib/roles.ts`:

```ts
import type { User } from './types'

/**
 * Owner-equivalent gate. `admin` is the transitional legacy owner
 * (CLAUDE.md: "RBAC admin-as-owner transitional carve-out") — it and
 * `owner` both pass until seeded users migrate, at which point this ONE
 * helper drops the `admin` arm and all call sites follow.
 */
export function isOwner(user: User | null | undefined): boolean {
  return user?.role === 'owner' || user?.role === 'admin'
}

/**
 * God-View / god-mode visibility. TODAY this is username-based
 * (`admin`) for historical reasons; unify onto the owner role so god
 * mode tracks RBAC instead of a magic username. Behaviour change:
 * a seeded `owner` (non-`admin`) now also sees God View — intended.
 */
export function isGodModeUser(user: User | null | undefined): boolean {
  return isOwner(user)
}
```

**Modify** — replace inline predicates with the helper (import from `../lib/roles` / `../../lib/roles` as depth requires):

| File:line | Current | New |
|---|---|---|
| `client/src/pages/GodView.tsx:64` | `const isAdmin = user?.username === 'admin'` | `const canView = isGodModeUser(user)` (rename local + the `if (!isAdmin)` at `:96` and the `useEffect` dep at `:76,90`) |
| `client/src/components/SideRail.tsx:79` | `user?.username === 'admin'` | `isGodModeUser(user)` |
| `client/src/components/BottomNav.tsx:42` | `user?.username === 'admin'` | `isGodModeUser(user)` |
| `client/src/pages/settings/AccountSection.tsx:18` | inline `||` | `isOwner(user)` |
| `client/src/components/ClipModal.tsx:141` | inline `||` | `isOwner(user)` |
| `client/src/pages/Settings.tsx:82` | inline `||` | `isOwner(user)` |
| `client/src/pages/Events.tsx:63` | inline `||` | `isOwner(user)` |

Leave `UserMgmt.tsx:292,295` alone (it predicates over a `role` string of OTHER users, not a `User`); optionally add an `isOwnerRole(role: string)` overload later — OUT OF SCOPE this slice.

**Behaviour note to call out in the commit message:** god mode was `username==='admin'`; it is now `role` in `{owner, admin}`. On the live deployment the single privileged user is both, so no visible change today; a future seeded `owner` gains God View (correct).

**Tests (A0):** `client/src/lib/roles.test.ts` (new), BDD-lite:
- `Given an owner user, When isOwner is called, Then it returns true`
- `Given an admin user, When isOwner is called, Then it returns true` (transitional carve-out)
- `Given a viewer user / null / undefined, When isOwner is called, Then it returns false`
- same matrix for `isGodModeUser`
AAA bodies. Update any existing `SideRail`/`BottomNav`/`GodView` test that asserted the `admin` username gate to assert on `role` instead (grep `username: 'admin'` in `*.test.tsx`).

## A1. New God-View panels (read-only, fed by `useStatus()`)

Add a panel cluster ABOVE the existing audit sections in `GodView.tsx` (the crash-cart is the operator's first glance; audit is secondary). Gate: render panels whenever `canView`. The panels use their OWN `useStatus()` call — do not entangle with the audit request-key state.

Wire it in `GodView.tsx` like:
```tsx
const status = useStatus()   // 5 s poll, null until first tick / on outage
```
Render a `<section aria-labelledby="crash-cart-h2">` containing four sub-panels in a responsive grid (`grid gap-3 md:grid-cols-2 xl:grid-cols-2` — panels are wide). When `status === null`, render `<CatEmptyState variant=... title="Waiting for the Jetson" body="No status from the server yet.">` (pick an existing mascot variant used elsewhere for "offline"; check `CatEmptyState` props at `CatEmptyState.tsx:71-106`). Never a plain-text empty state.

### Component structure

Create these under `client/src/components/godview/` (new dir), each a small presentational component taking already-fetched props (pure, testable without fetch):

1. **`StatCard.tsx`** — reusable `{ label, value, unit?, tone?: 'ok'|'warn'|'down'|'neutral' }` → a `<div>` with `<dl>` inside, Playroom card grammar. `tone` maps to token classes: `ok`→`text-[var(--color-text-primary)]`, `warn`→`text-[var(--color-accent-strong)]` (or amber token if present — check `index.css`), `down`→`text-[var(--color-id-danger)]` / the failure red token. Renders an em-dash (`—`) when `value == null`.

2. **`PipelinePanel.tsx`** (panel 1 — pipeline-health rollup camera→mediamtx→detect→server). Props: the `ServerStatus`. Derive four stage verdicts (pure helper `derivePipeline(status)` in `client/src/lib/pipelineHealth.ts`, unit-tested offline per principle #2):
   - `server`: UP iff `status` is non-null and `status.ok` (we got a fresh status at all).
   - `camera`: `status.camera === 'ok'` → UP; `'missing'`/`'error'` → DOWN (label the reason).
   - `mediamtx` / stream: DOWN when `status.seconds_since_last_frame != null && status.seconds_since_last_frame > 60` (STREAM STALE — the iter-300 silent-stall signature, CLAUDE.md); UP when `<= 60`; UNKNOWN (neutral) when `null` (worker never reported a frame yet). MediaMTX has no direct field — frame freshness IS its liveness proxy; say so in a comment.
   - `detect`: UP iff `status.worker_alive && status.detection_active`; if `worker_alive` but not `detection_active` → tone `warn` ("detection off"); if `!worker_alive` → DOWN ("worker silent").
   Render as a horizontal 4-node row (camera → mediamtx → detect → server) with an arrow/chevron between nodes, each node a pill: name + status dot + one-line reason. `role="list"`/`role="listitem"` with `aria-label` per node encoding the verdict text (color is NEVER the only signal — CLAUDE.md a11y). Return type of `derivePipeline`: `{ stage: 'camera'|'mediamtx'|'detect'|'server', verdict: 'up'|'down'|'warn'|'unknown', reason: string }[]` in fixed order.

3. **`VitalsPanel.tsx`** (panel 2 — Jetson vitals). Grid of `StatCard`s from `status`: CPU temp (`cpu_temp_c` °C), GPU temp (`gpu_temp_c` °C), mem used/total (`memory_used_mb`/`memory_total_mb` → render `X / Y MB` + a % bar), CPU freq headroom (`cpu_freq_pct` %), load avg (`load_avg` → `1m / 5m / 15m`). Tone thresholds (put in `pipelineHealth.ts` or inline consts): GPU temp `warn` ≥ 70, `down` ≥ 80 (the worker's own thermal gears — CLAUDE.md thermal_guard hysteresis 70/80). `cpu_freq_pct < 100` → `warn` (kernel pulled the ceiling — throttling). Null-safe (`—`).

4. **`RecordingRunwayPanel.tsx`** (panel 3 — days-of-recording-left). This needs a fill-rate estimate. **Decision — keep it simple and honest, no historical series available client-side:**
   - The client has only the instantaneous `disk_free_gb`. There is no server-side history of disk usage, so a true observed fill rate is not derivable from `/api/status` today.
   - Estimate: `client/src/lib/recordingRunway.ts::estimateDaysLeft(freeGb, gbPerDay)` where `gbPerDay` is a **documented constant assumption** (`ASSUMED_GB_PER_DAY = 8`) derived from CLAUDE.md's clip economics (clips avg ~10.5 MB, continuous-capture one-clip-per-visit; 8 GB/day is a conservative round number for an active front-door). Return `{ daysLeft: number | null, basis: 'assumed-rate' }`; `null` when `freeGb == null`.
   - Render: big number "≈ N days left" + a subdued caption "Estimate at ~8 GB/day. Free: {freeGb} GB." Tone: `down` < 3 days, `warn` < 7. This is explicitly a rough gauge — the caption must say "estimate" so the operator doesn't trust it as measured. (A future improvement — a server-side rolling `disk_free_gb` sample table to compute REAL fill rate — is noted in "Out of scope" below.)

5. **`WorkerLivenessPanel.tsx`** (panel 4 — worker liveness). `StatCard`s from `status.worker_metrics` + top-level: last-seen (`worker_last_seen_s` s ago, `—`/"never" when null), fps (`status.fps` — already mirrors `worker_metrics.fps`), infer latency (`worker_metrics.infer_ms_recent` ms + p95 `infer_ms_p95`), gear (`worker_metrics.gear` as a pill), restart counters `mediamtx_restarts` / `argus_restarts` (tone `warn` when > 0 — "N recoveries this session"), worker uptime (`worker_metrics.uptime_s`). When `worker_metrics == null` (worker dead), render `<CatEmptyState>` inside the panel ("Worker is silent") instead of a grid of em-dashes.

### Formatting helpers
Reuse `formatDuration` (already in `GodView.tsx:26`) — LIFT it into `client/src/lib/format.ts` if not there, or duplicate-free import. Add `formatSecondsAgo(s: number | null)` and `formatTemp(c: number|null)` to `format.ts` (pin in `format.test.ts`).

### Error/empty states (A)
- Whole cluster, `status === null` (server unreachable > threshold): `<CatEmptyState>` "Can't reach the Jetson". Do NOT show `ErrorState` here — `useStatus` already swallows transient blips and holds last-known-good; a null means a real outage, and the calm cat-empty is the right register.
- Per-panel null fields → `—` via `StatCard`.

## A2. Tests (Slice A)

Client (`vitest` + Testing Library + jsdom), BDD-lite Given/When/Then + `// arrange / act / assert`:

- `client/src/lib/pipelineHealth.test.ts` — pure `derivePipeline`:
  - `Given camera 'ok', worker_alive, detection_active, fresh frame, When derivePipeline runs, Then all four stages are up`
  - `Given seconds_since_last_frame = 120, When derivePipeline runs, Then mediamtx stage is down with a STALE reason`
  - `Given seconds_since_last_frame = null, When derivePipeline runs, Then mediamtx stage is unknown`
  - `Given worker_alive true but detection_active false, When derivePipeline runs, Then detect stage is warn (detection off)`
  - `Given camera 'error', Then camera stage is down`
- `client/src/lib/recordingRunway.test.ts` — `Given 24 GB free at 8 GB/day, Then ~3 days left`; `Given null free, Then null`.
- `client/src/lib/roles.test.ts` — see A0.
- `client/src/components/godview/*.test.tsx` — render each panel with a fabricated `ServerStatus`; assert via `getByRole`/`getByText`:
  - `PipelinePanel` shows a down node's reason text as an accessible name (color-independent).
  - `WorkerLivenessPanel` renders `<CatEmptyState>` when `worker_metrics` is null (assert by the empty-state's accessible name, not the mascot img).
  - `VitalsPanel` renders `—` for null fields.
- Update `SideRail.test.tsx` / `BottomNav.test.tsx` / `GodView` gate tests to the role-based gate.

No server/worker tests in Slice A.

---

# SLICE B — wedge-diagnosis over the heartbeat + God-View panel

## B0. Current-state facts (grounded)

- The watchdog escalation state + wedge diagnostics live ONLY on the Jetson host, never reach the server:
  - `detection/detect.py`: `_WATCHDOG_STATE` dict + `_WATCHDOG_STATE_PATH` (`detect.py:877-878`, set to `<recordings_dir>/.watchdog_state.json` at `:1789`). Carries `level`, `last_action_at`, `last_reboot_at` (`_persist_watchdog_level` :936-942, `_do_reboot` :1008, `_clear_watchdog_escalation` :952-958).
  - `_capture_wedge_diagnostics(action)` (`detect.py:961-988`) currently only `print()`s probes (memory/tegrastats/nvargus RSS/dmesg/thermal) to journald — nothing structured, nothing forwarded. Called on escalation at `:1275`.
  - `MediaMtxWatchdog` (`detection/mediamtx_watchdog.py`): `self.level` (:95), ladder `_DEFAULT_LADDER` (:61-67) = `[restart_mediamtx, restart_mediamtx, restart_nvargus, restart_nvargus, reboot]`; `ACTION_*` constants (:51-53); `snapshot()` (:161-169) → `{level, last_action_at}`; escalation executed + persisted at `detect.py:1259-1296` (`prev_level`, `action`, `metrics.mediamtx_restarts += 1` / `metrics.argus_restarts += 1`).
- Heartbeat transport: `start_heartbeat` (`detect.py:615-666`) POSTs `json.dumps(metrics.snapshot())` to `.../heartbeat` every 10 s (:646). So **anything that must reach the server has to be a field on `Metrics.snapshot()`** — that's the wire.
- Worker mirrors live sub-state into `metrics` right before the loop heartbeats — precedent: `metrics.visits_finalized = _VISIT_RUNNER.visits_finalized` (`detect.py:1999-2004`). Slice B mirrors watchdog/wedge state the same way.
- Server whitelist: `server/app/routes/_internal.py::_ALLOWED_METRIC_FIELDS` (:55-106), numeric-only path `_NUMERIC_METRIC_FIELDS = _ALLOWED_METRIC_FIELDS - {gear, face_recog_names}` (:113), `_coerce_metric` (:184-228) — numeric branch rejects bool + non-finite (:196-203); `gear` is the string branch (strip + `_GEAR_MAX=32`, :204-215). Adding a NEW string field requires extending `_coerce_metric` with a string-cap branch (mirror the `gear` branch).
- Symmetry test: `server/tests/test_internal.py::test_worker_snapshot_keys_match_whitelist` (:1328-1363) asserts `set(Metrics().snapshot().keys()) == set(_ALLOWED_METRIC_FIELDS)` — this WILL fail the instant you add a field to one side and not the other. Plus `test_every_whitelisted_metric_round_trips_to_status` (:1366-1410) pins that a fixture carrying every whitelist key round-trips to `/api/status`.
- Client type: `WorkerMetrics` (`client/src/lib/types.ts:284-399`).

## B1. Chosen wire shape (FLAT-prefixed keys — fits the numeric whitelist with ONE string carve-out)

Add to `Metrics.__init__` + `Metrics.snapshot()` (`detection/metrics.py`) and mirror on all tiers:

| Key | Type | Meaning | Coercion path |
|---|---|---|---|
| `watchdog_level` | int | current ladder index `0..len-1` (0 = healthy/bottom rung) | numeric |
| `watchdog_last_action_at` | float (unix s) | `last_action_at`; `0` when never acted (JSON-safe sentinel — the worker converts `None`/`-inf` → `0.0`) | numeric (finite) |
| `watchdog_last_reboot_at` | float (unix s) | boot-loop guard timestamp; `0` when never rebooted | numeric |
| `watchdog_action_count` | int | total escalations this worker session (flap signal) | numeric |
| `watchdog_last_action` | **string** (capped) | last rung name: one of `""`, `restart_mediamtx`, `restart_nvargus`, `reboot` | **NEW string branch**, cap `_WATCHDOG_ACTION_MAX = 24` |
| `wedge_diag_at` | float (unix s) | when `_capture_wedge_diagnostics` last ran (`0` if never) | numeric |
| `wedge_diag_nvargus_rss_kb` | float | nvargus-daemon RSS in KB at last wedge (`0`/absent when unparsed) | numeric |
| `wedge_diag_gpu_temp_c` | float | GPU-therm °C at last wedge | numeric |
| `wedge_diag_mem_avail_mb` | float | MemAvailable MB at last wedge | numeric |
| `wedge_diag_argus_pending` | float | "too many pending events" / Argus OverFlow count if parseable, else `0` | numeric |

Rationale for FLAT numerics + one string: the existing coercion machinery is numeric-by-default (`_NUMERIC_METRIC_FIELDS`), bool/NaN-hardened, and the symmetry test is a flat set-equality — a flat scheme adds keys with near-zero new coercion surface. Only `watchdog_last_action` needs a string branch (rung name is human-facing in the UI; encoding it as an int enum would force a client-side lookup table and lose the round-trip readability the `gear` field already models). Timestamps are epoch seconds per CLAUDE.md convention; the client derives "N min ago". Use `0` (not `null`) for "never" so every numeric field stays a plain finite number through `_coerce_metric` (null would drop the field, which reads identically to "absent" on the client — `0` + a client guard `> 0` is unambiguous).

**All ten keys must be added to FOUR places in lockstep (wire-contract-sync):**
1. `detection/metrics.py` — `__init__` defaults + `snapshot()` dict (py36-compat).
2. `server/app/routes/_internal.py::_ALLOWED_METRIC_FIELDS` (9 numerics auto-join `_NUMERIC_METRIC_FIELDS`; `watchdog_last_action` must ALSO get a string branch in `_coerce_metric`).
3. `client/src/lib/types.ts::WorkerMetrics` — 10 optional fields + doc comments.
4. `server/tests/test_internal.py::test_worker_snapshot_keys_match_whitelist` needs NO edit (it derives both sets), but `test_every_whitelisted_metric_round_trips_to_status`'s fixture (:1376-1405) DOES — add the 10 keys to its payload so its `set(payload.keys()) == set(_ALLOWED_METRIC_FIELDS)` assert stays green.

## B2. Worker changes (`detection/`) — Py3.6 compatible

**`detection/metrics.py`:**
- In `__init__`, add the 10 attributes, all defaulting to `0` / `""` (`self.watchdog_last_action = ""`, the rest `0`/`0.0`). Add doc comments mirroring the existing style (`mediamtx_restarts` comment at :69-73 is the template).
- In `snapshot()` (:178-202), emit all 10 with the same rounding discipline (`round(self.watchdog_last_action_at, 1)` etc.; ints stay ints; string as-is).
- **Py3.6 note:** no type annotations on attributes, no f-strings introduced (the file uses none), no walrus/PEP-604/PEP-585. This file already declares "Must stay Python 3.6 compatible" (`metrics.py:7-8`). The `py36-compat-guard` skill + `detection/tests/test_py36_compat.py` AST scanner will catch violations — run it.

**`detection/detect.py`:**
- Refactor `_capture_wedge_diagnostics(action)` (:961-988) to ALSO parse a small structured dict out of its probes and stash it in module-global `_WATCHDOG_STATE` (or a new `_LAST_WEDGE_DIAG` dict) so the heartbeat can mirror it. Keep the existing prints (journald greppability is still wanted). Parse best-effort, bounded, never raise (the function already promises this):
  - nvargus RSS from the `ps -o rss=` probe (already collected) → KB int.
  - GPU temp from the thermal-zone probe (match `GPU-therm` zone or reuse the same `/sys/class/thermal` read the server uses).
  - MemAvailable from `free -m` (the "available" column).
  - Argus pending/overflow: grep the dmesg-tail probe for `Argus OverFlow` / `too many pending events` → a count or `0`.
  - Set `_LAST_WEDGE_DIAG = {at: time.time(), nvargus_rss_kb, gpu_temp_c, mem_avail_mb, argus_pending}`.
- At the escalation site (`detect.py:1259-1296`, right after `_capture_wedge_diagnostics(action)` at :1275 and `_persist_watchdog_level` at :1296), and/or in the pre-heartbeat mirror block near `:1999-2004`, mirror onto `metrics`:
  ```python
  snap = mediamtx_watchdog.snapshot()
  metrics.watchdog_level = snap["level"]
  metrics.watchdog_last_action_at = snap["last_action_at"] or 0.0
  metrics.watchdog_last_reboot_at = _coerce_watchdog_timestamp(
      _WATCHDOG_STATE.get("last_reboot_at"), time.time())
  metrics.watchdog_action_count = mediamtx_watchdog.action_count
  metrics.watchdog_last_action = action or ""   # ACTION_* string
  diag = _LAST_WEDGE_DIAG
  if diag:
      metrics.wedge_diag_at = diag.get("at", 0.0)
      metrics.wedge_diag_nvargus_rss_kb = diag.get("nvargus_rss_kb", 0.0)
      ...
  ```
  Choose the mirror site so a heartbeat that fires BETWEEN wedges still reports the current `watchdog_level` (mirror the level/last_action_at every loop iteration near the visits_finalized mirror at :1999, not only on escalation — otherwise the panel goes stale after recovery). `_clear_watchdog_escalation` (:952) resetting level→0 must be reflected: mirror `mediamtx_watchdog.level` each iteration so recovery shows level 0.
- **Py3.6 note:** `detect.py` is 3.6-only (JetPack 4.x). No f-strings? — NOTE: `detect.py` uses `.format()` throughout and forbids f-strings implicitly; match the surrounding style (use `.format()`), no walrus, no PEP-604. Run the `py36-compat-guard` skill BEFORE editing and the AST scanner after.

## B3. Server changes (`server/app/routes/_internal.py`)

- Add the 9 numeric keys + `watchdog_last_action` to `_ALLOWED_METRIC_FIELDS` (:55-106) with a comment block (mirror the iter-302 `last_frame_ts`/`argus_restarts` comment at :74-85).
- Add a string coercion branch to `_coerce_metric` (:184-228) for `watchdog_last_action`, modeled on the `gear` branch (:204-215): must be `str`, strip, allow empty→return `""` (unlike gear which rejects empty — here `""` = "no action yet" and is a legitimate value; so: reject non-str, cap length to a new `_WATCHDOG_ACTION_MAX = 24`, return the stripped value even if empty). Add `_WATCHDOG_ACTION_MAX` next to `_GEAR_MAX` (:121). Because it's a string, it must be EXCLUDED from `_NUMERIC_METRIC_FIELDS` — update that subtraction at :113 to `_ALLOWED_METRIC_FIELDS - {"gear", "face_recog_names", "watchdog_last_action"}`.
- `_build_status`/`/api/status` needs NO change — it forwards `worker_metrics` verbatim (`main.py:430`), and the new fields ride along inside it.

## B4. Client type + panel

**`client/src/lib/types.ts`:** add the 10 fields to `WorkerMetrics` (:284-399), all optional, with doc comments explaining the wedge context (reference the libargus "Failed to create CaptureSession" / "Argus OverFlow" signature and that `0` means "never"/"absent").

**Panel — `client/src/components/godview/WedgePanel.tsx`** (rendered in God View below the crash-cart cluster, same `canView` gate). Props: `WorkerMetrics | null`. Structure:
- **Escalation status row**: current rung. Map `watchdog_level` → rung name via a pure helper `client/src/lib/wedgeLadder.ts::rungName(level)` mirroring `_DEFAULT_LADDER` (`['restart_mediamtx','restart_mediamtx','restart_nvargus','restart_nvargus','reboot']`) → human label ("MediaMTX restart", "nvargus-daemon restart", "Reboot"). Show `level` (e.g. "Rung 2 of 5 — nvargus-daemon restart") with tone: level 0 → `ok` ("Healthy — bottom rung"), 1-2 → `warn`, 3+ → `down`.
- **Last action**: `watchdog_last_action` rung label + "N min ago" from `watchdog_last_action_at` (guard `> 0`, else "never"). `watchdog_action_count` ("N escalations this session").
- **Reboot guard**: from `watchdog_last_reboot_at` — if `> 0` and `now - it < 1800s` show "Reboot suppressed (boot-loop guard active, cools down in M min)"; else "Reboot available" / "Never rebooted". (`_REBOOT_MIN_INTERVAL_S = 1800` — `detect.py:888`; put the constant in `wedgeLadder.ts` with a comment citing it.)
- **Latest wedge diagnostics**: a `<dl>` of `wedge_diag_*` — captured-at ("N min ago"), nvargus RSS (KB→MB), GPU temp °C, MemAvailable MB, Argus pending count. Caption: "Snapshot from the last watchdog escalation — correlate wedge@T with nvargus-RSS/temp/pending@T." When `wedge_diag_at == 0` (no wedge this session) → `<CatEmptyState>` "No camera wedges this session" (the happy path — make it reassuring, not alarming).
- **Empty/error**: `worker_metrics == null` → `<CatEmptyState>` "Worker is silent — no wedge telemetry."
- a11y: `<section aria-labelledby="wedge-h2">`, `<dl>/<dt>/<dd>`, tone conveyed in TEXT (never color-only). Identity red allowed for `down` (it IS a failure signal).

## B5. Tests (Slice B) — BOTH sides, BDD-lite + AAA

**Server (`server/tests/test_internal.py`):**
- `test_worker_snapshot_keys_match_whitelist` (:1328) — no code change, but it's the guard; it must PASS after both sides get the 10 keys. Verify it does.
- Extend `test_every_whitelisted_metric_round_trips_to_status` fixture (:1376-1405) with the 10 new keys (values: sensible numbers + a rung string) so its set-equality assert (:1407) stays green.
- New: `test_given_heartbeat_with_watchdog_last_action_when_posted_then_string_is_capped_and_kept` — Given a heartbeat with `watchdog_last_action` = a 100-char string, When posted, Then `/api/status` `worker_metrics.watchdog_last_action` is dropped/capped per `_WATCHDOG_ACTION_MAX` (arrange fabricated heartbeat, act POST + GET status, assert).
- New: `test_given_heartbeat_with_empty_watchdog_last_action_when_posted_then_empty_string_kept` (empty is legit here, unlike `gear`).
- New: `test_given_heartbeat_with_nonfinite_wedge_diag_when_posted_then_field_dropped` (NaN `wedge_diag_gpu_temp_c` → dropped per-field, snapshot not poisoned — mirror the existing NaN test at :1204).

**Worker (`detection/tests/`):**
- `test_metrics.py` (or wherever `Metrics` is tested) — `Given a fresh Metrics, When snapshot is called, Then the 10 watchdog/wedge keys are present with 0/"" defaults`.
- `detection/tests/test_py36_compat.py` AST scanner — already covers `metrics.py` + `detect.py`; just RUN it (`/tmp/homecam-venv/bin/python -m pytest detection/tests/test_py36_compat.py`).
- If `_capture_wedge_diagnostics` parsing is extracted into a pure helper (recommended — parse nvargus RSS / thermal / mem / argus-pending from probe TEXT), unit-test that helper offline (principle #2): `Given a sample `ps` line, When parsed, Then rss_kb is N`; `Given dmesg text with 'Argus OverFlow', Then pending count > 0`. Extract as `detection/wedge_diag.py` (stdlib-only, 3.6-compat) so it tests with the Jetson off.

**Client:**
- `client/src/lib/wedgeLadder.test.ts` — `Given level 2, When rungName, Then 'nvargus-daemon restart'`; boundary levels; reboot-guard active/expired math.
- `client/src/components/godview/WedgePanel.test.tsx` — Given metrics with `watchdog_level=3`, Then rung text + `down` tone accessible name present; Given `wedge_diag_at=0`, Then the "No camera wedges" empty state; Given null metrics, Then the silent-worker empty state.
- `client/src/lib/api.test.ts` — if there's a `getStatus` shape pin (:61), extend a fixture to include the new `worker_metrics` fields so the wire-shape mirror is pinned client-side too (CLAUDE.md: "Lib tests pin wire shape … change a server route, expect to update api.test.ts AND test_*.py").

---

## Commit plan (keep A and B separable)

1. **A0** — `feat(roles): unify isOwner + god-mode gate behind lib/roles helper` (helper + 7 call-site swaps + roles.test + gate-test updates).
2. **A1** — `feat(godview): read-only crash-cart panels (pipeline/vitals/runway/worker)` (godview/ components + pure helpers + tests). Depends on A0.
3. **B (worker+server wire)** — `feat(wedge): ship watchdog + wedge-diagnostics over the heartbeat` (metrics.py + detect.py + wedge_diag.py + _internal.py whitelist/coerce + types.ts + all wire tests). Self-contained wire-contract change; symmetry test green.
4. **B (panel)** — `feat(godview): wedge-diagnosis panel` (WedgePanel + wedgeLadder + tests). Depends on B-wire + A1 scaffolding.

Optionally fold B-wire + B-panel into one commit if the reviewer prefers; keep A and B in distinct commits regardless.

## Out of scope / future
- Real observed disk fill-rate: a server-side rolling `disk_free_gb` sample table (e.g. one row/hour) would let `RecordingRunwayPanel` compute a MEASURED slope instead of the assumed 8 GB/day. Deferred — flag it in the runway panel caption.
- Historical wedge timeline (more than the single last-escalation snapshot) would need a server-side append log; today we ship only the latest diagnostics. Deferred.
- `UserMgmt.tsx`'s owner-count predicate over other users — leave as-is; a separate `isOwnerRole(role)` helper is a future tidy.

## Guardrails checklist for the implementer
- [ ] Run `py36-compat-guard` skill BEFORE touching `detection/`; run `test_py36_compat.py` after.
- [ ] Run `wire-contract-sync` skill for the B whitelist change; the 4 mirror points (metrics.py / _ALLOWED_METRIC_FIELDS+_coerce_metric / types.ts / round-trip test fixture) all updated.
- [ ] `test_worker_snapshot_keys_match_whitelist` green (proves worker↔server set-equality).
- [ ] All Tailwind vars use `bg-[var(--color-x)]`; no `bg-neutral-*` / `text-blue-*`; identity red only for down/destructive.
- [ ] Every empty state is `<CatEmptyState>`, never plain text.
- [ ] New tests are BDD-lite (`Given/When/Then`) + `// arrange / act / assert`.
- [ ] Panels are keyboard/SR-friendly: `<section aria-labelledby>`, `<dl>`, tone in TEXT not color-only.
- [ ] `client/`: `npm run typecheck && npm test && npm run lint`. Server/worker: `/tmp/homecam-venv/bin/python -m pytest`.
- [ ] Dev runs Jetson-OFF — everything above is verifiable locally.
