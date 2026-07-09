# Slices D + E — Manual host recovery + in-app log tail (via the worker host-bridge)

Spec date: 2026-07-08. Status: implementation-ready. Author: planning pass (read-only on code).
Target executor: codex gpt-5.5. **Do not deviate from the wire shapes or the idempotency rules below without updating every mirror in §3.6.**

---

## 0. The architectural fact this whole design turns on

The FastAPI server runs **inside a Docker container**. It **cannot**:

- restart host systemd units (`mediamtx`, `nvargus-daemon`, `homecam-detect`),
- reboot the Jetson,
- read host `journalctl`.

The **detection worker runs on the host** (`detection/detect.py`, JetPack 4.x, **Python 3.6**), runs as user `israel` with **NOPASSWD sudo**, and **already** performs every host action we need:

| Host action | Existing worker function | File:line |
|---|---|---|
| restart mediamtx | `restart_mediamtx()` → `sudo -n systemctl restart mediamtx` | `detection/detect.py:776` |
| restart nvargus (+mediamtx) | `escalate_argus_recovery()` → restarts `nvargus-daemon` then `mediamtx` | `detection/detect.py:804` |
| reboot (boot-loop guarded) | `_do_reboot()` → `sudo -n systemctl reboot`, guarded by `_REBOOT_MIN_INTERVAL_S=1800` via persisted `_WATCHDOG_STATE["last_reboot_at"]` | `detection/detect.py:991` |
| reboot opt-out | env `DETECT_WATCHDOG_ALLOW_REBOOT` (`main()` reads it into `_allow_reboot`, `detect.py:1791`) | `detect.py:1791` |

These are the SAME operations the autonomous escalating watchdog (`detection/mediamtx_watchdog.py` + `_handle_capture_failure`, `detect.py:1224`) already calls. **We reuse them verbatim — no duplicated sudo calls.**

**Decision already made by the user:** route host actions **through the worker**. No new privileged host daemon. Mechanism: the server **records a requested action**; the worker **polls** for it (it already polls `/api/_internal/detection/config` every 30 s and POSTs `/api/_internal/heartbeat` every 10 s); the worker **executes on the host and reports the result back**.

Both slices (D: manual recovery ladder, E: log tail) are two consumers of **one** worker host-bridge. §1 specs the bridge once. §2 = Slice D. §3 (actually §4/§5 below — D is §4, E is §5) build on it as separable commits.

> **Live-verify caveat (CLAUDE.md "Dev runs Jetson-OFF").** None of the host side effects can be exercised on the dev laptop — there is no host systemd, no `journalctl`, no camera. The **offline test core must therefore be exhaustive**: every decision (stale / consumed / unknown / execute), every scrub rule, every compare-and-set transition is a pure unit test with the subprocess mocked at the boundary. Live verification (real restart / real reboot / real journald) is an **operator step deferred to `deploy/fetch-jetson-data.sh` + a Jetson-on session**, called out in §6.

---

## 1. The shared worker host-bridge (build FIRST — commit 1)

One request → claim → execute → result loop, shared by D and E.

### 1.1 Request record shape (canonical, server-owned)

```
HostActionRecord = {
  "id":            str,     # uuid4 hex — the idempotency key
  "kind":          str,     # "mediamtx" | "nvargus" | "reboot" | "logs"
  "args":          dict,    # kind-specific; {} for recovery kinds; {unit,since,lines} for "logs"
  "requested_by":  str,     # owner username (audit)
  "requested_at":  float,   # unix epoch seconds — staleness clock
  "status":        str,     # "pending" | "running" | "done" | "failed" | "expired"
  "detail":        str|None,# human reason on failed/done (e.g. "reboot disabled by DETECT_WATCHDOG_ALLOW_REBOOT=0")
  "result":        dict|None,# kind-specific payload (logs → {"lines":[...]}); null for recovery
  "claimed_at":    float|None,
  "result_at":     float|None,
}
```

### 1.2 Server-side store — new `server/app/services/host_bridge.py`

