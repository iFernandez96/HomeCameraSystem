# Slice C — Logged-in Sessions (see / revoke / watching-now)

Implementation-ready spec for codex gpt-5.5. Repo: self-hosted Ring-style camera
(FastAPI server in Docker + React 19 / TS / Tailwind-v4 PWA). Read `CLAUDE.md`
first — its wire-contract, py36, logging, and theme invariants are load-bearing.

**Owner wants three powers:** (1) SEE the list of logged-in sessions,
(2) REVOKE a session, (3) a live "WATCHING NOW" indicator.

This is **net-new infrastructure** — the feature has zero backing data today.
Build it **standalone-first** (`standalone-first-feature-dev`): isolate the pure
decision logic into dependency-free, offline-BDD-tested modules FIRST, then wire
tokens / DB / routes / UI on top of proven cores.

---

## 0. Current state (verified against code, 2026-07-08)

Auth is **fully stateless JWT** — there is no session concept to hang this on:

- `server/app/auth/tokens.py` — `issue(username, kind, *, role, now)` and
  `decode(token, *, kind)`. HS256, secret via `jwt_secret.load_or_generate`.
  Claims today: **`sub`, `kind`, `role`, `iat`, `exp`**. **No `jti`, no session
  id, no device id, no blocklist.** `decode` re-checks `kind` after PyJWT
  (`tokens.py:143`) — a wrong-kind but validly-signed token raises
  `InvalidToken`. This re-check is **load-bearing** (pinned by
  `test_decode_rejects_kind_mismatch_*`) and MUST survive unchanged.
- `server/app/routes/auth.py` — `_set_session_cookies` (`:117`) mints access+
  refresh on **login** (`:163`) and **refresh** (`:196`); `logout` (`:252`)
  clears cookies (no server state to kill). `/me` (`:549`) decodes the access
  cookie. Cookies `homecam_access` / `homecam_refresh`, HttpOnly, SameSite=Strict,
  Path=/api.
- `server/app/auth/dependencies.py` — `get_current_user` (`:99`, strict 401),
  `get_current_user_optional` (`:45`), `get_current_user_role` (`:156`),
  `require_role(required)` (`:234`) with the legacy **`admin`→`owner`** carve-out
  (`:269`). Every strict path already does a `users_db.get_user` roundtrip per
  request (~0.5 ms Jetson eMMC) — the sessions `last_seen` write piggybacks here.
- `server/app/auth/users_db.py` — `users(username PK, password_hash, role,
  created_at)`. Establishes the DB conventions we mirror: pre-create file
  **0o600 via `os.open` before `sqlite3.connect`** (`:99`), WAL, connection-
  per-call `_connect` ctx mgr, idempotent `CREATE IF NOT EXISTS`.
- `server/app/services/audit_db.py` — `auth_events(id, ts, username, action, ua)`
  is the **only** historical auth record today. `insert_auth_event` is called
  from login/refresh/logout. Same 0o600/WAL conventions.
- `server/app/routes/events.py:490` — `events_ws` handshake decodes the access
  cookie (`:548`), resolves `sub` (`:561`), then `event_bus.subscribe()`. **This
  is where "watching now" attaches.** No per-connection registry beyond
  `event_bus._subs` (a bare list of queues, no username tag) —
  `server/app/services/event_bus.py:98`.
- `server/app/main.py:384` `/api/status` (owner/any-authed) exposes
  `push_subs_count = len(push_service.subs)` (`:453`) — the precedent pattern for
  a live count. Lifespan `init_db` calls at `:112`/`:122` are where we add
  `sessions_db.init_db`.
- Client owner check is copy-pasted (`user?.role === 'owner' || user?.role ===
  'admin'`) in `Settings.tsx:82`, `Events.tsx:63`, `ClipModal.tsx:141`,
  `AccountSection.tsx:18`. Reuse `AccountSection`'s `isOwner` grain.
- Client wire wrappers + types live in `client/src/lib/api.ts`; the admin
  block (`getAdminAudit`, `adminListUsers`, …) at `:878+` is the pattern to
  follow. Mirror tests in `client/src/lib/api.test.ts` ↔ `server/tests/test_*.py`
  (wire-contract-sync).

