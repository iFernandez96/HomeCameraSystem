# Mobile Redesign — iter-356.64+

**Status:** synthesis brief. Implementation across multiple slices.
**Inputs:** mobile-view-auditor (21 findings), security-UX (44 findings), a11y (50+ findings), perf (~15 findings + numbers), Aiko's visual brief at `memory/mobile_visual_brief_iter356.md`, Hari's interaction brief at `memory/mobile_interaction_brief_iter356.md`.
**Director:** orchestrator (synthesis from specialists).

## 1. Vision (one paragraph)

The mobile HomeCameraSystem feels like a **lit kitchen window after dark**: warm but watchful, low-noise but legible, the cats present but never in front of the things you must see. Open the app and the first thing you read is *who's at the door right now*, not a wordmark; tap once and you're either watching the camera or scanning the day's incidents; the house belongs to Israel and the cats know it. Panther holds the headline only sometimes — Mushu and Coco take their turns on a 30-min rotation so the brand stays alive instead of locked. When something is *wrong* — camera offline, push permission revoked, capture-for-training silently saving a guest's face — the cats step aside and the UI gets blunt: red icon, plain words, exact recovery action. Everything fits one thumb on a 390-px iPhone. Nothing scrolls horizontally. Nothing requires Frank to remember a swipe.

## 2. Per-page redesign brief

### Live (`pages/Live.tsx`)

- **Failure today**: armed/off labels are cat-only ("Panther on watch", "Panther's off duty"); no plain fallback for paused/scheduled. No recording or face-capture indicator. Action buttons hide on landscape ≤390 px (mobile-view-auditor G1). `100vh` on Live.tsx:141 jitters on Android (A1).
- **Target**: command-center feel. Camera tile = first thing seen; sentry headline (rotating cat) below it; armed/recording/captures pills as plain English with ICONS, not just dots; primary action ("Pause / Resume / Snapshot / Talk") in thumb arc.
- **Concrete changes**:
  1. `Live.tsx:141` — replace `100vh` with `100dvh` in the height calc.
  2. `Live.tsx:325, 333, 539, 547` — replace hardcoded "Panther..." with `useSentryCat()` + `sentryOnWatchLabel(cat)` / `sentryOffDutyLabel(cat)` from `lib/sentryCat.ts`.
  3. Add a `RecordingIndicator` pill near `ArmedBadge` showing red REC dot + "Recording" when worker is alive AND detection is enabled. (Pre-roll always running per CLAUDE.md.)
  4. Add a `CaptureSavingPill` near the same anchor when `face_capture_enabled === true`. Plain copy: "Saving faces for training" + small camera-with-disk icon. Visible to all roles, not just owner.
  5. `Live.tsx:344, 417` — bump compact toggle + dark-mode action button from `min-h-[40px]` to `min-h-[44px]`.
  6. Landscape gate on overlay actions: change `hidden sm:flex` → `flex` (always visible); the mobile strip uses `landscape:hidden md:hidden` etc.
  7. Sentry headline copy: "{Cat} on watch" with a soft sparkle on rotation flip (CSS only, respects `prefers-reduced-motion`).

### Events (`pages/Events.tsx` + `EventList.tsx` + `EventHeatmap.tsx`)

