---
name: wire-contract-sync
description: >-
  Cross-tier wire-contract synchronizer for the 3-runtime stack (Python 3.6
  detection worker → Python 3.11 FastAPI server → React/TS PWA client). Invoke
  this skill WHENEVER you add, rename, remove, or change the shape of anything
  that crosses a tier boundary: a server route's request/response JSON, an event
  payload, a worker heartbeat metric, the detection config, a push-notification
  payload, or a timelapse/manifest shape. There is NO shared schema or codegen —
  drift is SILENT (a missing server field reads as `undefined` on the client and
  still type-checks), so a forgotten mirror edit ships a broken contract to prod.
  Use this before declaring any boundary change done, when editing
  server/app/routes/, detection/metrics.py, _ALLOWED_METRIC_FIELDS, or
  client/src/lib/api.ts, and any time you think "I changed the API."
---

# Cross-tier wire-contract synchronizer

Three runtimes, three languages, **no shared schema/codegen**. The only thing
keeping the worker, server, and client agreed on the wire is a set of
hand-maintained **mirror tests**. When you change a payload on one side and
forget the other, nothing fails locally — the client reads `undefined`, still
type-checks, and the break only shows up at runtime in production. This skill is
the checklist that forces the mirror edit every time.

## The rule (from CLAUDE.md): pin wire shape on BOTH sides

> Change a server route, expect to update `client/src/lib/api.test.ts` **AND**
> `server/tests/test_*.py`.

Every boundary change is **code on both sides + tests on both sides**. Find the
matching change before you call it done.

## Boundary → what to keep in sync

### 1. Server route request/response JSON
- **Server:** the route in `server/app/routes/*.py` + its Pydantic model (keep `extra='forbid'`).
- **Client wrapper:** `client/src/lib/api.ts` (REST throws `HttpError`; branch on `err.status`). WS → `lib/ws.ts`.
- **Tests (both):** `server/tests/test_*.py` (TestClient asserts shape) **and** `client/src/lib/api.test.ts` (mocks fetch, asserts method + content-type + the fields the UI consumes).
- Pin only fields the client actually reads — a tested-but-unused field is debt.

### 2. Worker heartbeat metrics — the **three-way** symmetry
A new metric must land in all three or it's silently dropped:
- `detection/metrics.py` (worker emits it),
- `server/app/routes/_internal.py::_ALLOWED_METRIC_FIELDS` (whitelist — unlisted metrics are dropped on ingest),
- client `WorkerMetrics` type in `client/src/lib/api.ts`.

Pinned by **`server/tests/test_internal.py::test_worker_snapshot_keys_match_whitelist`** — it asserts `set(payload.keys()) == set(_ALLOWED_METRIC_FIELDS)`. If you add a counter (e.g. a new `*_failures`), update all three sides or this test fails.

### 3. Event payloads — versioned
- Shape is `{"v": 1, "type": "...", ...}`; times are **unix epoch seconds**.
- Worker posts to `/api/_internal/event`; server validates with `extra='forbid'` + `model_validator` (Box coords [0,1], `x+w ≤ 1+1e-3`, etc.).
- `/api/_internal/*` is **never auth-gated** — don't add `dependencies=[...]` to that router.

### 4. Detection config — TWO routes stay in lockstep
The worker polls config unauthenticated; the user-facing GET is auth-gated.
Keep **both** `/api/detection/config` (user) and the `/api/_internal/detection/config` mirror (worker) returning the same shape.

### 5. Push-notification payloads & unauth carve-outs
- Push `image:` is fetched by the OS push daemon **without cookies** — only `^thumb_[0-9]+\.jpg$` is the unauth carve-out (everything else 308s to the auth-gated path). Don't widen it.
- Payload-field regexes in `_internal.py` (`thumb_url` = `^/snapshots/thumb_[0-9]+\.jpg$`, `clip_url` = `/api/events/<id>/clip`) are injection defenses — keep them strict.

### 6. Timelapse manifest / sidecar
- `build()` writes `<day>.json` `{v:1,date,segments:[{offset_s,capture_ts}]}`; `list_timelapses` exposes `manifest_url`; route regex serves `(mp4|json)`; client `lib/timelapseClock.ts` consumes it. Change any of these → update the others + `client/.../TimelapsesSection.test.tsx` + `server/tests/test_control.py`.

## Checklist before you call a boundary change done

1. Did I change a payload/route/metric that crosses worker↔server↔client? If yes, continue.
2. Updated the **producer** (worker or server route) AND the **consumer** (client wrapper / type)?
3. Updated the **server test** AND the **client test** that pin this shape?
4. For metrics: updated all **three** of `metrics.py` / `_ALLOWED_METRIC_FIELDS` / `WorkerMetrics`?
5. Kept `extra='forbid'`, the `{v:1}` envelope, unix-epoch times, and any strict unauth regex?

## Verify (no Jetson needed)

```bash
# server contract + metric symmetry
/tmp/homecam-venv/bin/python -m pytest server/tests/test_internal.py server/tests/test_control.py -q
# client wire wrappers
cd client && npm test -- api.test
```

Both green = the contract is mirrored. A red `test_worker_snapshot_keys_match_whitelist`
is the canonical "you changed one side and not the other" signal — fix the
missing side rather than editing the assertion.