**WHEP reality:** live WebRTC video is pulled straight from **MediaMTX**, not the
FastAPI server (browser `webrtc.ts` → MediaMTX WHEP). The server **cannot**
observe who holds a WHEP video stream without scraping MediaMTX's API — out of
scope. Therefore **"watching now" is scoped to WS presence + `last_seen`
recency** (see §7). Say this plainly in the UI copy.

---

## 1. Standalone-first: pure cores (build + prove these FIRST)

Three dependency-free modules under `server/app/sessions/` — **no `sqlite3`, no
`fastapi`, no network, no `time.time()` inside the decision** (inject `now`).
Each ships with an offline BDD-lite test (`Given/When/Then` names, `# arrange /
act / assert` bodies) using **real captured fixtures** (real UA strings, real
remote-addr values), never hand-waved happy-path strings.

These run on the server's Python 3.11 (NOT the detection worker) — **py36 compat
does NOT apply here**; do not import the py36 guard. Standard server style
(`from __future__ import annotations`, type hints) is fine.

### 1a. `server/app/sessions/device_parse.py`

```
def device_label(ua: str) -> str
```

Hand-rolled UA → `"Chrome on Pixel 7"` / `"Safari on iPhone"` /
`"Firefox on Windows"` / `"Chrome on Android"` / `"Edge on Windows"`. NO heavy
dependency (no `ua-parser`, no `user-agents`). A small ordered match table:

- **Browser** (first hit wins, order matters — Edge before Chrome, Chrome before
  Safari, since Edge/Chrome UAs contain "Safari"): Edg → Edge, OPR/Opera → Opera,
  Firefox → Firefox, Chrome/CriOS → Chrome, Safari → Safari, else "Unknown
  browser".
- **Device/OS**: explicit model tokens first (`Pixel 7`, `Pixel 8`, `SM-…`→
  "Galaxy", `iPhone`, `iPad`), then OS families (Android→"Android",
  `Windows NT`→"Windows", `Mac OS X`→"Mac", `Linux`→"Linux", `CrOS`→
  "Chromebook"), else "Unknown device".