- **Failure today**: cramped chip rows on 360 px; calendar overlay anchors right (after iter-356.62 fix this is mostly closed); single-event delete confirm omits timestamp/person; "Delete day" miscounts when filter active.
- **Target**: a calm incident journal. Day headers warm and obvious; chips legible; one swipe-left or one tap on the row's "•••" reveals delete; never accidentally destructive.
- **Concrete changes**:
  1. `Events.tsx:614-620` — single-event confirm body: include `clockTime(e.ts)` + `event.person_name || event.label` so user reads "Delete the 2:14 PM person event?" not bare "delete this event."
  2. `Events.tsx:638-661` — "Delete day" count must respect active filter; pass filter state into the confirm body and the API call OR disable the button when a filter is on (with tooltip explaining).
  3. `Events.tsx:1175-1176` — bump `success-vs-accent` chip pair to `ring-2` (Aiko's brief) for thumb-distance differentiation.
  4. `EventList.tsx:478-487` — `ConfidencePill` adds visible tier letter (L/M/H) so it's not color-only.
  5. `EventList.tsx:445-456` — per-card `✕` button bumped to `min-w-[44px] min-h-[44px]`.
  6. `Events.tsx:719` — remove `pt-[env(safe-area-inset-top)]` from the now-non-sticky Events header; WatchRibbon clears it.
  7. Calendar `CalendarOverlay` (Events.tsx:1230-1276): add focus trap + restore focus to trigger on dismiss (Hari's note).

### Settings (`pages/Settings.tsx` + sub-sections)

- **Failure today**: tab pills `py-2` (~29 px) on mobile; long form scrolling; no sticky save state; numeric inputs hit iOS auto-zoom; some labels named after internal variables.
- **Target**: thumb-friendly tab bar; per-section forms feel like cards on a paper table; clearly distinct destructive surfaces in DangerZone.
- **Concrete changes**:
  1. `Settings.tsx:242` — tab pills `py-2` → `py-3` on mobile.
  2. `settings/NotificationsSection.tsx:280-284` — "Send" button needs `type="button"`, `min-h-[44px]`, `px-3 inline-flex items-center`.
  3. `settings/DangerZone.tsx` — "Reboot Jetson" + "Restore" + "Update" confirm bodies expand to mention what *won't* survive (in-flight clip, push subs, etc.).
  4. `settings/UserMgmt.tsx:422, 489` — change-password + role-selector inputs: explicit `text-base` + `inputMode`. After token bump (slice 1) these auto-fix via inheritance.
  5. `settings/NotificationsSection.tsx:84` — add `Notification.permission` change listener; if OS revoked, banner above the toggle says "Browser blocked HomeCam alerts. Re-enable in your device settings, then reload." with a non-functional toggle.

### Training (`pages/Training.tsx`)

- **Failure today**: 32-px filmstrip icon button (B5); 36-px chips (B4); `text-sm` retention input triggers iOS zoom (C1); "consent required" copy implies enforcement that doesn't happen (security C4); per-name list dense on mobile.
- **Target**: feels like a curated photo album, not a folder browser. Each name = a card with a face, a count, a consent badge, and one primary action.
- **Concrete changes**:
  1. `Training.tsx:790, 887, 903` — filmstrip + chip buttons `min-h-[44px]`.
  2. `Training.tsx:208` — retention input `text-base` (post-token-bump) + `inputMode="numeric"`.
  3. `Training.tsx:539` — consent copy: "Consent required to export captures of {name}" — clarify that captures *are* still saved but exports are gated. Optional: add "Pause captures of {name}" toggle if we want enforcement.
  4. `Training.tsx:528-557` — Consent badge renders consistently across People, EventList recognized-person rows, and ClipModal evidence pane (security C3).
  5. `Training.tsx:912-923` — "New person" input: `onFocus` triggers `el.scrollIntoView({block: 'center'})` for iOS keyboard avoidance.

### People + Review

- **Failure today**: page titles are `<p>`, not `<h1>` (a11y D2/D3/D4); empty states use `<CatEmptyState>` correctly; consent state missing on People rows.
- **Concrete changes**:
  1. `People.tsx:124`, `Training.tsx:53`, `Review.tsx:163` — page titles → `<h1 className="sr-only">{title}</h1>` paired with the existing visible heading element (or replace `<p>` with `<h1>`).
  2. People list: each person row shows the consent badge from Training (read-only).

### Login

- **Failure today**: `CatTrioMark` PNGs `loading="lazy"` above the fold (perf C1); submit button focus-ring same color as fill (a11y A3); no persistent "you were signed out" banner after expiry (security E1).
- **Concrete changes**:
  1. `Login.tsx:125` + `CatIcons.tsx:240` — `loading="eager"` + `fetchpriority="high"` for the trio mark.
  2. `Login.tsx:330` — submit-button `focus-visible:outline-[var(--color-text-primary)]` for visible ring.
  3. `Login.tsx` — when query param `?expired=1` (set by `auth.tsx` redirect), show a persistent "You've been signed out for security" banner above the form.

### ClipModal

- **Failure today**: `<header>` landmark inside `role="dialog"` (a11y A1); 3 close buttons in one dialog (a11y B4); rVFC bbox draw eagerly fires before first frame on iOS (mobile-view C3).
- **Concrete changes**:
  1. `ClipModal.tsx:541` — convert the inner `<header>` to `<div>` with visible heading.
  2. `ClipModal.tsx:563-574, 691, 720-730` — keep ONE close button (top-right header). Drop the duplicates.
  3. `ClipModal.tsx:295-345` — start the rVFC overlay loop on the `play` event, not eagerly on mount, so the canvas isn't drawing before the video has a frame.

### Empty / Offline / Error / Loading / Paused states

- **Offline (camera)** — red icon + "Camera offline" + "Tap to retry" / "Restart camera service". `VideoTile.tsx` overlay must distinguish: stream stale (`No video for Ns`), worker dead (`Detection offline — restart camera`), permission revoked (rare, but possible on Android Chrome), origin mismatch.
- **Empty Events** — `<CatEmptyState mood="watching">` with copy "All quiet — no events today" and a sparingly-used cat. `EventList.tsx:525-531`.
- **Empty Training** — `<CatEmptyState mood="curious">` with copy "Nobody to recognize yet" + bootstrap-photo CTA.
- **Loading** — skeletons match resolved geometry; `Suspense` fallback should be a route-shaped skeleton, not a centered `PawSpinner`.
- **Paused (manual)** — `LiveStats.tsx:94` cat reference becomes secondary: primary line is **"Detection paused"** in plain text + cat-specific micro-copy below it. Same for `LiveStats.tsx:104` "Detection paused (quiet hours)".

## 3. Component-level conventions

- **Touch targets**: ≥ 44×44 CSS px hit region. Tailwind utility class `touch-target` (we'll add: `min-w-[44px] min-h-[44px]`) is the canonical bump.
- **Modal pattern**: `lib/confirm.tsx`-style. Focus trap, ESC, backdrop click for non-destructive; backdrop click *cancels* on destructive.
- **Sheet pattern**: not introduced this round (Hari's call — overhead not earned).
- **Pull-to-refresh**: not introduced (Hari's call). Visibility-listener already refetches on tab focus.
- **Toasts**: `role="status"` polite default; `role="alert"` only for things the user must see (push delivery failed, consent revoked, etc.).
- **Banners**: distinct color tokens for warn vs danger; persistent (no auto-dismiss); always have one action button (Retry / Open Settings / Dismiss).
- **Empty / paused / offline / error states** all use `<CatEmptyState>` (per CLAUDE.md sharp edge) but with *role-appropriate moods* — `watching` for offline, `curious` for "first time", `calm` for empty.

## 4. Cat-brand integration plan

| Surface | Cat presence | Why |
|---|---|---|
| Live sentry headline | **Rotating** (Panther/Mushu/Coco) | Warm signal for armed state. Copy: "{Cat} on watch". |
| Live paused / scheduled-off | **Secondary** — plain "Detection paused" first; cat micro-copy below | Security UX guardrail (F1/F2). |
| Camera offline / stream stale / push revoked | **Absent** | Plain icon + plain words + recovery. |
| Destructive confirm modals | **Absent** | Already enforced by `lib/confirm.tsx` (security F7); keep. |
| Empty Events / People / Training | **Featured** via `<CatEmptyState>` | The calm-state cats are the brand. |
| WatchRibbon HomeCam wordmark | **Trio mark** | Identity anchor. |
| EventList "no events yet" | **Featured** when system healthy; **absent** when offline | EventList.tsx already does this — keep. |
| ConnectionBanner / network errors | **Absent** | Plain. |
| ClipModal recognized-person row | **Absent** | Forensic surface. |
| CatLayer (ambient) | **Present, gated** | `prefers-reduced-motion` + `prefers-reduced-data` + low-battery short-circuit. |
| Sentry rotation flip | **One-time sparkle** | CSS-only, respects reduced-motion. |

## 5. Information architecture

- **Bottom nav (mobile)**: Live · Events · People · Settings. Training is a sub-route under People (consistent with desktop after we drop Training from SideRail per Hari).
- **Top ribbon (mobile)**: WatchRibbon = wordmark + sentry pill + camera-name + last-frame age. Persistent. Already shipped.
- **Settings tabs**: keep horizontal pills on mobile; bump to `py-3`. Consider making the active tab name appear at top of the page in a `<h1>` so the SR rotor has an anchor.

## 6. Slice plan

Each slice is shippable independently. Build in dependency order; small first.

### Slice A — Foundation tokens + viewport + manifest (independent, high leverage)

- `client/src/index.css`: bump `--text-base` 15→16, `--text-sm` 13→14; bump `--color-text-secondary` to ~5:1 contrast (#c4a482 candidate); leave `--color-text-tertiary` for spec follow-up.
- `client/index.html`: confirm `viewport-fit=cover` set.
- `client/vite.config.ts:51-52`: PWA manifest `theme_color` + `background_color` → `#1e1710` (matches `--color-bg`).
- `client/vite.config.ts`: SW `globPatterns` exclude large cat PNGs from precache; add a `runtimeCaching` rule for them (CacheFirst, 30d).
- `client/index.html`: add `<link rel="modulepreload" href="/assets/Live-*.js">` (build-time injected).
- `client/src/App.tsx:147`: `pb-20` → `pb-[calc(5rem+env(safe-area-inset-bottom))]`.
- `client/src/components/ConnectionBanner.tsx:77`: `lg:left-56` → `lg:left-16`.

**Tests**: contrast pin (jest-axe-style or hand-rolled), token shape pin, manifest fixture. Bundle-size budget via `npm run build` size assertion.

### Slice B — Sentry rotation wired in + cat-brand fallback strings

- `Live.tsx:325, 333, 539, 547` + `LiveStats.tsx:94, 104` — adopt `useSentryCat()` + canonical labels from `lib/sentryCat.ts`. Plain-English fallback line as primary; cat copy as secondary.
- New small visual: gentle sparkle on slot flip (CSS keyframes, reduced-motion aware).

**Tests**: pin that `LiveStats` paused state shows "Detection paused" plus the rotating cat name; Live armed state shows the rotating cat name.

### Slice C — Security clarity (recording, face-capture, push-permission, destructive-confirm context)

- New components: `<RecordingIndicator />`, `<CaptureSavingPill />` co-located on Live near `ArmedBadge`.
- `VideoTile` "Detection offline" pill ladder splits worker-dead vs stream-stale vs WHEP-failed copy.
- `NotificationsSection` listens for `permissionchange`; UI reflects.
- `Events.tsx:614-620` confirm body adds timestamp + label/person.
- `Events.tsx:638-661` "Delete day" with active filter: disable + tooltip (smaller blast radius than rewriting the count).
- `Settings/DangerZone` confirm bodies expand context (what won't survive).

**Tests**: confirm body copy assertions; permission-revocation simulated via a mock; offline ladder enumerates 4+ states.

### Slice D — A11y hygiene (sr-only h1s + landmarks + live-region scope + focus + hit targets)

- `<h1 className="sr-only">` on People / Training / Review / Events / Live.
- `ClipModal.tsx:541` `<header>` → `<div>` + visible heading.
- `ClipModal` keep ONE close button.
- `WatchRibbon` `role="status"` re-scoped to status pill only.
- `ConnectionBanner` `role="alert"` for true disconnect, `polite` for connecting.
- `SnapshotPreview` mirrors `ClipModal` backdrop pattern (`<div aria-hidden>`).
- Submit-button focus rings + tab order pinned.
- Hit-target bumps in Training (790, 887, 903) + EventList (445-456) + Settings tabs (242).
- Calendar overlay focus trap + restore focus on dismiss.

**Tests**: focus-management tests (focus restore on close); aria-snapshot tests for landmarks.

### Slice E — Mobile-only motion / perf gates (CatLayer battery + SW precache + lazy providers)

- `CatLayer.tsx`: read `navigator.getBattery()` (best-effort) and `prefers-reduced-data`; short-circuit to static cats when battery < 20% OR reduced-data.
- `vite.config.ts` workbox: cat PNGs out of precache → runtime CacheFirst (already in slice A; defer here only if needed).
- Lazy `ConfirmProvider` + `useToast` provider on first call (keep current behavior intact).
- Lazy-load `EventHeatmap` below the fold via `React.lazy`.
- `Login.tsx` + `CatIcons.tsx`: trio-mark images `loading="eager"` + `fetchpriority="high"`.

**Tests**: battery-gate test with mocked `getBattery()`; bundle-size budget for shell stays ≤90 KB gzip.

### Slice F — Empty / offline / error / loading designed surfaces

- `<OfflineState />`, `<ErrorState />`, `<LoadingState />` standardized — used by VideoTile / EventList / People / Training.
- Skeleton geometry pinned to match resolved layouts.
- ClipModal rVFC starts on `play` event, not on mount.

**Tests**: state matrix per page (loading → empty → loaded → error → offline → resolved).

## 7. Anti-recommendations

- **No bottom sheets, no long-press, no pull-to-refresh.** Overhead unearned (Hari).
- **No new client deps.** Use `react-dom` `createPortal` for any new modal/sheet primitive.
- **No CSS-only token shuffles passing as "redesign."** Each slice ships behavior, not just colors.
- **No removing cats from calm-state surfaces.** The brand is load-bearing.
- **No cats on red banners, destructive confirms, permission errors, or auth-state errors.**
- **No third close-button in any modal.** One per modal, top-right header.
- **No `100vh` anywhere on the layout shell.** `100dvh` only.
- **No re-introducing iter-302 NoNewPrivileges or PrivateTmp on the worker unit.** (Camera-recovery sharp edge already paid down.)
- **No new `setInterval` without paired `clearInterval`.**
- **No `setState` in `useEffect` body without a `cancelled` flag** (React 19 rule).

## 8. Acceptance per slice

- All Vitest tests pass.
- `npm run typecheck` + `npm run lint` clean.
- `npm run build` produces a dist/ ≤ 1.6 MB total (was 1.45 MiB pre-redesign — slice E should reduce).
- The brutal-polish-critic agent passes the slice without flagging the slice's own scope as REJECTED.
- For slice C (security) and slice D (a11y): `mobile-security-ux-auditor` and `mobile-accessibility-auditor` re-run on the touched files and find no regressions, only resolutions.

## 9. Implementation crew (parallel worktrees)

- **Worktree 1** — Slice A (tokens + manifest + viewport + workbox precache + safe-area pb).
- **Worktree 2** — Slice B (sentry wiring + paused-state plain fallback) — depends on slice A's contrast token bump but not on slice A's other changes.
- **Worktree 3** — Slice C (security clarity components + confirm bodies + push-permission listener).
- **Worktree 4** — Slice D (a11y hygiene sweep).
- **Worktree 5** — Slice E (perf gates: CatLayer battery, lazy providers, eager Login images).
- **Worktree 6** — Slice F (designed empty/error/loading surfaces).

A and B run in parallel first. C/D/E/F run after A and B merge. F is last because it depends on the new state components.

## 10. Open questions for implementer

- Should "Pause captures of {name}" actually pause future captures (toggle on the worker) or remain export-gated only? (Default plan: remain export-gated; surface the truth in copy.)
- Should the rotating-sentry sparkle on flip be skipped if the user is not actively viewing (visibility-hidden)? (Yes — only animate on visible.)
- Should we drop Training from the desktop SideRail to align with mobile (Hari's recommendation)? (Default plan: yes; one-line change in slice A.)
