# Multi-camera wire contract (2026-07-07)

Goal: plumb a camera DIMENSION through all three tiers so a second camera is a
config entry, not a rewrite. Ships with ONE camera configured; with one camera
the UI renders exactly as today (no switcher, no camera labels on rows).

## Registry (server-owned)

- Config: env `HOMECAM_CAMERAS` = JSON array. Default when unset:
  `[{"id": "front_door", "name": "Front Door", "path": "cam"}]`
- `id`: `^[a-z0-9_]{1,32}$`. `name`: display string. `path`: MediaMTX base
  path; quality rungs derive from it exactly as the client's streamQuality
  does for `cam` today (`cam` / `cam_lq` / etc.).
- New route: `GET /api/cameras` (auth-gated, normal router) →
  `{"cameras": [{"id": "...", "name": "...", "path": "..."}]}`.

## Events gain camera_id

- Worker: env `DETECT_CAMERA_ID` (default `front_door`); include
  `"camera_id"` in the `/api/_internal/event` POST payload. Python 3.6 rules
  apply (no PEP585/604/walrus/match; typing.Optional etc.).
- Server `_internal.py::DetectionPayload`: add
  `camera_id: str = 'front_door'` with the id regex, `extra='forbid'` stays.
  Persist to DB; include `camera_id` in event rows returned by
  `/api/events*` and in the WS `detection`/event broadcast.
- DB `events` table: `camera_id TEXT NOT NULL DEFAULT 'front_door'` via an
  idempotent migration (PRAGMA table_info check before ALTER, matching
  events_db conventions).
- `/api/events/search`: optional `camera=<id>` filter; absent = all.
- Metrics/heartbeat: UNTOUCHED (single worker; no three-way metric change).

## Client

- `api.ts`: `getCameras()` wrapper + `Camera` type; `DetectionEvent` gains
  `camera_id: string`.
- Watch: camera switcher (pill/segmented, Playroom grammar) rendered ONLY
  when cameras.length > 1; selection persisted to localStorage; drives the
  WHEP path (streamQuality composes from `camera.path` instead of the
  hardcoded `cam`) and the camera-name pill.
- Events: camera filter axis + camera name on rows ONLY when >1 camera.
- ClipModal: show camera name in header when >1 camera.

## Mirror tests (wire-contract-sync rule: BOTH sides, every boundary)

- server: `test_internal.py` (payload accepts camera_id, bad id rejected,
  default applied), `test_events*` (row includes camera_id, search filter),
  new `test_cameras` route test incl. auth gating.
- client: `api.test.ts` pins `getCameras` shape + `camera_id` on events.
- detection: worker test pins camera_id in the posted payload; py36 scanner
  stays green.

## Explicit non-goals this pass

- Per-camera zones / detection config (worker is single-instance; documented
  limitation).
- Second physical camera on the Nano 2GB (encoder/memory budget) — registry
  is software-ready only.
- Per-camera storage quotas, timelapse-per-camera (timelapse stays global).