Pure, in-process, single-writer store with a bounded history. Persisted to a JSON sidecar on the **server data volume** so a server restart mid-request does **not** lose the idempotency state (mirrors the worker's persisted-watchdog pattern).

- Module state: `_current: HostActionRecord | None` (the one action a worker may claim) + `_history: list[HostActionRecord]` (last 20, newest first, for the status/history UI).
- Persist path: add `settings.host_action_state_path` (default under the existing persistent secrets/data dir, e.g. `<data>/host_action.json`), atomic `.tmp` → `os.replace`, `0o600`.
- Public functions (all pure except the atomic file write; inject `now` for tests):
  - `enqueue(kind, args, requested_by, *, now) -> HostActionRecord` — refuses if `_current` is still `pending`/`running` and not stale (return the existing record so the client can attach to it); else creates a fresh `pending` record, id = `uuid4().hex`.
  - `peek(now, *, max_pending_age_s) -> HostActionRecord | None` — returns `_current` **only if** `status == "pending"` and `now - requested_at <= max_pending_age_s`; if pending but stale, transitions it to `expired` and returns `None` (server-side staleness sweep).
  - `claim(id, now) -> Literal["claimed","conflict","unknown"]` — **compare-and-set**: only `pending → running` for a matching id succeeds (`"claimed"`); an id that is already `running`/`done`/`failed`/`expired` returns `"conflict"`; a non-matching id returns `"unknown"`. This is the atomic guard that stops two worker lives from both executing.
  - `record_result(id, status, detail, result, now) -> bool` — sets terminal status on the matching `running` (or `pending`, tolerated) record, stamps `result_at`, pushes to `_history`. Ignores unknown ids (returns `False`).
  - `get(id) -> HostActionRecord | None`, `latest() -> HostActionRecord | None`, `history() -> list`.
- **Staleness (server):** `max_pending_age_s = 120.0`. A queued action older than that is `expired`, never handed to the worker (guards the "owner clicked reboot, worker was offline for an hour, comes back and reboots unexpectedly" footgun).
- Load-on-import restores `_current`/`_history` from the sidecar (best-effort; corrupt file → empty).

### 1.3 Server↔worker routes — add to `server/app/routes/_internal.py` (UNAUTH, per CLAUDE.md pin "`/api/_internal/*` is never auth-gated"; do **not** add `dependencies=[...]`)

```
GET  /api/_internal/host_action
     → {"action": {id, kind, args, requested_at} | null}     # only pending & non-stale; calls host_bridge.peek()

POST /api/_internal/host_action/claim   body {"id": str}
     → {"result": "claimed" | "conflict" | "unknown"}         # host_bridge.claim(); atomic pending→running

POST /api/_internal/host_action/result  body:
     {"id": str, "status": "done"|"failed", "detail": str|null, "result": {...}|null}
     → {"ok": bool}                                           # host_bridge.record_result()
```

- Validate bodies with `extra='forbid'` Pydantic models (`_ClaimBody`, `_ResultBody`). `status` regex `^(done|failed)$`. `detail` `max_length=512`. `result` bounded (see E §5.4 for the log payload cap — enforce a hard `len(json.dumps(result)) <= 64_000` server-side belt so a compromised worker can't pump megabytes).
- These are the worker's only new server surface. They live on `_internal` so they need no cookies (the worker has none).

### 1.4 Worker side — new module `detection/host_action.py` (**Python 3.6 compatible**)

**Run the `py36-compat-guard` skill before writing this file.** No `from __future__ import annotations`, no PEP-604 unions (`X | None`), no PEP-585 generics (`list[x]`), no walrus, no `match`, no f-strings-that-carry-logic (use `.format()` — the rest of `detect.py` already does).

**Pure decision core (offline-testable, zero I/O):**

```python
PLAN_EXECUTE       = "execute"
PLAN_SKIP_STALE    = "skip_stale"
PLAN_SKIP_SEEN     = "skip_seen"
PLAN_SKIP_UNKNOWN  = "skip_unknown"

VALID_KINDS = ("mediamtx", "nvargus", "reboot", "logs")

def plan_action(record, now, seen_ids, max_age_s=90.0):
    """Pure. Decide whether to execute a polled host-action record.
    record: the dict from GET /host_action ('action' field) or None.
    seen_ids: set of ids this worker (across restarts, loaded from disk) already executed.
    Returns one of PLAN_* — NO side effects."""
    if not record:
        return PLAN_SKIP_UNKNOWN
    rid = record.get("id")
    if record.get("kind") not in VALID_KINDS:
        return PLAN_SKIP_UNKNOWN
    if rid in seen_ids:
        return PLAN_SKIP_SEEN            # idempotency: never re-run an id we already ran
    requested_at = record.get("requested_at")
    try:
        age = now - float(requested_at)
    except (TypeError, ValueError):
        return PLAN_SKIP_UNKNOWN
    if age < 0 or age > max_age_s:
        return PLAN_SKIP_STALE           # staleness: ignore ancient queued actions (esp. reboot)
    return PLAN_EXECUTE
```

**Executor (thin adapter; subprocess mocked at boundary in tests):** `execute_action(record, deps)` where `deps` is a small struct/namedtuple of injected callables:
`deps.restart_mediamtx`, `deps.restart_nvargus`, `deps.do_reboot`, `deps.tail_journal`, `deps.allow_reboot` (bool), plus `deps.now`. Returns `(status, detail, result_dict)`.

- `kind == "mediamtx"` → `ok = deps.restart_mediamtx()`; status `done`/`failed`.
- `kind == "nvargus"` → `ok = deps.restart_nvargus()` (this is `escalate_argus_recovery`).
- `kind == "reboot"` → **if not `deps.allow_reboot`: return `("failed", "reboot disabled by DETECT_WATCHDOG_ALLOW_REBOOT=0", None)`** (worker is the source of truth for the env opt-out — the server can't see it). Else `deps.do_reboot()` (which itself honors the `last_reboot_at` boot-loop guard). Note: on a real reboot the process dies before it can POST `done` — the post-reboot fresh worker resolves this via `seen_ids` (see §1.5).
- `kind == "logs"` → `lines = deps.tail_journal(unit, since, lines)`; status `done`, `result = {"lines": lines}`. See §5 for `tail_journal`.

### 1.5 Worker poll loop + idempotency across restart — wire into `detection/detect.py`

New daemon thread `start_host_action_poll(base_url, deps, interval_s=4.0)` — **separate, faster cadence than the 30 s config poll** so a manual recovery click feels responsive (~≤4 s). Uses the same `urllib.request` + backoff idiom as `start_config_poll`/`start_heartbeat`.

Loop per tick:
1. GET `/api/_internal/host_action`. If `action` is null → sleep, continue.
2. `plan = plan_action(action, deps.now(), _SEEN_IDS)`.
   - `SKIP_SEEN`/`SKIP_STALE`/`SKIP_UNKNOWN`: if the server still shows it `pending`/`running` we should not leave it dangling — POST `result` with `status="failed"`, `detail="skipped: <plan>"` **only for SKIP_STALE/SKIP_UNKNOWN**; for `SKIP_SEEN` POST `status="done", detail="already executed (post-restart)"` so a reboot that actually happened resolves to `done`. Then continue.
   - `EXECUTE`: POST `/host_action/claim {id}`. If response `!= "claimed"` → another claimant won; continue (idempotency).
3. **Persist the id to `_SEEN_IDS` and to disk BEFORE executing** (`<recordings_dir>/.host_action_seen.json`, keep last ~50 ids). This is the reboot-safety linchpin: if `_do_reboot` kills us, the fresh worker loads `_SEEN_IDS`, `plan_action` returns `SKIP_SEEN`, and it reports `done` instead of rebooting again.
4. Acquire `_RECOVERY_LOCK` (see §1.6), call `execute_action`, release.
5. POST `/host_action/result {id, status, detail, result}`.

`deps` for reboot must reuse the existing `_do_reboot` / `restart_mediamtx` / `escalate_argus_recovery` functions and `_allow_reboot`. Wire `deps.tail_journal` to the new §5.2 function.

### 1.6 No-fight-with-the-autonomous-watchdog (mandatory invariants)

1. **Same functions, no state reset.** Manual actions call `restart_mediamtx` / `escalate_argus_recovery` / `_do_reboot` directly. They **must not** touch `mediamtx_watchdog.level`, `_WATCHDOG_STATE["level"]`, `_persist_watchdog_level`, or `_clear_watchdog_escalation`. A manual mediamtx kick does not de-escalate or re-arm the autonomous ladder.
2. **Reboot guard is shared and honored.** `_do_reboot` already reads `_WATCHDOG_STATE["last_reboot_at"]` and suppresses within 1800 s → a manual reboot that lands right after an autonomous reboot correctly degrades to a nvargus restart. Do not bypass it.
3. **Serialize subprocess side effects.** Add module-global `_RECOVERY_LOCK = threading.Lock()`. Wrap **both** the watchdog's execution block in `_handle_capture_failure` (the `if action is not None:` body, `detect.py:1261`) **and** the host-action executor call in the lock (use `with _RECOVERY_LOCK:`). systemctl is roughly serial anyway, but this removes any interleave of a manual reboot with an autonomous nvargus restart.
4. **Env opt-out wins.** `DETECT_WATCHDOG_ALLOW_REBOOT=0` disables manual reboot too (enforced in `execute_action`, §1.4).

### 1.7 Bridge tests (offline, thorough)

- **Worker `detection/tests/test_host_action.py`** (BDD-lite, subprocess mocked at boundary per CLAUDE.md — `sys.modules` stub for jetson_* not needed since `host_action.py` is stdlib-only; mock the injected `deps` callables):
  - `plan_action`: Given a fresh pending record When planned Then EXECUTE; Given id in seen_ids Then SKIP_SEEN; Given `requested_at` 200 s old Then SKIP_STALE; Given negative age (clock skew) Then SKIP_STALE; Given unknown kind Then SKIP_UNKNOWN; Given None Then SKIP_UNKNOWN; Given corrupt `requested_at` Then SKIP_UNKNOWN.
  - `execute_action`: each kind maps to the right `deps` callable; reboot with `allow_reboot=False` returns `failed` + the env-opt-out detail and **never calls `do_reboot`**; a `deps.restart_mediamtx` returning False → `failed`.
  - Idempotency: two sequential executes of the same id (seen set carried) → second is SKIP_SEEN, `do_reboot` called at most once.
- **Worker `detection/tests/test_py36_compat.py`** auto-covers `host_action.py` via the AST scanner (it globs `detection/*.py`). Just confirm it's picked up.
- **Server `server/tests/test_host_bridge.py`**: `enqueue` de-dupes onto a live pending record; `peek` hides a stale pending and transitions it to `expired`; `claim` is compare-and-set (pending→running once, second claim → `conflict`, wrong id → `unknown`); `record_result` sets terminal + pushes history + ignores unknown ids; persistence round-trips through the JSON sidecar; corrupt sidecar → empty store. Inject `now` — never monkeypatch `time`.
- **Server `server/tests/test_internal.py`**: the three new routes are reachable **without auth** (use `client_anon`); `claim`/`result` bodies are `extra='forbid'`; oversized `result` payload rejected.

---

## 2. Owner-gating, confirm, audit (shared prerequisites for D)

### 2.1 Audit table — extend `server/app/services/audit_db.py`

Add a third table + helpers (mirror the existing `auth_events`/`view_events` pattern exactly — `INSERT OR IGNORE`, `0o600`, WAL, indexed `ts DESC`):

```sql
CREATE TABLE IF NOT EXISTS host_action_events (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    ts        REAL NOT NULL,
    username  TEXT NOT NULL,
    action    TEXT NOT NULL CHECK(action IN ('mediamtx','nvargus','reboot','logs')),
    request_id TEXT NOT NULL,
    phase     TEXT NOT NULL CHECK(phase IN ('requested','result')),
    status    TEXT,          -- null on 'requested'; terminal status on 'result'
    detail    TEXT
);
CREATE INDEX IF NOT EXISTS host_action_events_ts ON host_action_events(ts DESC);
```

- `insert_host_action_event(path, *, ts, username, action, request_id, phase, status, detail)`.
- `host_action_events_between(path, *, since, until, limit)` for the (optional) history UI.
- Write a `phase='requested'` row when an owner enqueues (§4.2); write a `phase='result'` row when the terminal result lands (server learns it via `POST /host_action/result` → also audit there, best-effort). **Never audit log line contents** (Slice E), only the fact of the request + status.

### 2.2 Gating + confirm

- All Slice D/E client-facing routes use `dependencies=[Depends(require_role("owner"))]` (transitional `admin`-as-`owner` carve-out already lives in `require_role`).
- **Confirm-required:** recovery request bodies must carry `confirm: true` (Pydantic field, no default) — a missing/false confirm → `422`/`400`. This is the server-side belt behind the client confirm dialog.

---

## 4. Slice D — manual recovery ladder (commit 2, on top of the bridge)

### 4.1 Un-stub `POST /api/system/reboot` (`server/app/routes/control.py:197`)

Replace the fake-ok body. Now it **enqueues a `reboot` host-action** through the bridge and returns the request handle. Keep the response backward-compatible with the existing client `rebootJetson` (`client/src/lib/api.ts:321`, expects `{ok, note?}`):

```python
@router.post("/system/reboot", dependencies=[Depends(require_role("owner"))])
async def system_reboot(body: _ConfirmBody, user: str = Depends(get_current_user)):
    rec = host_bridge.enqueue("reboot", {}, requested_by=user, now=time.time())
    audit_db.insert_host_action_event(..., action="reboot", request_id=rec["id"],
                                      phase="requested", status=None, detail=None)
    alive = worker_health.is_alive()
    return {
        "ok": True,
        "request_id": rec["id"],
        "status": rec["status"],
        "worker_online": alive,
        "note": ("Reboot queued — the Jetson will go down shortly."
                 if alive else
                 "Reboot queued, but the detection worker is offline; "
                 "it will run when the worker reconnects (or expires in 2 min)."),
    }
```

`_ConfirmBody` = `{confirm: bool}` with `extra='forbid'` and no default on `confirm`.

### 4.2 New `POST /api/system/recover`

```
POST /api/system/recover   (owner-gated)
body: {"action": "mediamtx"|"nvargus"|"reboot", "confirm": true}
→ {"ok": true, "request_id": str, "status": "pending", "worker_online": bool, "note": str}
```

- Pydantic `_RecoverBody`: `action: str = Field(pattern=r"^(mediamtx|nvargus|reboot)$")`, `confirm: bool` (no default), `extra='forbid'`.
- Enqueue via `host_bridge.enqueue(action, {}, requested_by=user, now)`, audit `phase='requested'`, return handle. (`reboot` here is equivalent to `/system/reboot`; keep both — `/system/reboot` stays for the existing button, `/system/recover` is the general ladder.)

### 4.3 New `GET /api/system/recover/status`

```
GET /api/system/recover/status?request_id=<id>   (owner-gated)
→ {request_id, action, status, detail, requested_by, requested_at, result_at, worker_online}
GET /api/system/recover/status   (no id) → latest record (or {status:"none"})
```

- Reads `host_bridge.get(id)` / `host_bridge.latest()`. `worker_online` from `worker_health.is_alive()` so the UI can say "restarting nvargus…" vs "worker offline, queued".
- Status values map straight to UI copy: `pending` → "Queued…", `running` → "Restarting nvargus…", `done` → "Done", `failed` → detail string, `expired` → "Timed out — worker never picked it up".

### 4.4 When the worker reports the terminal result

The server learns the outcome in `POST /api/_internal/host_action/result` (§1.3). In that handler, after `host_bridge.record_result(...)`, also write the `phase='result'` audit row (best-effort). No push notification needed (owner is watching the panel), but a `homecam:` WS broadcast of `{type:"host_action", id, status}` is a nice-to-have if cheap — **optional, not required for this slice**.

### 4.5 Client — `lib/api.ts` + a GodView recovery panel

- `lib/api.ts`:
  - `recoverHost(action: 'mediamtx'|'nvargus'|'reboot') => req<RecoverHandle>('/api/system/recover', {method:'POST', body: JSON.stringify({action, confirm:true})})`.
  - `getRecoverStatus(requestId?: string) => req<RecoverStatus>('/api/system/recover/status' + (requestId ? `?request_id=${...}` : ''))`.
  - Update `rebootJetson` return type to `RecoverHandle` (it now returns `request_id`/`status`) — **this is a wire change; update `lib/api.test.ts`.**
  - Types `RecoverHandle` / `RecoverStatus` mirror §4.2/§4.3 exactly.
- `client/src/pages/GodView.tsx` (already owner-gated: `Navigate` guard + `useAuth`): add a **Recovery** card with three ladder buttons (Restart camera feed → `mediamtx`; Reset camera daemon → `nvargus`; Reboot Jetson → `reboot`), each behind a **confirm dialog** (reuse existing confirm/modal primitive; the destructive one — reboot — gets the strongest copy). After a request, **poll `getRecoverStatus(requestId)`** every ~2 s until terminal, showing a live status pill ("Restarting nvargus… / Done / Failed: …"). Use the GodView-derived-loading pattern (request-key on settled result, no setState outside promise handlers — see commit `2a94bdf`). Owner-gate the buttons; Playroom Modern theme (pill/1.5px border grammar, ink primary for the confirm, alert-red is NOT from the identity system — destructive uses the failure red).
- Copy: no em-dashes, no emojis, Playroom voice.

### 4.6 Slice D tests

- **Server `test_control.py`** (BDD-lite, async route, `conftest` reset for the new `host_bridge` module global — add a `_reset_host_bridge` fixture like `_reset_timelapse_state`):
  - Given anon When POST `/system/recover` Then 401 (use `client_anon`); Given owner + `confirm:false` Then 422/400; Given owner + valid Then 200 + `request_id` + a `pending` record enqueued + a `requested` audit row.
  - `/system/reboot` un-stub: returns `request_id`, enqueues a `reboot` kind, no longer returns the scaffold note.
  - `/system/recover/status`: reflects `pending` → (simulate worker result via `host_bridge.record_result`) → `done`/`failed`.
  - `worker_online:false` path when `worker_health` shows dead.
- **Client `lib/api.test.ts`**: pin `recoverHost` body (`{action, confirm:true}`), `getRecoverStatus` URL + shapes, updated `rebootJetson` shape.
- **Client `GodView.test.tsx`**: buttons owner-gated; confirm dialog required before the request fires; status pill transitions on polled result; reboot button carries the strongest confirm copy.

---

## 5. Slice E — in-app log tail (commit 3, on top of the bridge)

No log read-back exists today (client `lib/log.ts` and journald are write-only). Transport decision: **on-demand bounded fetch through the same host-bridge** (a `kind:"logs"` action), **not** a constant ring shipped on the heartbeat — avoids steady traffic and keeps the heartbeat contract untouched. The worker is on the host, so it tails `journalctl` and ships back **bounded, secret-scrubbed** lines.

### 5.1 Server routes — `server/app/routes/control.py`

```
GET /api/system/logs?unit=<u>&since=<s>&lines=<n>   (owner-gated)   # ENQUEUE
   unit  ∈ {homecam-detect, mediamtx, nvargus-daemon, homecam-server}  (strict enum → 422 otherwise)
   since : optional, journalctl --since string, whitelisted subset (see 5.3)
   lines : int, clamped 1..1000 (default 200)
   → {"request_id": str, "status": "pending", "worker_online": bool}

GET /api/system/logs/result?request_id=<id>         (owner-gated)   # POLL
   → {request_id, unit, status, lines: string[]|null, detail: str|null}
```

- Rationale for two calls: the worker fetch is asynchronous over the bridge, so the first GET **enqueues** a `logs` host-action and returns a handle; the client polls `/logs/result` until `status=="done"` and `lines` is present. (A single synchronous GET would block the request on the worker round-trip — rejected.)
- `unit` validated against a literal enum (`_LOG_UNITS`), never interpolated raw into anything.
- Enqueue `host_bridge.enqueue("logs", {"unit":..., "since":..., "lines":...}, requested_by=user, now)`. Audit `phase='requested'` (unit + request_id only, **never line contents**).
- `/logs/result` reads `host_bridge.get(id)` and returns `result["lines"]` when `done`.

### 5.2 Worker `tail_journal(unit, since, lines)` — in `detection/host_action.py` (Python 3.6)

```python
_LOG_UNITS = ("homecam-detect", "mediamtx", "nvargus-daemon", "homecam-server")

def tail_journal(unit, since, lines, runner=subprocess.run, now=None):
    if unit not in _LOG_UNITS:
        return []                      # defense in depth; server already enum-gated
    n = max(1, min(int(lines or 200), 1000))
    cmd = ["sudo", "-n", "journalctl", "-u", unit, "-n", str(n),
           "--no-pager", "-o", "short-iso"]
    since_arg = _sanitize_since(since)     # 5.3 — whitelist only
    if since_arg:
        cmd += ["--since", since_arg]
    out = runner(cmd, timeout=10.0, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    text = out.stdout.decode("utf-8", "replace")
    return scrub_lines(text.splitlines(), max_lines=n)   # 5.4
```

`runner` is injected so tests mock the subprocess at the boundary (no real journalctl on the dev box).

### 5.3 `_sanitize_since(since)` — whitelist, don't sanitize-in-place

Accept only a small safe set; reject everything else (return `None` → journalctl defaults to full tail bounded by `-n`):
- relative forms matching `^-?\d{1,3}\s+(second|minute|hour|day)s?( ago)?$` (e.g. `"30 minutes ago"`, `"2 hours"`),
- absolute `^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}(:\d{2})?)?$`.
Anything else → `None`. This closes journalctl-flag/shell injection via `since` even though `subprocess.run` with a list already prevents shell expansion.

### 5.4 `scrub_lines(lines, max_lines)` — SECRET SCRUB (cite CLAUDE.md logging rule)

CLAUDE.md logging guardrail: *"NEVER log passwords, token/cookie bytes, full request bodies, or full SDP."* The log tail must not become a bypass of that rule. Scrub on the **worker side before shipping** (defense at the source):

- Drop or redact any line matching (case-insensitive) `token`, `password`, `passwd`, `secret`, `authorization`, `bearer`, `cookie`, `set-cookie`, `jwt`, `vapid`, `api[_-]?key`, `private[_-]?key`, `x-api-key`. **Redact** (replace the value after the key with `***`) rather than drop the whole line, so surrounding context survives; if no `key=value`/`key: value` shape is found, drop the line entirely.
- Redact long opaque blobs: base64-ish runs `[A-Za-z0-9+/=]{24,}` and hex runs `[0-9a-f]{24,}` → `***`.
- Bound each line to 2000 chars; cap total returned lines to `max_lines`.
- Pure and stdlib-only → fully unit-testable offline.

### 5.5 Client — `lib/api.ts` + GodView log viewer

- `lib/api.ts`: `fetchLogs(unit, opts?) => req<LogHandle>('/api/system/logs?...')`; `getLogsResult(requestId) => req<LogResult>('/api/system/logs/result?request_id=...')`. Types mirror §5.1.
- `GodView.tsx`: a **Logs** card — unit `<select>` (the 4 units, labeled human-friendly: "Detection worker / Camera server (MediaMTX) / Camera daemon (nvargus) / API server"), a lines control, a **Refresh** button. On refresh: `fetchLogs` → poll `getLogsResult` until `done` → render `lines` in a **monospace, read-only, auto-scroll-to-bottom** panel following Playroom Modern (dark ink surface reads well for logs; theme-aware). Read-only — no actions on lines. Owner-gated (same GodView guard).
- Accessibility: the log region gets an accessible name (`aria-label="System logs"`), the unit select a `<label>` (project pins `getByLabelText`).

### 5.6 Slice E tests

- **Worker `test_host_action.py`**: `scrub_lines` redacts each secret keyword variant + base64/hex blobs, drops a keyworded line with no value shape, caps line length + count (BDD-lite, table of Given secret-bearing line / Then redacted). `_sanitize_since` accepts the whitelist forms, rejects `"; rm -rf"`, backticks, `--flag` smuggling. `tail_journal` builds the right argv, honors the unit enum, and passes output through the scrubber (mock `runner`).
- **Server `test_control.py`**: `/system/logs` enum-gates `unit` (422 on a bad unit), clamps `lines`, owner-gates (`client_anon` → 401), enqueues a `logs` action; `/system/logs/result` returns `lines` once a `record_result` with a logs payload lands; audit row carries unit + request_id but **no line contents** (assert the audited detail never contains a fixture secret).
- **Client `lib/api.test.ts`** + a `GodView.test.tsx` (or split `LogViewer.test.tsx`): URL/param shaping, poll-until-done, monospace/read-only render, unit label present, owner gate.

---

## 3. (renumbered) Cross-cutting concerns

### 3.6 Wire-contract mirror list — **run the `wire-contract-sync` skill; every row changes together**

| Boundary | Server | Worker | Client |
|---|---|---|---|
| host-bridge poll/claim/result | `routes/_internal.py` (3 routes), `services/host_bridge.py`, `services/audit_db.py` | `detection/host_action.py`, `detection/detect.py` (poll thread + deps wiring + `_RECOVERY_LOCK`) | — |
| recover (D) | `routes/control.py` (`/system/recover`, `/system/recover/status`, un-stub `/system/reboot`) | (executes via bridge) | `lib/api.ts` (`recoverHost`, `getRecoverStatus`, `rebootJetson` shape), `pages/GodView.tsx` |
| logs (E) | `routes/control.py` (`/system/logs`, `/system/logs/result`) | `host_action.py` (`tail_journal`, `_sanitize_since`, `scrub_lines`) | `lib/api.ts` (`fetchLogs`, `getLogsResult`), `pages/GodView.tsx` |
| tests pinning the above | `test_internal.py`, `test_control.py`, `test_host_bridge.py`, `test_audit_db.py` | `tests/test_host_action.py`, `tests/test_py36_compat.py` | `lib/api.test.ts`, `pages/GodView.test.tsx` |

- **Heartbeat contract is untouched** — do **not** add a field to `/api/_internal/heartbeat` or to `_ALLOWED_METRIC_FIELDS`; the bridge is its own channel. (This deliberately avoids the 3-way metric-symmetry pin.)
- Config-poll (`/api/_internal/detection/config`) is untouched.

### 3.7 Commit plan (separable)

1. **Commit 1 — bridge:** `host_bridge.py`, the 3 `_internal` routes, `host_action.py` (`plan_action` + `execute_action` core), the worker poll thread + `_RECOVERY_LOCK`, `_SEEN_IDS` persistence, all bridge tests. No user-facing surface yet.
2. **Commit 2 — Slice D:** audit table, `/system/recover` + `/system/recover/status`, un-stub `/system/reboot`, client `recoverHost`/status + GodView Recovery panel, D tests.
3. **Commit 3 — Slice E:** `tail_journal`/`_sanitize_since`/`scrub_lines`, `/system/logs` + `/logs/result`, client log viewer, E tests.

Each commit is green on its own suite (server pytest, worker pytest incl. py36 scanner, client vitest + typecheck + lint) with the Jetson OFF.

---

## 6. Live-verification (operator, Jetson ON — deferred, cannot be done in dev)

None of the below runs on the dev laptop. After all three commits are green offline, on a Jetson-on session:

1. Cross-build + deploy server (`deploy/cross-deploy-server.sh`) and rsync the worker (`detection/` → `ssh jetson 'sudo systemctl restart homecam-detect'`) and client dist.
2. In GodView → Recovery: **Restart camera feed** → confirm the WHEP tile drops and re-acquires; status pill goes pending → running → done. Check `journalctl -u mediamtx` shows the restart.
3. **Reset camera daemon** (`nvargus`) → confirm nvargus-daemon + mediamtx bounce, feed recovers.
4. **Reboot** (last) → confirm the Jetson reboots exactly once (not a loop), the post-reboot worker reports the action `done` via `_SEEN_IDS` (no second reboot), and the 1800 s boot-loop guard blocks an immediate re-reboot. Verify `DETECT_WATCHDOG_ALLOW_REBOOT=0` makes the reboot request come back `failed` with the opt-out detail.
5. Logs: fetch each of the 4 units; confirm real journald lines render and that **no secret** appears (grep the response for `token`/`vapid`/`password` → must be `***`).
6. Confirm a manual action mid-outage does **not** reset the autonomous watchdog escalation `level` (inspect `<recordings_dir>/.watchdog_state.json` before/after).

The offline test core (§1.7, §4.6, §5.6) is the real safety net; this list is confirmation only.
