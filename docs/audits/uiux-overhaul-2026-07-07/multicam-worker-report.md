# Multicam contract — detection worker slice (2026-07-07)

Implements the worker side of `docs/multicam_contract.md`: read
`DETECT_CAMERA_ID` once at startup, validate it, stamp `camera_id` into
every `/api/_internal/event` payload. Python 3.6 envelope respected.

## What changed

- `detection/camera_ident.py` (NEW, stdlib-only, pure): `DEFAULT_CAMERA_ID
  = "front_door"`, `resolve_camera_id(raw)` validates against
  `^[a-z0-9_]{1,32}$`. Unset/empty is a silent default (normal
  single-camera deploy); an invalid value logs ONE WARN naming the
  operation, the rejected value, and the pattern, then falls back to the
  default — never raises, so a typo'd unit file cannot brick the worker
  at boot. `camera_id_from_env(environ=None)` is the once-at-startup
  reader (env injectable for tests). Lazy `%s` interp in the log call.
- `detection/detect.py`:
  - `main()` now resolves `camera_id = camera_ident.camera_id_from_env()`
    (was `_env("CAMERA_ID", "cam1")`). Read once at startup, threaded
    through the existing paths untouched: the inline emit payload, the
    `_build_visit_runner` open-event payload, and the face-capture
    `capture_meta.source`. No new plumbing was needed — `camera_id` was
    already a parameter everywhere downstream.
  - Env-var docstring updated (`DETECT_CAMERA_ID`, default `front_door`,
    regex + fallback semantics); one stale "hardcoded cam1" comment
    reworded.
- `detection/tests/test_py36_compat.py`: `detection/camera_ident.py`
  added to `_GUARDED_MODULES` (the exhaustiveness test would have failed
  otherwise).
- `detection/tests/test_camera_ident.py` (NEW, BDD-lite Given/When/Then
  + arrange/act/assert):
  - Pure resolution: env-unset default, valid override, empty-string
    silent default, invalid-chars WARN+fallback, 33-char reject,
    32-char accept.
  - Wire pin (mirror side of the server's `test_internal.py` camera_id
    pins): Jetson SDK stubbed at the import boundary
    (`sys.modules.setdefault` before `import detect`, per
    `test_capture_recovery.py`), `detect.post_event` captured, and the
    REAL `detect._build_visit_runner` open-event path exercised —
    payload carries `camera_id` for default, env-override, and
    invalid-env-fallback cases.

## Behavior note

The worker default changes `cam1` → `front_door`. The server side of the
contract updates `DetectionPayload.camera_id` default to `front_door` in
its own slice (currently `server/app/routes/_internal.py:262` still says
`cam1`); until both deploy together, events from an env-less worker will
carry `front_door` explicitly in the POST body, which the current server
already accepts (field exists, max_length=64). No `CAMERA_ID` env usage
existed in `deploy/`, so no operator migration is needed.

## Verification

- `/tmp/homecam-venv/bin/python -m pytest detection/tests -q` →
  **430 passed, 3 skipped** (skips are the usual gated real-snapshot
  tests; Jetson off).
- py36 scanner green including the new module; no PEP585/604/walrus/
  match/`__future__` in anything touched.

Files: `detection/camera_ident.py`, `detection/detect.py`,
`detection/tests/test_camera_ident.py`,
`detection/tests/test_py36_compat.py`.