- Compose `"{browser} on {device}"`. If both unknown → `"Unknown device"`
  (don't emit "Unknown browser on Unknown device").

**Robust to junk:** empty string, `None`-ish (`ua or ""`), 4 KB of garbage
(cap scan length), non-ASCII, deliberately spoofed. **Never raises.** Truncate
the raw UA to 256 chars before scanning (matches `audit_db` `ua[:256]`).

**Fixtures:** capture REAL UAs — the owner's actual phone/laptop hitting the dev
server (grep journald `client_log:` lines or read `request.headers['user-agent']`
once), plus a canonical set (iOS Safari, Android Chrome, desktop Chrome/Firefox/
Edge, a bot/curl UA, empty). Store as `server/tests/fixtures/user_agents.json`
(`[{"ua": "...", "expect": "Chrome on Pixel 7"}]`).

Test: `server/tests/test_sessions_device_parse.py` — one `Given/When/Then` per
fixture + junk-robustness cases.

### 1b. `server/app/sessions/ip_class.py`

```
def ip_class(remote_addr: str | None) -> str   # "lan" | "tailscale" | "cellular" | "other"
```

Classify the caller's IP into human buckets (used for the "where from" column):

- **`tailscale`** — `100.64.0.0/10` (CGNAT range Tailscale uses) AND the IPv6
  Tailscale ULA `fd7a:115c:a1e0::/48`.
- **`lan`** — RFC1918 (`10/8`, `172.16/12`, `192.168/16`), loopback
  (`127/8`, `::1`), and link-local (`169.254/16`, `fe80::/10`). **Order matters:
  test Tailscale's `100.64/10` BEFORE the general "public" fallthrough — it is
  NOT RFC1918 so it must be matched explicitly first.**
- **`cellular`** — the bucket label for **any other globally-routable/public
  address** (a phone off-Tailscale on mobile data reaches the server as a public
  src IP). We cannot truly distinguish "cellular" from "other public" at L3, so
  **the bucket is named `cellular` but means "public internet"** — document this
  in the module docstring and surface it in the UI as "Cellular / public".
- **`other`** — unparseable / `None` / empty.

Implement with stdlib **`ipaddress`** only (`ip_address()`, `.is_private`,
`.is_loopback`, `.is_link_local`, explicit `ip_network("100.64.0.0/10")`
membership). Never raises — wrap parse in try/except → `"other"`.

**Note on source:** the caller IP must come from `request.client.host`
**after** honoring a trusted proxy header only if one is configured. On this
deploy there is **no** reverse proxy in front of uvicorn by default (Tailscale
terminates at the host), so `request.client.host` is correct. Do **not** trust
`X-Forwarded-For` unless `settings` gains an explicit trusted-proxy flag —
spoofable. State this in the docstring.

**Fixtures:** `server/tests/fixtures/ip_samples.json`
(`[{"ip": "100.101.102.103", "expect": "tailscale"}, {"ip": "192.168.1.5",
"expect": "lan"}, {"ip": "8.8.8.8", "expect": "cellular"}, {"ip": "", "expect":
"other"}]`). Include the owner's real Tailscale IP prefix if captured.

Test: `server/tests/test_sessions_ip_class.py`.

### 1c. `server/app/sessions/revocation.py`

Pure revocation decision — the piece that must be **impossible to get wrong**:

```
def is_revoked(jti: str, revoked_ts: float | None, now: float) -> bool
def should_write_last_seen(prev_last_seen: float, now: float, throttle_s: float) -> bool
```

- `is_revoked` → `True` when `revoked_ts is not None and revoked_ts <= now`.
  (A future-dated `revoked_ts` is not yet in effect — keeps the door open for
  scheduled revocation; today callers always pass `now` at revoke time so it's
  immediate.)
- `should_write_last_seen` → `True` when `now - prev_last_seen >= throttle_s`.
  This is the **throttle gate** so we don't write to SQLite on every authed
  request (see §2). Default `throttle_s` = **60.0**.

Both are trivial but isolating them means the throttle + the "is this session
dead" decision are unit-tested with zero DB. Test:
`server/tests/test_sessions_revocation.py` — boundary cases (exactly at
throttle, revoked_ts == now, None, future revoked_ts).

**Gate before proceeding:** all three modules green + "perfect" (junk-robust,
boundary-covered) BEFORE touching tokens/DB/routes (§2–§8).

---

## 2. Sessions store — `server/app/sessions/sessions_db.py`

New module **alongside** `users_db.py` / `audit_db.py`, mirroring their exact
conventions (0o600 pre-create via `os.open`, WAL, `_connect` ctx mgr,
connection-per-call, `CREATE IF NOT EXISTS`, `chmod` belt-and-braces).

### Schema

```sql
CREATE TABLE IF NOT EXISTS sessions (
    jti           TEXT PRIMARY KEY,      -- the ACCESS token's jti (see §3 pairing)
    refresh_jti   TEXT,                  -- the paired refresh token's jti (nullable until first refresh)
    username      TEXT NOT NULL,
    kind          TEXT NOT NULL DEFAULT 'session',  -- reserved; always 'session' today
    device_ua_raw TEXT NOT NULL,         -- truncated to 256, NEVER token bytes
    device_label  TEXT NOT NULL,         -- device_parse output
    ip_class      TEXT NOT NULL,         -- ip_class output (lan|tailscale|cellular|other)
    created_ts    REAL NOT NULL,
    last_seen_ts  REAL NOT NULL,
    revoked_ts    REAL                   -- NULL = active; set = revoked
);
CREATE INDEX IF NOT EXISTS sessions_username ON sessions(username);
CREATE INDEX IF NOT EXISTS sessions_last_seen ON sessions(last_seen_ts DESC);
```

### Functions

- `init_db(path)` — idempotent, 0o600/WAL, mirrors `users_db.init_db`.
- `create_session(path, *, jti, refresh_jti, username, device_ua_raw,
  device_label, ip_class, now)` — `INSERT OR IGNORE` (idempotent on jti PK, per
  principle #12). Called on **login** and **refresh** (see §3/§4 pairing).
- `touch_last_seen(path, jti, now)` — `UPDATE sessions SET last_seen_ts=?
  WHERE jti=? AND revoked_ts IS NULL`. Called from the auth dependency **only
  when `should_write_last_seen` says so** (throttle). Cheap single-row PK update.
- `get_session(path, jti) -> dict | None` — for the revocation check in §4.
- `revoke_by_jti(path, jti, now) -> bool` — sets `revoked_ts=now` on the row
  whose `jti` **OR** `refresh_jti` matches (kills both halves of the pair in one
  statement: `WHERE jti=? OR refresh_jti=?`). Returns `rowcount > 0`.
- `list_sessions(path, *, include_revoked, now) -> list[dict]` — ordered
  `last_seen_ts DESC`. Never returns token bytes (schema has none). The owner UI
  reads this.
- `link_refresh(path, access_jti, refresh_jti)` — set `refresh_jti` on the row
  when the access+refresh pair is minted (see §3).
- `prune(path, *, now, access_ttl_s, refresh_ttl_s)` — DELETE rows where the
  session can no longer be live: `revoked_ts IS NOT NULL AND revoked_ts < now -
  GRACE` (keep revoked rows ~24 h so the UI can show "revoked" briefly) **OR**
  `last_seen_ts < now - refresh_ttl_s` (a session idle past the refresh TTL can
  never mint a new access token, so it's dead). Run from lifespan on boot +
  opportunistically (e.g. inside `create_session` every Nth insert, or a cheap
  call each login). Keeps the table from growing unbounded.

**No SQLAlchemy/Alembic** — hand-written DDL like the sibling stores.

### Wiring

- `server/app/config.py` — add `sessions_db_path: Path =
  Path(os.getenv("SESSIONS_DB_PATH", "/app/secrets/sessions.db"))` next to
  `audit_db_path` (`config.py:151`). Same `homecam-secrets` volume so it
  survives container rebuilds.
- `server/app/main.py` lifespan (`:122` area) — add a `sessions_db.init_db(
  settings.sessions_db_path)` block mirroring the `audit_db` init, **abort boot
  on failure** (same pattern). Also call `sessions_db.prune(...)` once here.

---

## 3. Token change — add `jti` (`tokens.py`)

Add a unique `jti` claim to **both** access and refresh tokens.

- `issue(...)` gains an optional `jti: str | None = None` param. When `None`,
  generate `uuid.uuid4().hex` (import `uuid`). Put it in `payload["jti"]`.
- `decode(...)` returns the claims dict unchanged (it already returns
  `claims`), so callers can read `claims["jti"]`. **Do NOT add DB access to
  `decode`** — keep `tokens.py` pure/stateless (it's imported by tests with no
  DB). The revocation lookup lives in the **dependency layer** (§4), not in
  `decode`. This preserves `tokens.py`'s test isolation and the load-bearing
  `kind` re-check stays exactly as-is.

**Access+refresh pairing (decide — this is the pairing decision the task asks
for):** each login/refresh mints an access jti AND a refresh jti. They are
**linked in the sessions row**: the **access jti is the PK**, the refresh jti is
stored in `refresh_jti`. Rationale: the access token is the one presented on
every request (so it's the natural key for the `last_seen` touch + revocation
check); the refresh jti is recorded so `revoke_by_jti` can kill the refresh half
too (`WHERE jti=? OR refresh_jti=?`). On **refresh**, a NEW access+refresh pair
is minted — the refresh route must **carry the session forward**, not spawn a new
row every 15 min (see §4 "refresh rotation").

**Both-direction tests** (`server/tests/test_auth_tokens.py`, extend):
- `test_issue_embeds_jti` — a freshly issued token decodes to claims containing a
  non-empty `jti`.
- `test_issue_jti_is_unique_per_call` — two `issue()` calls → two different jti.
- `test_issue_accepts_explicit_jti` — passing `jti="abc"` round-trips.
- `test_decode_returns_jti` — decode surfaces the jti.
- **Preserve** `test_decode_rejects_kind_mismatch_*` unchanged (regression guard
  that the jti addition didn't disturb the kind re-check).

---

## 4. Revoke — dependency consults the store; owner route sets `revoked_ts`

### 4a. Revocation enforcement (make a revoked jti 401)

The strict auth deps in `dependencies.py` (`get_current_user`,
`get_current_user_role`) already do a `users_db.get_user` roundtrip per request.
**Extend them** (or add one shared helper they both call) to, after decoding a
valid access cookie:

1. Read `jti = claims.get("jti")`.
2. `row = sessions_db.get_session(path, jti)`.
   - If `row is None` → **legacy / pre-jti token** — see §5 graceful handling.
   - If `revocation.is_revoked(jti, row["revoked_ts"], now)` → **401**
     (`detail="session revoked"`), WARN via `auth_rejected` (`reason=
     "session revoked"`, `sub=...`). This is the mechanism that makes Revoke
     bite immediately on the next request.
3. Throttled `last_seen` write: if
   `revocation.should_write_last_seen(row["last_seen_ts"], now, 60.0)` →
   `sessions_db.touch_last_seen(path, jti, now)`. Wrap in try/except — a
   `last_seen` write failure must **never** break auth (log WARN once, continue).

Do the same jti/revoked check in the **WS handshake** (`events.py:548` area,
right after `tokens.decode` resolves `sub`) — a revoked session must be kicked
off / refused the live stream. On revoked → `ws.close(code=1008, reason="session
revoked")` (same treatment as the existing auth-fail closes; the client's
`homecam:auth-failed` path handles it).

### 4b. Refresh rotation (carry the session forward)

In `auth.py::refresh` (`:196`), after validating the refresh cookie:
- Read the **old** refresh jti from the decoded refresh claims.
- Look up the session whose `refresh_jti` == old refresh jti.
  - If found and **not revoked** → mint the new access+refresh pair, then
    `UPDATE` that same row to the new access jti (PK) + new `refresh_jti`, bump
    `last_seen_ts`. (A PK update means DELETE+INSERT or an `UPDATE
    sessions SET jti=?, refresh_jti=?, last_seen_ts=? WHERE refresh_jti=?` — a
    single-row op either way; keep created_ts/device/ip stable so the session's
    identity persists across token rotation.)
  - If the session row is **revoked** → refuse refresh (401 "session expired",
    same wire shape as existing failures) — this is what makes revoke stick even
    across a refresh attempt.
  - If **not found** (legacy session) → §5.
- `_set_session_cookies` must be updated to thread the minted jti pair into the
  session row write. Refactor `_set_session_cookies(response, username, role)` →
  it (or a sibling helper) also takes/returns the jti pair + request so login and
  refresh can persist the session (device_label from `_ua(request)`, ip_class
  from `request.client.host`).

### 4c. Owner route

`POST /api/admin/sessions/{jti}/revoke` — owner-gated, audit-logged.

- New router file `server/app/routes/sessions.py` (prefix `/admin`, tags
  `["sessions"]`), or extend an existing admin surface. Gate with
  `Depends(require_role("owner"))` (honors the legacy admin→owner carve-out).
- Handler: `sessions_db.revoke_by_jti(path, jti, now=time.time())`. Returns
  `{"ok": true}` on rowcount>0, **404** (`"no such session"`) otherwise.
- **Audit**: `audit_db.insert_auth_event(action="logout", username=<target
  session's username>, ua=<caller-tag>)` — reuse the existing `auth_events`
  table (its `action` CHECK is `login_ok|login_fail|refresh|logout`; a revoke is
  a forced logout, so `logout` is the honest existing value — do NOT widen the
  CHECK constraint just for this). Also `log.warning("session revoke: caller=%r
  revoked jti=%r (user=%r)", ...)` — NEVER log token bytes, only the jti (an
  opaque uuid, safe) + usernames.
- **Guard:** revoking your OWN current session is allowed (owner may kill a
  device they lost) but the UI must confirm (see §6). No last-owner guard needed
  here — revoking a session doesn't delete a user; they can log back in.

Register the router in `main.py` include block alongside the others.

---

## 5. Migration / graceful handling of pre-jti tokens

Existing live sessions have tokens with **no `jti`** and **no sessions row**.
Chosen policy — **legacy = a single synthetic "unknown device" session, no forced
re-login**:

- When a strict dep decodes a valid access cookie whose `claims.get("jti")` is
  **absent/empty**: treat as a **legacy session** — allow the request (do NOT
  401; forcing re-login on deploy is hostile and the CLAUDE.md refresh path
  already tolerates claim-absence gracefully). Do NOT create a sessions row for
  it (we have no stable id). Optionally attribute it to a reserved display row
  in the UI list labeled "Older session (pre-update) — will upgrade on next
  sign-in." 
- When such a session **refreshes** (within 7 days, which every active session
  will), the refresh route mints a jti-bearing pair and **creates** the sessions
  row → the session becomes fully visible + revocable. So the legacy state
  self-heals within one access-TTL (15 min) of activity.
- If `sessions_db.get_session(jti)` returns `None` for a token that DOES carry a
  jti (row pruned, or DB reset): treat as legacy too (allow) rather than 401 —
  fail-open on the presence check, fail-closed only on an explicit `revoked_ts`.
  Rationale: a pruned/missing row must not lock out a validly-signed live
  session; only an **explicit** revoke should 401. Document this asymmetry
  loudly in the dependency docstring — it's the security-sensitive call.

**Hard-logout escape hatch** (unchanged, document in the UI help text): deleting
`jwt_secret.bin` + restarting invalidates every token at once (per `tokens.py`
docstring). Revoke is the per-session tool; secret-rotation is the nuke.

---

## 6. Watching now

Server cannot see WHEP video holders (§0). Scope "watching now" to **WS
presence** (the live-events socket) + `last_seen` recency:

### 6a. Tag WS connections with the session

`event_bus` currently stores bare queues (`event_bus.py:98` `self._subs:
list[Queue]`). Add a **parallel presence registry** keyed by jti/username so we
can answer "who's connected right now":

- Add `event_bus.subscribe(*, jti=None, username=None)` params (default None →
  back-compat). Store per-queue metadata in a dict
  `self._sub_meta[id(q)] = {"jti": jti, "username": username, "since":
  now}`. `unsubscribe` pops it. Add `def active_watchers(self) -> list[dict]`
  returning `[{"jti", "username", "since"}]` for connected sockets.
- In `events_ws` (`events.py:602`), pass `jti=claims.get("jti")`,
  `username=sub` into `subscribe`. (This also gives the WS revocation check in
  §4a the jti to consult.)

This is **live** (a socket open right now = actively watching the events stream /
app foregrounded). It does NOT prove WHEP video, but on this app an open events
WS is the best server-side proxy for "app is open and watching."

### 6b. Derive `watching_now` per session

A session is `watching_now = true` when **either**: its jti is in
`event_bus.active_watchers()`, **or** `now - last_seen_ts < WATCHING_WINDOW_S`
(e.g. 30 s — a request within the last 30 s ≈ actively using the app). The WS
presence is the strong signal; the last_seen recency is the fallback for
foreground REST activity (polling `/api/status` every 5 s keeps last_seen fresh).
Compute this in the `GET /api/admin/sessions` handler, not the DB.

---

## 7. API + client

### 7a. Server: `GET /api/admin/sessions` (owner-gated)

Response (versioned per repo convention):

```json
{
  "v": 1,
  "sessions": [
    {
      "jti": "9f2c…",
      "username": "israel",
      "device_label": "Chrome on Pixel 7",
      "ip_class": "tailscale",
      "created_ts": 1720400000.0,
      "last_seen_ts": 1720400900.0,
      "is_current": true,
      "watching_now": true,
      "revoked": false
    }
  ]
}
```

- `is_current` — the row whose `jti` == the caller's own access-cookie jti
  (thread the caller's jti into the handler via a dep that returns
  `(username, jti)`, or read the cookie + decode in-handler). Mark it distinctly
  in the UI and never offer a silent self-revoke without confirm.
- `watching_now` per §6b. `revoked` = `revoked_ts is not None`.
- Default lists **active + recently-revoked** (revoked shown struck-through for
  the ~24 h grace window, then pruned). NEVER include token bytes, `ua_raw` is
  fine to include as a tooltip but `device_label` is the primary display.
- Handler pins: DB read failure → ERROR + re-raise (500, like
  `admin_list_users` `auth.py:401`), not a silently-empty list.

### 7b. Client wire wrappers — `client/src/lib/api.ts`

Mirror the `adminListUsers` block (`api.ts:950`):

```ts
export type AdminSession = {
  jti: string
  username: string
  device_label: string
  ip_class: 'lan' | 'tailscale' | 'cellular' | 'other'
  created_ts: number
  last_seen_ts: number
  is_current: boolean
  watching_now: boolean
  revoked: boolean
}
export const adminListSessions = () =>
  req<{ v: 1; sessions: AdminSession[] }>('/api/admin/sessions')
export const adminRevokeSession = (jti: string) =>
  req<{ ok: boolean }>(`/api/admin/sessions/${encodeURIComponent(jti)}/revoke`,
    { method: 'POST' })
```

Add matching cases to `client/src/lib/api.test.ts` (wire-shape pin) — one test
asserting the GET URL + parsed shape, one asserting the revoke POST URL/method.
Mirror on the server in `server/tests/test_sessions_routes.py`
(`test_list_sessions_owner_ok`, `test_list_sessions_non_owner_403`,
`test_revoke_session_owner_ok`, `test_revoke_unknown_404`,
`test_revoke_then_request_401`). This is the wire-contract-sync pair.

### 7c. Client UI — new owner-only Sessions panel

- New component `client/src/pages/settings/SessionsSection.tsx`, rendered inside
  `Settings.tsx` gated by the existing `isOwner` (mirror
  `{isOwner && <TimelapsesSection />}` at `Settings.tsx:209`). Add a settings
  tab entry / section heading "Active sessions".
- Each row: `device_label` (primary), a location chip from `ip_class`
  ("Home Wi-Fi" for lan, "Tailscale" for tailscale, "Cellular / public" for
  cellular, "Unknown" for other), relative last-seen ("active now" /
  "2 min ago" — reuse the existing relative-time formatter in `lib/format.ts`),
  a **live green "Watching now" pill** when `watching_now`, and a **Revoke**
  button.
- **Current session**: badge "This device", Revoke labeled "Sign out this
  device" and gated behind the shared confirm dialog (reuse the `confirm(...)`
  hook used in `Events.tsx:857`).
- Revoke flow: confirm → `adminRevokeSession(jti)` → optimistic remove / refetch
  → toast via `useReportError` on failure (`lib/toast`). After revoking the
  current session, the next request 401s → existing `homecam:session-expired`
  self-heal logs the user out (acceptable, expected).
- Empty state: `<CatEmptyState>` (the only empty-state primitive) — never a
  plain-text empty. Copy in Playroom voice (e.g. "No other devices signed in.").
- **Theme:** Playroom Modern, Tailwind-v4 **`bg-[var(--color-x)]`** (never
  `bg-[--color-x]`), pill/1.5px-border grammar. The "Watching now" pill uses an
  identity/positive token, **never alert red** (red = failure/destructive only).
  Revoke button is the destructive affordance. `getByRole`/`getByLabelText`
  friendly; every control has an accessible name (jsx-a11y).
- Tests: `client/src/pages/settings/SessionsSection.test.tsx` — renders rows
  from a mocked `adminListSessions`, marks current session, shows watching pill,
  confirm+revoke calls `adminRevokeSession`, empty→`CatEmptyState`. BDD-lite
  naming + AAA bodies.

---

## 8. Files to create / modify (checklist)

**Create (pure cores + tests first):**
- `server/app/sessions/__init__.py`
- `server/app/sessions/device_parse.py` + `server/tests/test_sessions_device_parse.py` + `server/tests/fixtures/user_agents.json`
- `server/app/sessions/ip_class.py` + `server/tests/test_sessions_ip_class.py` + `server/tests/fixtures/ip_samples.json`
- `server/app/sessions/revocation.py` + `server/tests/test_sessions_revocation.py`

**Create (integration):**
- `server/app/sessions/sessions_db.py` + `server/tests/test_sessions_db.py`
- `server/app/routes/sessions.py` + `server/tests/test_sessions_routes.py`
- `client/src/pages/settings/SessionsSection.tsx` + `.test.tsx`

**Modify:**
- `server/app/auth/tokens.py` — `jti` in `issue`/claims (§3). Extend `test_auth_tokens.py`.
- `server/app/auth/dependencies.py` — revocation check + throttled `last_seen` in `get_current_user` / `get_current_user_role` (§4a). Extend `test_auth_gating.py` / `test_auth_role.py`.
- `server/app/routes/auth.py` — `_set_session_cookies` threads jti pair + creates/updates session on login (`:163`) + refresh rotation (`:196`) (§4b). Extend `test_auth_routes.py`.
- `server/app/routes/events.py` — WS handshake revocation check + pass jti/username to `subscribe` (§4a/§6a). Extend WS tests.
- `server/app/services/event_bus.py` — per-sub metadata + `active_watchers()` (§6a). Extend `event_bus` tests.
- `server/app/config.py` — `sessions_db_path` (§2).
- `server/app/main.py` — lifespan `sessions_db.init_db` + `prune` + include the new router (§2/§4c).
- `client/src/lib/api.ts` — `AdminSession` + wrappers (§7b). Extend `api.test.ts`.
- `client/src/pages/Settings.tsx` — mount `SessionsSection` under `isOwner` (§7c).

---

## 9. Security guardrails (non-negotiable)

1. **Never render or log token bytes.** The `jti` is an opaque uuid (safe to
   log/show); the JWT itself is not. Sessions rows store `device_ua_raw` +
   `jti`, never a token. Audit logs and `log.warning` follow the existing
   secret-safe convention.
2. **`sessions.db` mode 0o600 pre-create** via `os.open(..., O_CREAT, 0o600)`
   before `sqlite3.connect` — identical to `users_db`/`audit_db`. It reveals
   who logged in from where; keep it as locked-down as `users.db`.
3. **Owner-gate every session route** with `require_role("owner")` (honors the
   admin→owner carve-out). Non-owner → 403. Pin with a `test_..._non_owner_403`.
4. **Fail-closed on explicit revoke, fail-open on missing row** (§5) — a pruned
   row must never lock out a live validly-signed session; only `revoked_ts`
   set → 401. This asymmetry is deliberate and documented.
5. **`last_seen` write must never break auth** — throttled + try/except-wrapped,
   WARN-once on failure, request proceeds.
6. **Preserve the `kind` re-check** in `tokens.decode` verbatim (load-bearing,
   pinned). The jti addition must not touch that branch.
7. **Do not trust `X-Forwarded-For`** for `ip_class` unless a trusted-proxy flag
   is added to settings — spoofable; default to `request.client.host`.
8. **Revocation must bite on BOTH surfaces** — REST deps AND the WS handshake —
   or a revoked session keeps streaming live detections for up to the access TTL.
9. **DoS bound:** `list_sessions` + `prune` keep the table small; the
   `event_bus` `active_watchers` map is bounded by the existing
   `MAX_SUBSCRIBERS = 32` cap. No new unbounded growth.
10. **`extra='forbid'`** on any new Pydantic request model (none needed for
    revoke — jti is a path param; validate it as a `str` with a length/charset
    bound, e.g. `Path(pattern=r"^[A-Za-z0-9]+$", max_length=64)`, to reject junk).

---

## 10. Build order (standalone-first)

1. §1 pure cores (`device_parse`, `ip_class`, `revocation`) + offline BDD with
   REAL fixtures — green before anything else.
2. §2 `sessions_db` + its test (temp-file DB, no server).
3. §3 `jti` in tokens + both-direction tests.
4. §4a/§4b dependency revocation + `last_seen` + login/refresh session writes.
5. §4c owner revoke route + §7a list route + server route tests.
6. §6 WS presence tagging + `watching_now` derivation.
7. §7b/§7c client wrappers + Sessions panel + mirrored tests.
8. Full suite: `npm test`, `npm run typecheck`, `npm run lint` (client) +
   `/tmp/homecam-venv/bin/python -m pytest` (server). All green before "done."
   Wire-contract-sync check: `api.test.ts` ↔ `test_sessions_routes.py` agree.
