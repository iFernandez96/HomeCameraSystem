# Multicam client implementation report (2026-07-07)

Client side of `docs/multicam_contract.md`, mirroring the server shapes in
`multicam-server-report.md` (GET /api/cameras, camera_id on events, `camera=`
search filter). Scope: `client/` only. Nothing committed.

## Acceptance bar honored

With ONE configured camera (the shipped default) every page renders exactly as
before: no switcher, no camera chip row, no camera labels beyond today's copy,
and the WHEP URL composition is byte-identical (`cam` / `cam_lq` / `cam_uq`).
All pre-existing tests pass unmodified except where the new wrapper had to be
threaded into a `vi.mock('../lib/api')` factory (Watch.test.tsx,
Events.test.tsx — mock-surface additions only, no assertion changes).

## What shipped

### 1. `lib/api.ts` — registry wrapper + camera filter
- `Camera` type (`{id, name, path}`) + `getCameras()` → `GET /api/cameras`
  returning `{cameras: Camera[]}`.
- `EventSearchFilters` gains the blessed `camera?: string`; `searchEvents`
  serializes it as `camera=`. Legacy `camera_id` param kept (server back-compat,
  `camera` wins server-side).
- `DetectionEvent.camera_id: string` was already required in `lib/types.ts`
  (iter-216); no type change needed.

### 2. `lib/streamQuality.ts` — path-parametric rungs
- `pathForQuality(q, conn?, basePath = DEFAULT_CAMERA_PATH)` — quality rungs
  derive from the camera's registry `path` (`<path>` / `<path>_lq` /
  `<path>_uq`). New exported `DEFAULT_CAMERA_PATH = 'cam'` keeps every existing
  caller byte-identical; the old `PATH_BY_QUALITY` table became a suffix table.

### 3. `components/VideoTile.tsx` — `streamPath` prop
- New optional `streamPath` (default `'cam'`) feeds
  `whepUrlForPath(pathForQuality(quality, undefined, streamPath))`. Changing it
  recomputes `effectiveSrc`, which re-runs the connect effect (the same
  teardown/reconnect path a quality switch uses). The `src` override still wins.

### 4. `lib/eventLabel.ts` — registry-driven display names
- `registerCameraNames(cameras)` populates a module-level id→name map ONLY when
  `cameras.length > 1`; a single camera (or none) clears it, so single-camera
  copy never changes. `humanCameraName` resolves registered names first, then
  the friendly single-camera defaults — now covering `front_door` (the
  contract's registry default id) alongside the legacy `cam1` → "the front
  door". This one chokepoint makes event-row titles (`eventTitle`), the
  ClipModal header, and the "More from tonight" sublines all show the camera
  display name when >1 camera, with zero prop-threading.

### 5. `pages/Watch.tsx` — camera switcher
- `useCameras()` hook: fetches the registry once (inline fetch + cancelled
  flag, React 19 set-state-in-effect discipline), registers display names,
  restores/persists the selection at `localStorage['homecam:cameraId']`
  (a stale stored id falls back to the first camera; fetch failure falls back
  to the single-camera layout).
- `CameraSwitcher` pill radiogroup in the page header, rendered ONLY when
  `cameras.length > 1`: Playroom grammar (ink-fill selected pill, 1.5px-border
  idle pills), `min-h-[44px]` targets, `role="radiogroup"`/`role="radio"` with
  roving tabindex + arrow keys via the shared `nextRovingIndex` (same a11y
  contract as the Events chip rows).
- Selection drives BOTH the WHEP path (`VideoTile streamPath`) and the
  camera-name pill; with >1 camera the pill shows the selected registry name,
  with one camera it keeps the iter-313 `status.camera_label` exactly as today.
  The header's h1/BrandMarkRow row moved inside an inner flex div (header
  itself keeps its grid placement classes) so the switcher can stack under it;
  fullscreen contract, chrome auto-hide, pinch zoom, and the lg /
  landscape-phone grids are untouched.

### 6. `pages/Events.tsx` — camera filter axis + row names
- Fetches the registry once (same inline-fetch pattern as the iter-356.62
  `getDetectionConfig` effect); `log.warn('events:cameras-load-failed')` on
  failure and the page stays fully functional single-camera.
- New CAMERA chip axis (ChipRadiogroup, "All cameras" + registry names) renders
  as the first group — WHERE before TYPE before WHO — ONLY when >1 camera.
  `showFilters` now also earns the band from `multiCam` alone.
- The active camera chip narrows the loaded pool client-side (same split as
  the label filter) AND forwards `camera=<id>` on the Load-more and
  day-filtered search paths.
- The notification deep-link flow (`?event=` auto-open, param strip, missing-
  event toast) is untouched and its tests still pass.

## Mirror tests (wire-contract-sync rule)

- `lib/api.test.ts`: `getCameras` pins the URL + exact `{id,name,path}` wire
  fields; `searchEvents` pins `camera=` forwarding; a new pin asserts
  `camera_id` on returned event items.
- `lib/streamQuality.test.ts`: rungs derive from a custom base path (fixed
  tiers + auto-on-cellular); existing tests already pin the `cam` default.
- `lib/eventLabel.test.ts`: registry name resolution, single-camera self-gate
  (registering ONE camera changes nothing), `front_door`/`cam1` friendly
  defaults, raw-id passthrough, and `eventTitle` with a registered name.
- `pages/Watch.test.tsx`: no switcher + default path with one camera; two
  cameras → switcher radios, selection flips `streamPath` (stub renders it as
  `data-stream-path`) + name pill + localStorage persistence; persisted choice
  pre-selects on mount.
- `pages/Events.test.tsx`: single-camera registry → no camera axis + unchanged
  row copy; two cameras → axis renders, rows say the display name, chip
  narrows the list; active chip forwards `camera=` through Load more.
- Module-level registry state is reset in `beforeEach`/`finally` blocks so
  test order stays irrelevant. All new tests are BDD-lite (Given/When/Then +
  arrange/act/assert).

## Verification

From `client/`:
- `npm test` — 74 files, 1159 tests, all passing.
- `npm run typecheck` — clean.
- `npm run lint` — clean.

## Notes

- Watch's fullscreen overlay intentionally does NOT carry the switcher — the
  fixed overlay covers the header; the combined "{state} · {camera}" pill shows
  which camera is live, and switching remains a docked-mode action.
- Watch's "Today's story"/glance counts and HourScrubber stay all-camera
  aggregates (contract does not ask for per-camera narrowing on Home).
- The push-filter picker (`getKnownFilterOptions` → raw camera_ids) still shows
  raw ids; mapping those to registry names is a cheap follow-up once a second
  camera actually exists.
