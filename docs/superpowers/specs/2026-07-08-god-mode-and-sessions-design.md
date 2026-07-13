# God-Mode Operator Console + Logged-In Sessions — Design

Status: **approved decomposition, in implementation**
Date: 2026-07-08
Owner: Israel
Implementer: codex gpt-5.5 (Claude plans, codex codes — one invariant per commit, per the atomicity directive)

## 1. Problem & framing

Today's `/god` route (`client/src/pages/GodView.tsx`) is a historical **audit-log viewer** only — one endpoint (`GET /api/admin/audit`). It shows login events, per-user telemetry, and page/event dwell. It has no system state, no recovery, no live sessions.

For **this** app — one wedge-prone Jetson 2GB, one camera (single-owner libargus), ~2 users — "god-mode" is NOT fleet omniscience. It is **an operator's crash-cart for one machine**: see the pipeline break, read the logs, hit the recovery ladder, understand who is connected — all without SSH. Plus the user's explicit ask: a **human-readable logged-in-sessions view**.

The single most valuable thing god-mode can do here is give the operator a place to finally **diagnose the recurring libargus camera wedge** (`Failed to create CaptureSession` / `Argus OverFlow: too many pending events`) — a bug that has been *mitigated* (auto-recovery) but never *root-caused*. The Jul-8 snapshot shows it still firing (4,472× capture errors, 40× Argus OverFlow).

## 2. Reality constraints (from the codebase map)

