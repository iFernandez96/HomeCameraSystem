# W1 report — Watch/Home overhaul (2026-07-07)

Implementer W1. All 9 items under "W1 — Watch/Home overhaul" in SYNTHESIS.md are implemented. Files touched (all within ownership): `client/src/pages/Watch.tsx`, `client/src/pages/Watch.test.tsx`, `client/src/components/WatchRibbon.tsx`, `client/src/components/VideoTile.tsx`, `client/src/components/EventRow.tsx`, `client/src/components/EventRow.test.tsx`, NEW `client/src/lib/watchState.ts` + `client/src/lib/watchState.test.ts`. Nothing committed; changes are in the working tree.

## Per-item changes

### 1. `lg:` two-pane desktop layout for Watch (landscape-desktop Top/A1, codex#2)
- `Watch.tsx` page root: added `lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(20rem,26rem)] lg:grid-rows-[auto_1fr] lg:h-[calc(100dvh-var(--ribbon-h,0px))] lg:overflow-hidden lg:w-full lg:max-w-[100rem] lg:mx-auto` — mirrors the proven `landscape-phone:` grid. Header spans both columns; the right pane wrapper (previously `contents` outside landscape-phone) becomes `lg:flex lg:flex-col lg:col-start-2 lg:row-start-2 lg:min-h-0 lg:overflow-y-auto lg:pr-6` so glance + timeline scroll independently.
- Video max-w cap: the docked viewport gets `lg:max-w-[85.33dvh]` (= its own `max-h-[48dvh]` × 16/9), so the 16:9 `aspect-video` box can never be clamped into a wider-than-16:9 shape — which is exactly what made `object-cover` canyon-crop. Unlike landscape-phone, the lg left pane deliberately does NOT go full-height cover.
- Content-width ceiling on the timeline: `TodayTimeline` section, glance row, and the new alerts chip all get `md:max-w-[40rem] md:mx-auto` for the 768–1024 band (portrait tablet / narrow desktop); inside the lg grid the right rail's `minmax(20rem,26rem)` column is the cap.
- Glance cards stack vertically in the lg rail (`lg:flex-col`), matching landscape-phone.
- Pinned by a new class-contract test (jsdom can't lay out) in `Watch.test.tsx`.

### 2. One state vocabulary (mira#1, codex#1) — NEW `lib/watchState.ts`
- Extracted the three-state truth model (status-confirmed-down / status-unknown-with-video-tiebreak / healthy) into pure `watchStateOf()` + `WATCH_STATE_LABEL` + `watchStateDotClass()` + `watchStateTextClass()`. Stdlib-only, unit-tested offline (10 tests, `watchState.test.ts`) per engineering principle #2.
- `WatchRibbon.tsx` and `Watch.tsx` both consume it; the glance card headline now reads the ribbon vocabulary (`On watch` / `Off duty` / `Camera offline` / `Reconnecting…` / `Checking…`) instead of the page-local synonyms (`Watching` / `Paused` / `Offline`). Behavior parity verified: ribbon omits `videoPlaying` (it has no video channel) and classifies identically to before.
- `VideoTile`'s StatusPill deliberately untouched — it stays stream-truth (`Live` / `Connecting` / `Offline`); the module docblock explains why merging them would reintroduce the status-truth contradiction.
- Watch.test.tsx copy pins updated (`Watching`→`On watch`, `Offline`→`Camera offline`, cold-mount `Paused`→`Checking…`, reconnecting headline now `Reconnecting…`).

### 3. Timeline error → `<ErrorState>` + Retry; phantom copy killed (mira#4, hari GESTURE-4/STATE-1)
- The bare red `<p>` ("…pull to refresh or try again shortly" — a gesture that does not exist in the app) is replaced with the designed `<ErrorState title="Couldn't load today's events" message="Check your connection, then try again." retry={onRetry} />`. `onRetry` is `useTodayEvents().refetch`, threaded into `TodayTimeline` as a new prop.
- New test drives fail → Retry → success through the real refetch-key mechanism.

### 4. Small-target / radius / label sweep
- Fullscreen exit chevron `w-9 h-9 rounded-xl` → `w-11 h-11 rounded-full` (frank#1, hari REACH-2) — pinned by a new test.
- RailButton label `text-[8.5px]` → `text-xs` (the `--text-xs` token, 11px).
- Scrubber strip labels `text-[9px]` → `text-xs`; strip container now carries `max(1rem, env(safe-area-inset-left/right))` padding (the LIVE pill previously had no right-inset protection). The old `pr-16` axis row is gone entirely (see item 5).
- "Full history →" gets `-m-2 p-2` (larger hit-area, same visual position).
- Watch's slotted Snapshot/Expand actions: `rounded-2xl` → `rounded-full` (Snapshot `h-11 px-4` pill, Expand `w-11 h-11` circle) with VideoTile's exact glass treatment (`bg-black/60 ring-white/20 hover:bg-black/75 active:bg-black/85`) so the shared control row reads as one family (mira#5).
- VideoTile pill-ladder radius unification: `rounded-lg` (stream-stale) and `rounded-2xl` (low-memory, thermal) → `rounded-full`, matching the worker-dead/paused pills.

### 5. Honest hour scrubber (hari GESTURE-2)
- Chose the "drop the dress-up" option, not the per-hour deep link: Events.tsx only supports a `?person=` URL seed (its day/hour narrowing is in-page state with no URL param), and Events.tsx is outside W1 ownership — so "tap cell 3 → 6 AM on /events" is not implementable honestly from this side (see out-of-ownership notes).
- The strip is no longer costumed as a seek scrubber: the fake time axis (`12 AM / 6 AM / 12 PM / NOW`) and the ringed NOW cell are removed. The identity-colored activity cells stay (fuzz F1 coloring untouched, `hour-cell-0..15` testids kept, `hour-cell-now` removed) as a glanceable summary inside a button whose visible label now says exactly what a tap does: "Today's activity" + "Open history ›".
- Tests rewritten: the old NOW-ring pin is replaced with "labeled history button, no fake axis, no success fill" + a tap-exits-fullscreen behavior test.

### 6. Type-scale mapping to `--text-*` tokens (mira#2)
Tokens in index.css: xs 11 / sm 14 / base 16 / lg 18 / xl 22 / 2xl 28.
- Glance headline `text-[17px]` → `text-lg` (18px, `leading-tight` added to preserve the compact card).
- Glance detail `text-[12.5px]` → `text-sm` (14px; the code comment had explicitly rejected 11px as too small, so sm is the faithful nearest token).
- EventRow title `text-[13.5px]` → `text-sm`.
- 8.5px/9px/`text-[11px]` over-video labels → `text-xs` (item 4).

### 7. `React.memo(TodayTimeline)` (perf C2)
- `TodayTimeline` wrapped in `memo`; `useTodayEvents().refetch` wrapped in `useCallback` so the new `onRetry` prop is referentially stable. Remaining props are stable between 5 s status polls (`events` array identity only changes on real refetch, `onOpen` is a setState fn, `nowMs` ticks every 30 s) — so the ~50-row list no longer re-renders on every poll.

### 8. EventRow `hover:` parity with EventCard (landscape B1)
- The interactive (`onOpen`) variant now carries `transition-colors hover:border-[var(--color-border-strong)] hover:bg-[var(--color-surface-raised)] active:border-[var(--color-border-strong)] focus-visible:outline-2 focus-visible:outline-[var(--color-accent-default)] focus-visible:outline-offset-2` — the exact EventCard treatment (EventList.tsx:538). Non-interactive variant stays inert. Both pinned by a new test.

### 9. "Alerts are off" chip on Home (frank I1)
- New warning-toned (never danger — the camera still watches, only the phone is silent) tappable chip renders above the glance row when `Notification.permission === 'denied'` (read once via lazy `useState` initializer — no setState-in-effect).
- Copy (plain voice, no em-dash/emoji): "Alerts are off" / "Notifications are blocked for this app. Tap to fix in Settings."
- Deep-link to Settings → Alerts: Settings has no URL tab param, so the chip seeds the localStorage key Settings already reads on mount (`homecam:settingsTab` = `notifications`, valid for all roles) then navigates to `/settings`. Try/catch around localStorage for private modes. Two new tests (denied → chip + seeded key; granted → no chip).

## Bonus (within owned files, flagged by mira)
- `WatchRibbon.tsx`: both `navigate('/live')` calls → `navigate('/')` (`/live` is only a `<Navigate>` alias now; kills the double redirect). Ribbon label/dot/text-color logic now flows through watchState.

## Tests
- New: `src/lib/watchState.test.ts` (10 tests, BDD-lite + AAA), 7 new tests in `Watch.test.tsx` (error-state retry, alerts chip ×2, honest strip ×2, lg grid contract, 44px exit), 1 new in `EventRow.test.tsx` (hover parity both variants).
- Updated pins in `Watch.test.tsx`: shared-vocabulary copy (5 tests), the removed NOW-ring/axis pins.
- Targeted runs, all green: `watchState.test.ts` + `EventRow.test.tsx` + `WatchRibbon.test.tsx` (19 passed), `Watch.test.tsx` + `VideoTile.test.tsx` (83 passed), `__viewport__/viewport.test.tsx` (20 passed). `tsc --noEmit` shows no errors in owned files. Full suite/lint left to the orchestrator per instructions.

## Skipped / deliberate scope choices
- Hour-cell → hour-on-/events deep link: skipped in favor of the honest labeled button (see item 5 rationale). If Events ever grows a `?day=`/`?hour=` URL seed, the cells can become real per-hour links.
- Alerts chip reads permission once at mount (no `permissions.onchange` listener) — a mid-session revoke shows on next Home mount; matches the passive-nudge intent and keeps effects clean.
- Page-title weight standardization (mira#3) is W2/W3 territory (Events/People) — Watch's `.page-title` already conforms.

## Out-of-ownership needs (for W2/W3 or a follow-up)
1. **EventList.tsx:598** (W2): EventCard's title is still `text-[13.5px]` while its visual twin EventRow is now `text-sm` (14px). One-line change to keep the "one card language" contract; flagging rather than editing (W2 owns EventList).
2. **Events.tsx** (W2/future): no URL param for day/hour narrowing (`?person=` only). Adding e.g. `?day=YYYY-MM-DD&from=HH:MM` would unlock the real per-hour scrubber jump (hari GESTURE-2 option A) and other deep links.
3. **Settings.tsx** (future): a real `?tab=` URL param would replace the localStorage-seed deep-link the alerts chip uses (works today, but it is an implicit coupling to `_SETTINGS_TAB_KEY`).
4. `landscape-phone:` vs `md:` variant ordering on the glance row/chip is untested CSS-cascade territory; visually benign either way (both resolve to near-identical layout in the narrow right pane), but worth an eye during the device run-through.
