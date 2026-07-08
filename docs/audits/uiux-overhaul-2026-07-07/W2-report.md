# W2 report — Nav + Events + shell (UI/UX overhaul 2026-07-07)

Implementer: W2. Scope: every item under "W2 — Nav + Events + shell" in SYNTHESIS.md.
All items shipped. Targeted vitest green on every touched file. No files outside the
ownership list were modified.

## Changes

### 1. NAV-1 — orientation no longer changes the IA (`BottomNav.tsx`)
- Removed the `landscapeOnly: true` Review entry from `tabs`. Portrait and landscape
  phone now expose the identical 4 destinations (Home / Events / Faces / Settings).
- Removed the `t.landscapeOnly ? 'hidden landscape-phone:flex' : 'flex'` conditional
  from the NavLink class (always `flex` now).
- Rewrote the explanatory comment block (was BottomNav.tsx:18-27) with the new
  rationale: rotating the phone must not change the information architecture
  (device run-through #6); Review stays reachable one tap inside Faces; the desktop
  SideRail deliberately keeps its 5-item roster (cross-device difference is fine,
  cross-orientation was the bug). A matching note was added above `NAV_ITEMS` in
  `SideRail.tsx` so nobody "fixes" the 4-vs-5 asymmetry back.

### 2. Shared `NavIcons.tsx` (new file)
- `client/src/components/NavIcons.tsx` now owns LiveIcon, EventsIcon, PeopleIcon,
  TrainingIcon, SettingsIcon (all `{ active?: boolean }`; only LiveIcon uses it for
  the red recording dot; all `aria-hidden` per the iter-356.56 Dana #2 treatment).
- BottomNav and SideRail import from it; their byte-identical local copies and the
  "keep the two in sync" comments are deleted. SignOutIcon stays local to SideRail
  (single consumer, never duplicated).

### 3. Scroll reset on route change (`App.tsx`, hari FOCUS-1)
- `AppShell` now holds `mainRef` on the `<main>` element (the real scroll container,
  `overflow-y-auto`) and a `useLayoutEffect` keyed on `location.pathname` that sets
  `mainRef.current.scrollTop = 0`. Layout effect reading a ref, before paint, no
  setState — clean under React 19's `set-state-in-effect` rule.

### 4. Watch-shaped Suspense fallback for `/` (`App.tsx`, perf C1)
- Verified `LoadingState` supports `shape="video"` (aspect-video block,
  `role="status"` + `aria-label="Loading video"`).
- `PageFallback` now takes `pathname` and returns `shape="video"` for `/`,
  `shape="list"` for everything else. Wired as
  `<Suspense fallback={<PageFallback pathname={location.pathname} />}>`.

### 5. Events visible page header (`Events.tsx`, codex#3 + mira#3 + device #8)
- The sr-only-only `<h1>Watch log</h1>` is replaced by a compact visible header in
  the existing band (inside the same `pt-2 pb-2` padded row, ~44-48px on phones):
  `<h1 class="page-title text-xl leading-tight">Events</h1>` plus a one-line
  subtitle `Recent motion and clips` (`text-xs`, secondary ink, hidden at
  landscape-phone to protect vertical space). The h1 remains the accessible
  level-1 route heading — now visible instead of sr-only. It also left-anchors the
  previously free-floating meta cluster (dropped the now-redundant `ml-auto`).
  Day-headers ("Today's log") remain the visible section anchors, so the Maya
  de-triplication is preserved: "Watch log" no longer exists anywhere.

### 6. Events landscape-phone filter compaction (`Events.tsx`, device #7)
- The TYPE and WHO chip groups (previously 4 stacked full-width rows: caption,
  chips, caption, chips — eating the whole ~390px-tall landscape viewport) are now
  wrapped: outer `landscape-phone:flex landscape-phone:flex-wrap
  landscape-phone:items-center landscape-phone:gap-x-5 landscape-phone:max-w-2xl
  landscape-phone:mx-auto`; each group gets `landscape-phone:flex
  landscape-phone:items-center landscape-phone:gap-2 landscape-phone:min-w-0`
  with the caption inline (`landscape-phone:mt-0 landscape-phone:shrink-0`) and the
  chip strip's own `overflow-x-auto` absorbing width pressure (overflow != visible
  gives the flex item an automatic min-size of 0, so no extra min-w-0 needed on the
  strip). Portrait and `lg:` keep the stacked layout untouched (wrappers are plain
  blocks there). Event content is now visible above the fold at ~850x390.

### 7. Small-type + centering fixes
- `EventList.tsx:180`: dropped the inner `lg:mx-auto` (kept `lg:max-w-3xl`) —
  landscape-desktop D3 double-centering next to the calendar rail.
- `BottomNav.tsx`: landscape label `landscape-phone:text-[9px]` → `text-[11px]`
  (frank B3).
- `EventHeatmap.tsx:279`: day-cell count `text-[9px]` → `text-[11px]` (frank B4).

## Test changes (BDD-lite on all new tests; pinned tests updated in-change)

- `BottomNav.test.tsx`: 5-link pin → 4-link pin (labels + hrefs, Review removed);
  the `hidden landscape-phone:flex` Review pin replaced by a NAV-1 pin asserting NO
  link is orientation-display-gated (whitespace-delimited `hidden` match — a plain
  `\b` boundary false-positives on `overflow-hidden`); new 11px-label pin.
- `SideRail.test.tsx` (new file): pins the deliberate 5-item desktop roster incl.
  Review → `/training/review`, and that every NavIcons glyph is `aria-hidden`.
- `App.test.tsx`: extended the `lib/api` mock surface (fetchEvents,
  getDetectionConfig, mark-seen, delete, export, counts — Events now really mounts);
  fixed the pre-existing `searchEvents` mock shape (`events:` → `items:`, the real
  wire key); added the video-fallback test (must run FIRST in the file — React.lazy
  caches the resolved Watch module, only the first mount suspends) and the
  scroll-reset test (scroll `<main>` to 480, click Events in the BottomNav via
  `within(nav)` — SideRail renders a second Events link — assert scrollTop 0).
- `Events.test.tsx`: three "Watch log" pins rewritten — h1 is now visible `Events`
  with `.page-title` and without `sr-only`; subtitle pinned; zero "Watch log"
  occurrences pinned; new landscape-compaction class-token pin (restores the
  never-resolving `getDetectionConfig` default at the end — the shared afterEach
  `clearAllMocks` does not reset implementations).
- `EventList.test.tsx`: new D3 pin (`lg:max-w-3xl` present, `lg:mx-auto` absent).
- `EventHeatmap.test.tsx`: new 11px count pin.

## Verification

Targeted vitest only (per brief), all green:
- `src/App.test.tsx` — 4 passed
- `src/components/BottomNav.test.tsx` — 8 passed
- `src/components/SideRail.test.tsx` — 2 passed (new)
- `src/components/EventList.test.tsx` — 39 passed
- `src/components/EventHeatmap.test.tsx` — 20 passed
- `src/pages/Events.test.tsx` — 61 passed
- `src/__viewport__/viewport.test.tsx` — 20 passed (guard: mounts Events, mirrors
  App `<main>` pad classes — untouched by W2)

Full suite / typecheck / lint deliberately NOT run (concurrent W1/W3 edits in the
same tree; coordinator runs the gate).

## Notes / out-of-scope observations

- `LiveStats.tsx` also carries a `text-[9px]` (not in the W2 item list or file
  ownership — W1 territory if it matters; flagging for the coordinator).
- The compact Events header will render at 32px on `lg:` via the `.page-title`
  media query in index.css (unlayered CSS wins over the `text-xl` utility). With
  the subtitle that is a ~60px desktop band — consistent with People/Watch header
  grammar; if the coordinator wants it tighter on desktop it needs an index.css
  change (not W2-owned).
- One incidental fix in W2-owned test infra: App.test.tsx's `searchEvents` mock
  returned `{ events: [] }` but the real route returns `{ items: [] }`; corrected
  while extending the mock.