- `/api/status` (`server/app/main.py:384-473`) already serves rich vitals: `uptime_s`, `camera`, `detection_active`, `worker_alive`, `worker_last_seen_s`, `worker_metrics` (fps/infer_ms/restarts), `cpu_temp_c`, `gpu_temp_c`, `cpu_freq_pct`, `load_avg`, `memory_used/total_mb`, `disk_free_gb`, `fps`, `push_subs_count`, `seconds_since_last_frame`, `camera_label`.
- `/metrics` (`routes/metrics_prom.py`) exposes `mediamtx_restarts_total`, `argus_restarts_total`, `seconds_since_last_frame`.
- **Watchdog escalation state is invisible to the server.** Only cumulative restart *counters* cross the heartbeat wire. `level`/`last_action_at`/`last_reboot_at` and the `_capture_wedge_diagnostics` blob live only in `<recordings_dir>/.watchdog_state.json` on the host (`detection/detect.py`).
- **JWTs are fully stateless** (`server/app/auth/tokens.py`): HS256 access+refresh cookies, claims `sub/kind/role/iat/exp`. **No jti, no session store, no device id, no blocklist.** The only historical record is `audit_db.auth_events(ts, username, action, ua)`. "Live sessions" + "revoke" have **zero backing data today**.
- **Recovery is a stub.** `/api/system/reboot` (`routes/control.py:197`) returns a fake `{ok, note:"stubbed"}`. No mediamtx/nvargus restart route. The FastAPI server runs **in a container**; the **detection worker runs on the host with NOPASSWD sudo** and already restarts these services via the watchdog ladder.
- **No log read-back.** `POST /api/client-log` re-emits into journald; logs are write-only. Reading them means SSH + `journalctl`.
- **Gating inconsistency.** `/god` gates on `username === 'admin'` (`GodView.tsx:64`, `SideRail.tsx:79`, `BottomNav.tsx:42`) — a *different, stricter* check than the `owner`-role gating used everywhere else (`Settings.tsx`, `ClipModal.tsx`, etc.), and there is no shared `isOwner` helper (it's copy-pasted 4×).

## 3. Decomposition (each slice = its own spec → plan → codex cycle)

| Slice | Scope | Risk | Backing today |
|---|---|---|---|
| **F. Detection correctness** | Fix "same person → separate events." Continuous-capture ("one visit = one clip") is shipped but `continuous_capture:false` in prod. Resolution pending investigation (enable flag vs tune coalescing vs fix split logic). | *pending* | shipped-but-off |
| **A. Read-only crash-cart** | God-mode panels from existing `/api/status` + `/metrics`: pipeline health rollup (camera→mediamtx→detect→server), Jetson vitals, days-of-recording-left, worker liveness. | Low | ✅ mostly exists |
| **B. Wedge-diagnosis panel** | Ship watchdog `level`/`last_action_at`/`last_reboot_at` + `_capture_wedge_diagnostics` (tegrastats/dmesg/free/nvargus-RSS/pending-events) over the heartbeat; surface + correlate wedge@T with resource state@T. | Med (3-tier wire) | ⚠️ host-trapped |
| **C. Sessions infra + view** | Add `jti` to tokens; a `sessions` table (jti, username, device/ua, ip-class, created, last_seen, revoked); populate on login/refresh; touch last_seen; human-parse UA → "Chrome on Pixel"; ip-class LAN/cellular/Tailscale; "watching now" via live WS/WHEP join; **revoke** via blocklist checked in `tokens.decode`. | Large (net-new auth infra) | ❌ nothing |
| **D. Recovery ladder (act)** | Un-stub reboot; restart mediamtx/nvargus. **Routed through the worker**: server writes a requested-action record, the detection worker (already host-sudo) polls it on heartbeat and executes, reports result back. Owner-gated, audit-logged, confirm-dialog. | High (host blast radius) | ❌ stub |
| **E. In-app log tail** | Read journald back (piggybacks D's worker bridge: worker tails `journalctl` and ships bounded windows). | Med-High | ❌ nothing |

Cross-cut (fold into A): **unify god-mode gating** to the `owner` role + a shared `isOwner` helper, retiring the `username==='admin'` special-case.

### Decisions locked
- **Build order:** F (if a quick enable/tune) → A+B (one arc) → C → D → E. A+B share the first spec.
- **Host bridge (D/E):** route through the worker — no new privileged surface; reuse the trust boundary that already restarts these services. Slight latency (next heartbeat) is acceptable for operator-initiated recovery.
- **Sessions core is standalone-first:** device-parse, ip-class, and the revocation decision are pure functions with offline BDD tests before any auth wiring is touched.

## 4. Wire-contract impact (per the wire-contract-sync skill — pin BOTH sides)

- **B** adds heartbeat metric fields → extend `detection/metrics.py::snapshot()` AND `server/app/routes/_internal.py::_ALLOWED_METRIC_FIELDS` AND the client `WorkerMetrics` type AND `test_internal.py::test_worker_snapshot_keys_match_whitelist`. Watchdog `level`/diagnostics are structured (not a flat number) — decide: nested object vs flat-prefixed keys (spec B resolves; leaning flat-prefixed to fit the numeric whitelist, with a small string-allowed carve-out for `last_action`).
- **C** changes the token claim set (`jti`) — pin `tokens` tests both directions; add `/api/admin/sessions` GET + `/api/admin/sessions/{jti}/revoke` POST with mirrored `api.test.ts` ↔ `test_*.py`.
- **D** adds `/api/system/recover` (action ∈ {mediamtx, nvargus, reboot}) + a worker-poll field on the internal config/heartbeat channel — mirror both sides.
- **E** adds `/api/system/logs?unit=&since=` returning bounded lines — mirror both sides.

## 5. Guardrails

- All god-mode routes: **owner-gated + audit-logged**. Destructive actions (D: nvargus/reboot; C: revoke) require an explicit confirm and write an `auth_events`/audit row with actor + action.
- **Py3.6 guard** on every `detection/` edit (F, B's worker side, D's worker executor, E's tailer) — run the AST scanner; no PEP-604/585/walrus/match.
- **No secrets in logs/panels.** Sessions view shows parsed device + ip-class, never token bytes. Log-tail must not surface secret lines.
- **Never native-build on the Nano.** Any server image change ships via `deploy/cross-deploy-server.sh`.
- Dev runs **Jetson-off**: every slice keeps a pure, offline-testable core; host-touching code is thin and injected.

## 6. Section F — detection correctness ("same person = separate events")

**Root cause (verified):** `continuous_capture` is switched **OFF** in the live config. With it off, the worker runs the legacy presence-coalescing per-event path (`detection/presence.py:146-157`), which **re-arms every `clip_duration_s` (~11s for the live config)** for any subject that stays IoU-matched. A 3-minute presence → ~16 separate events/clips. This is by-design for legacy mode, not a bug. Continuous-capture ("one visit = one clip until absence") is fully built (`detection/visit.py`, `visit_runtime.py`, arm/disarm reconciler `detect.py:1979-1987`), was proven live 2026-07-07 via the replay harness against real prod traces, then got switched back off by a plain config reset (no kill-switch, no stability bug).

**Fix (two parts):**
- **F1 — operator/config (needs Jetson on; NOT codeable from Jetson-off dev):** set `continuous_capture: true` and restore `absence_finalize_s` `10 → 30` in the live detection config (Settings toggle or `PATCH /api/detection/config`). Arms live via the loop-top reconciler — no worker restart. `absence_finalize_s=30` is the harness-proven value; `10` sits below the measured 11-28s detector-flicker band and would still split visits on real occlusions. `max_visit_s=150` stays (intentional disk-fill split, ~1 event/2.5min, not the symptom).
- **F2 — code (codex, one commit):** flip the code default `continuous_capture: False → True` on BOTH tiers (`server/app/services/detection_config.py:238`, `detection/detect.py:391`) so a future config reset can't silently revert to the ~11s re-spam. Update the defaults' tests + wire mirror. Keep Py3.6-compat on the worker side. (Decision to flip the default is the user's — the "opt-in until baked" rationale is now satisfied since it baked live.)

**Standalone/proof leg:** re-run the existing replay harness (`detection/tests/harness/`) against `.jetson-snapshot/continuous_capture_fixtures/` + `proof_fixtures/` to re-prove "one long presence → one event" before/after F1, so the fix is verified against real traces, not asserted.

**Order:** F is the user's highest live pain and F1 is a config flip — do it FIRST (queued for next Jetson-on window); F2 lands as an early standalone codex commit independent of the god-mode slices.

## 7. Out of scope (deliberately cut for this app)

Fleet/live-wall multi-tile view, impersonate/audit arbitrary users, raw pre-coalesce event firehose, three-way config diff. These are enterprise-fleet scope this single-Jetson/two-user system does not have.
