# Multicam server implementation report (2026-07-07)

Server side of `docs/multicam_contract.md`. Scope: `server/` only (app + tests). Nothing committed.

## What shipped

### 1. Camera registry (`server/app/services/camera_registry.py`, new)
- `parse_cameras(raw)` is a pure, offline-testable parser (engineering principle 2): JSON array of `{id,name,path}`; `id` pinned to `^[a-z0-9_]{1,32}$` (`CAMERA_ID_RE`), `name` non-empty string up to 64 chars, `path` pinned to `^[A-Za-z0-9_-]{1,64}$` (MediaMTX path segment), unknown keys and duplicate ids rejected.
- Unset/blank env falls back to the default `[{front_door, Front Door, cam}]` silently; anything set-but-invalid logs WHY at WARNING (lazy `%s`, names the entry index and the exact reason) and falls back. Never crashes boot.
- `CameraRegistry` singleton re-reads `settings.cameras_json` per call but only re-parses (and re-logs) when the raw string changed, so the push hot path costs one string compare and tests self-reset under `monkeypatch`.
- `settings.cameras_json` added to `server/app/config.py` (`HOMECAM_CAMERAS` env); `server/.env.example` documents it (the `test_env_example_contract.py` symmetry pin required this).

### 2. `GET /api/cameras` (`server/app/routes/cameras.py`, new)
- Returns `{"cameras": [{"id","name","path"}, ...]}`. Auth-gated per-route (`Depends(get_current_user)`) plus the router-wide `_PROTECTED_DEPS` at include time in `main.py`. 401 on anon.

### 3. `DetectionPayload.camera_id` (`server/app/routes/_internal.py`)
- Was `Field(default="cam1", min_length=1, max_length=64)`; now `Field(default="front_door", pattern=r"^[a-z0-9_]{1,32}$")` (the pattern also enforces the length bound). `extra='forbid'` untouched. `_ALLOWED_METRIC_FIELDS` and the metrics whitelist untouched.
- `make_detection_event` default in `event_bus.py` moved `cam1` to `front_door` to match (one pinning test updated).

### 4. events_db migration (`server/app/services/events_db.py`)
- `camera_id` has been in the base `CREATE TABLE` since iter-216, so real installs already have it. Added the contract-pinned defensive migration anyway: `_ensure_camera_id_column` (PRAGMA table_info guard, same shape as `_ensure_seen_column`) adds `camera_id TEXT NOT NULL DEFAULT 'front_door'` and runs BEFORE `_SCHEMA` so a legacy table cannot break the `events_camera_ts` index creation. Insert, row output, and the WS broadcast payload already carried `camera_id`; verified by new route-level tests.

### 5. Search filter (`server/app/routes/events.py`)
- `/api/events/search` gains the contract-blessed `camera=<id>` param. The pre-existing `camera_id=` stays for back-compat; when both arrive, `camera` wins. Strict equality; unknown id returns zero rows with `next_cursor: null`. Failure-path log line uses the effective value.

### 6. Push copy (`_internal.py::_send_push`)
- With one configured camera the body stays byte-identical: `"Front Door · NN%"` (now pinned exactly, not just `startswith`). With more than one, the body uses the event camera's registry display name; an unregistered id falls back to the raw id.

## Tests (all BDD-lite Given/When/Then + AAA)

- `tests/test_camera_registry.py` (new): parse happy path, unset-is-silent, malformed JSON / non-array / empty array / bad id / oversized id / duplicate id / missing name / bad path / unknown keys all fall back and log WHY; registry re-read, `name_for`, `multi`.
- `tests/test_cameras.py` (new): default single entry shape, two-camera env, 401 via `client_anon`, invalid env serves default (never 500).
- `tests/test_internal.py` (added): camera_id defaulted to `front_door` when omitted, valid id persisted through to `/api/events`, 5 invalid-id shapes 422, single-camera push body byte-pin, multi-camera push body names the camera.
- `tests/test_events.py` (added): listed row includes camera_id, `camera=` filter matches, unknown id zero rows, `camera` beats `camera_id`.
- `tests/test_events_db.py` (added): legacy-table migration adds the column with `front_door` backfill, idempotent on re-init.
- `tests/test_event_bus.py` (updated): default-camera pin `cam1` to `front_door`.

## Pre-existing failure fixed in passing

`test_gen_admin_script.py` was failing on HEAD before this work: commit 745be93 deliberately flipped the gen_admin `--role` default from admin to viewer (security audit C1) but left two tests pinning `admin`. Updated the two tests to pin the shipped least-privilege behavior (`test_role_flag_defaults_to_viewer_least_privilege`).

## Verification

`/tmp/homecam-venv/bin/python -m pytest server/tests -q`: **969 passed, 5 skipped** (only the client/dist-not-built SPA fallback skips). No client/, detection/, or deploy/ files touched.

## Notes for the client/detection mirrors (not done here, per file ownership)

- Client: `getCameras()` wrapper + `Camera` type; `DetectionEvent.camera_id`; switcher only when `cameras.length > 1`.
- Detection: `DETECT_CAMERA_ID` env (default `front_door`), include `camera_id` in the event POST; py36 rules apply.
- The wire-contract-sync rule wants `client/src/lib/api.test.ts` pins for `/api/cameras` and `camera_id` on events once the client side lands.
