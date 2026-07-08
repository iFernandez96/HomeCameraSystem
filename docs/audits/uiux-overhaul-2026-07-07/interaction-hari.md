# Interaction Model Audit — HomeCameraSystem PWA

**Auditor:** Hari (interaction design)
**Date:** 2026-07-07
**Scope:** navigation IA, gesture grammar, sheet/modal/overlay discipline, reach, focus/scroll, orientation.
**Verdict:** The chrome is beautifully built and the a11y plumbing (focus traps, roving tabindex, focus restore) is genuinely better than most shipping apps. But the *interaction model* has three structural cracks: a nav that changes what exists when you rotate the phone, two identical-looking event cards that behave differently under the thumb, and a fullscreen live view modeled on Ring/Nest that is missing every gesture Ring/Nest taught users to expect. Plus a phantom affordance the app tells users to use that does not exist.

Screen reference: 390×844 (iPhone 14/15). "Bottom 50%" = y ≥ 422. "Thumb arc" on a 6.7" device = roughly the bottom-right two-thirds; the top-left corner is the single worst spot.

---

## 1. Nav model

**Primary pattern: floating pebble BottomNav (portrait mobile) + slim SideRail (lg+).** Correct choice for a 4-5 destination app. One primary pattern per breakpoint, no hamburger, no competing drawer. Good.

Top-level slots:
- Portrait BottomNav (`BottomNav.tsx:28-34`): Home `/`, Events `/events`, Faces `/people`, Settings `/settings` — **4 tabs**.
- Landscape-phone dock (same file, `landscapeOnly` flag line 32): adds Review `/training/review` — **5 items**.
- SideRail lg+ (`SideRail.tsx:54-60`): Home, Events, Faces, Review, Settings — **5 items**.

### FINDING NAV-1 (HIGH — the top finding): a top-level destination appears and disappears when you rotate the phone.
`Review` (`/training/review`) is a peer nav item on desktop and in the landscape-phone left dock (`BottomNav.tsx:32`, comment lines 18-27) but is deliberately absent from the portrait pebble bar. The stated rationale is "bar density." The consequence: a user on a phone in portrait has 4 destinations; the *same user rotates to landscape* and a 5th navigation destination materializes. Rotate back, it's gone. This is the single most disorienting thing in the IA — a nav's contents must be invariant to device orientation. Users build a spatial map of "where things live"; this breaks it.
**Fix (Playroom-respecting):** Do NOT add a 5th pebble. Review is an *active-learning triage queue*, not a peer destination — it belongs one level down. Keep it reachable from the Faces page header (it already is, per `SideRail.tsx:37-43` history) and from the ClipModal "Name them" button (`ClipModal.tsx:328`). Remove `landscapeOnly` Review from BottomNav entirely so portrait and landscape expose the identical 4 destinations. On desktop SideRail, demote Review to a secondary action in the Faces sub-header too, so all three surfaces agree: 4 primary destinations, Review is a child of Faces. IA coherence beats one-tap access for a curation tool a family member visits monthly.

### FINDING NAV-2 (LOW): "Home" tab labeled with a video-camera glyph.
`BottomNav.tsx:29,153-160` — the Home destination uses `LiveIcon` (a camcorder). Post structural-overhaul the route is a Google-Home-style dashboard (live + timeline), not a raw live feed. The camcorder glyph promises "live video," the page delivers "home dashboard." Minor, but the label/icon/content triangle is slightly off. Acceptable to leave; if touched, a house-with-a-lens glyph reads truer.

---

## 2. Reach map

| Page | Primary action | Y-zone | Verdict |
|---|---|---|---|
| Home/Watch | Watch feed + Snapshot/Expand | Snapshot & Expand pills are in the **video's bottom-right corner** (`Watch.tsx:386-407`), video capped `max-h-[48dvh]` | REACHABLE — good, actions sit in the thumb arc |
| Home/Watch | Open an event (tap story row) | timeline below video, scrolls into bottom half | REACHABLE |
| Events | Open a clip (tap row) | list fills viewport | REACHABLE |
| Events | Filter by day (calendar) | **top-right** header, `Events.tsx:1021-1029` | UNREACHABLE one-handed |
| Events | Enter Select mode | **top-right** header, `Events.tsx:1011-1020` | UNREACHABLE one-handed |
| Events | Clear/Delete-day/Download (day banner) | near top, `Events.tsx:1150-1258` | POOR |
| ClipModal | Close | **top-right** `w-11 h-11`, `ClipModal.tsx:901-912` | UNREACHABLE, but ESC + backdrop compensate on the small footprint... except this modal is full-bleed |
| Watch fullscreen | Exit | **top-LEFT** `‹` chevron, `Watch.tsx:430-438` | WORST reach spot on the screen |

### FINDING REACH-1 (MEDIUM): Events' two primary controls live in the top-right dead zone.
Calendar and Select (`Events.tsx:1011-1029`) are the only two chrome actions on the page and both sit top-right — the least reachable point on a 6.7" phone. The page header explicitly stopped being sticky (`Events.tsx:915-925`), so once the user scrolls, these controls scroll *away entirely* and can only be reached by flicking back to the top.
**Fix:** The calendar filter is the more frequent of the two. Since the calendar already opens as a top-anchored portal (`CalendarOverlay`, shipped), keep its trigger — but ALSO wire the existing bottom-of-list surface: when the user is scrolled down and no filter is active, the natural moment for "jump to a day" is mid-scroll, not top. Consider a small floating filter pill bottom-right (mirrors the pebble grammar, `bg-surface-scrim` + `border-[1.5px]`, 44px) that opens the same CalendarOverlay. Select-mode is genuinely rare — leaving it top-right is fine.

### FINDING REACH-2 (MEDIUM): fullscreen live "exit" is top-left, the one unreachable corner.
`Watch.tsx:430-438`. Ring/Nest both let you swipe-down OR tap a large bottom-centered close. This app's only exits are ESC (no keyboard on a phone) and a `w-9 h-9` (36px — **below the 44px minimum**, note) chevron in the top-left. See GESTURE-3.
**Fix:** add swipe-down-to-dismiss (see §3) and enlarge the chevron hit target to 44px.

---

## 3. Gesture grammar

App-wide table of what actually exists today:

| Gesture | Where | Action | Visible affordance? |
|---|---|---|---|
| tap | rows, tiles, pills everywhere | open / activate | yes (ripple `lib/ripple`) |
| tap | video corner buttons (`Watch.tsx:386`) | snapshot / expand | yes |
| swipe-left on row | **Events list only** (`EventList.tsx:410-457`) | reveal Delete pad | yes — always-visible ✕ equivalent on touch (`EventList.tsx:640-668`) — GOOD |
| swipe-right on row | Events list, when revealed | close reveal | n/a |
| tap hour-cells | Watch fullscreen scrubber (`Watch.tsx:760-789`) | jump to /events | MISLEADING (see GESTURE-2) |
| ESC / backdrop-tap | all modals | dismiss | yes (close X) |

Gestures a user of a Ring/Nest-modeled app will *try* and find missing:

### FINDING GESTURE-1 (HIGH): swipe-to-delete exists on one card component and not on its visual twin.
There are two event-card components that CLAUDE-comments explicitly say should "read as ONE card language" (`EventList.tsx:528-531`): `EventList.tsx`'s `EventCard` (has swipe-left delete + touch ✕) and `EventRow.tsx` (has NOTHING — it's a plain button, lines 51-62). `EventRow` is what renders Watch's "Today at home" timeline (`Watch.tsx:639`) and ClipModal's "More from tonight" (`ClipModal.tsx:1092`). So: identical-looking cards, but swiping left deletes on the Events tab and does nothing on the Home tab. That's the worst kind of inconsistency — the affordance is invisible, so the user learns it on Events, then it silently fails on Home. Delete-from-Home also just isn't possible (owners must go to Events).
**Fix:** Either (a) unify — fold the swipe + ✕ affordance into `EventRow` behind an optional `onDelete` prop and pass it from Watch for owners, or (b) if Home-timeline is intentionally read-only, make the two cards *look* different enough that muscle memory doesn't carry over (e.g. Home rows get no trailing chevron/gutter). (a) is the honest fix and reuses the existing confirm flow.

### FINDING GESTURE-2 (MEDIUM): the fullscreen "hour scrubber" is a fake scrubber.
`Watch.tsx:713-798`. It renders 16 activity cells + a "NOW" ring + a red ● LIVE pill and 12AM/6AM/12PM/NOW axis labels — every visual cue of a *time scrubber you drag to seek*. But the entire strip is a single `<button onClick={onJumpHistory}>` (line 760) that navigates to `/events`. Tapping cell 3 (6 AM) does not seek to 6 AM; it dumps you on the history list. This is a dark-pattern-by-accident: it looks like Ring's timeline scrubber and behaves like a nav link.
**Fix:** Either make it real (tap a cell → open that hour's events, which the Events `_narrowDayWindow` already supports) or stop dressing it as a scrubber — drop the axis labels and NOW ring, make it a labeled "Today's activity — open history" button. Given no recorded-timeline-seek exists for live, the honest move is the labeled button.

### FINDING GESTURE-3 (MEDIUM): no swipe-down to dismiss any full-screen surface.
Watch fullscreen (`Watch.tsx:322-494`), ClipModal (`ClipModal.tsx:771-823`), and CalendarOverlay (`Events.tsx:1698-1758`) are all full-bleed `fixed inset-0` surfaces with top-anchored close buttons and NO swipe-down dismiss. On a phone, swipe-down-to-dismiss is now the default expectation for any sheet/immersive overlay (iOS sheets, YouTube, Instagram, Ring). The EventList swipe machinery (`EventList.tsx:410-457`) proves the team can do axis-locked touch handling cleanly and React-19-safely — reuse that shape.
**Fix:** add a vertical-drag dismiss to the three overlays: track `touchstart`/`touchmove` on the sheet, translateY with the finger, past a threshold call `onClose`, else snap back — same `dragging`-state + `cancelled`-flag discipline already in EventList (no `set-state-in-effect` risk since it's all event handlers). Keep ESC/backdrop as the equivalents.

### FINDING GESTURE-4 (HIGH): the app tells users to pull-to-refresh; pull-to-refresh does not exist.
`Watch.tsx:620` error copy: *"Couldn't load today's events — pull to refresh or try again shortly."* There is **no pull-to-refresh handler anywhere in the codebase** (verified: zero touch-refresh implementations). The page refetches only on `visibilitychange` (`Watch.tsx:118-125`, `Events.tsx:396-399`). So a user reads "pull to refresh," pulls, nothing happens, and they're stuck (no visible Retry button in that error branch either — it's a bare `<p>`). This is a phantom affordance AND a soft dead-end.
**Fix:** two options. Cheapest: change the copy to "Reopen the app or try again shortly" and add a real Retry button (the `refetch` from `useTodayEvents` at `Watch.tsx:132` is right there — wire it to a button). Better: implement real pull-to-refresh on the `<main>` scroll container using the EventList touch pattern — swipe-down at scrollTop===0 → spinner → refetch. Given the CLAUDE mandate of "make sense," implement it: users on a camera app pull-to-refresh reflexively.

### FINDING GESTURE-5 (MEDIUM): ClipModal browses events by tap only; no swipe between clips.
`ClipModal.tsx:1084-1101` — "More from tonight" swaps the whole modal to a sibling event via tapping a row. Ring/Nest/Photos all let you swipe left/right between adjacent clips. There's no horizontal-swipe navigation here, and the sibling list is buried below the video + evidence pane on mobile (must scroll past both). For an incident-review flow ("show me the last 5 things that moved"), tap-scroll-tap is clumsy.
**Fix:** add horizontal swipe on the video pane to advance to the next/prev event in the `moreTonight` window (data's already fetched). Pair with the vertical swipe-dismiss from GESTURE-3 by axis-locking (the EventList `touchAxis` ref pattern, `EventList.tsx:408,423-427`, is exactly this).

---

## 4. Sheet vs modal vs overlay decision tree

Current reality:
- **Bottom sheet:** ConfirmDialog only (`confirm-impl.tsx:100` — `items-end sm:items-center`, bottom sheet on mobile → centered dialog on desktop). Correct and premium.
- **Modal dialog (centered):** none besides Confirm.
- **Full-screen overlay:** ClipModal (media, `ClipModal.tsx:822`), Watch fullscreen (media, `Watch.tsx:323`), SnapshotPreview. Correct for media.
- **Top-anchored portal:** CalendarOverlay (`Events.tsx:1732`, `items-start`). Matches the shipped/approved calendar pattern.

The tree is *mostly* coherent. Two problems:

### FINDING SHEET-1 (MEDIUM): three modal surfaces, three different backdrop implementations and dismiss semantics.
- ClipModal backdrop: `<div onClick aria-hidden>` (`ClipModal.tsx:834-839`).
- ConfirmDialog backdrop: `<div onClick aria-hidden>` (`confirm-impl.tsx:102-107`).
- CalendarOverlay backdrop: `<button aria-label="Close calendar">` (`Events.tsx:1734-1740`) — a focusable button, which is the exact pattern iter-270 deliberately *removed* from ClipModal (`ClipModal.tsx:824-833` comment) because VoiceOver landed on it before the content.
So CalendarOverlay reintroduces the a11y bug the team already fixed elsewhere.
**Fix:** extract ONE `<Overlay>` primitive (backdrop div + focus trap + ESC + focus restore + optional swipe-dismiss) using `createPortal`, and have all three modals consume it with a `variant` = `sheet | media | top-portal`. This kills the three-way drift and is where GESTURE-3's swipe-dismiss lands once, for free. No new deps — `createPortal` is already the primitive.

### FINDING SHEET-2 (LOW): selections use inline chip rows, never a bottom sheet.
The person/type filters (`Events.tsx:1057-1122`) are horizontal-scroll chip radiogroups inline in the header. That's fine at 2-4 values, but the `overflow-x-auto scrollbar-hide` (`Events.tsx:1572`) hidden-scrollbar strip is a discoverability risk past ~5 people — a household with 8 enrolled faces gets a silently-clipped chip row with no "more" cue. Per the decision tree, a "who" selection with many options is the textbook bottom-sheet case.
**Fix:** when `personNames.length > 6`, swap the inline strip for a "Filter: Everyone ▾" pill that opens a bottom sheet (the new Overlay `variant="sheet"`). Keeps the header clean and reachable.

---

## 5. Per-page interaction walk-throughs

**Home/Watch** (`Watch.tsx`) — entry: live video docked top (`~48dvh`), glance cards + today timeline below. Primary: watch (passive) / Snapshot / Expand — all reachable (§2). Secondary: open an event → ClipModal; "Full history →" (`Watch.tsx:602-608`). Exit: BottomNav. Dead-ends: (a) the fake scrubber (GESTURE-2); (b) the phantom pull-to-refresh + missing Retry in the error branch (GESTURE-4); (c) no delete from here (GESTURE-1). Fullscreen sub-flow: enter via Expand, exit only via top-left 36px chevron/ESC (REACH-2, GESTURE-3).

**Events** (`Events.tsx`) — entry: filter chips + "Today, hour by hour" band + list. Primary: tap row → ClipModal. Secondary: swipe/✕ delete (owner), calendar filter, Select→bulk-delete, day-banner Download/Delete-day/Clear, Load more. Modal traps: none — focus trap + restore are correct. Misplaced controls: calendar + Select top-right (REACH-1). Note the day-banner "Delete day" correctly disables under an active filter with an aria-described reason (`Events.tsx:1210-1248`) — that's exemplary, keep it.

**ClipModal** (`ClipModal.tsx`) — entry: header (who/when/confidence) → video → action pills → evidence pane → "More from tonight." This modal is doing four jobs (player, evidence report, share/export/delete hub, sibling browser). On mobile it's a single scroll (`overflow-y-auto`, line 822) which is the right call. Exits: X / ESC / backdrop, focus restored to the triggering row (`ClipModal.tsx:360-379`). Weaknesses: no swipe-between-events (GESTURE-5), no swipe-dismiss (GESTURE-3), 4 wrapping action pills (`ClipModal.tsx:952`) that reflow but land mid-scroll on mobile.

**Settings** (`Settings.tsx:160+`) — two-pane on lg, horizontal pill tabs on mobile, role-gated landing tab (family/viewer can't land on Camera, `Settings.tsx:95-96`). Clean. `role="tabpanel"` + `aria-labelledby` wired. No issues.

**People** (`People.tsx`) — search (appears ≥5 people), recency-partitioned list, Load-more batches, Training reachable via header. Fine. This is the correct home for Review (see NAV-1).

**Login** (`Login.tsx`) — standard form, caps-lock detection (`handlePasswordKey`), submit button. Shell chrome hidden (`App.tsx:97`). Fine.

---

## 6. Loading / empty / offline / error / paused state interaction

Strong overall. `LoadingState`/skeletons per route, `CatEmptyState` primitive (the only allowed empty state), tri-state truth model on Watch (`Watch.tsx:171-234`) that correctly distinguishes "API unreachable" from "camera dead" using an independent `videoPlaying` channel — this is genuinely excellent and load-bearing; don't regress it. ClipModal has explicit pending ("still being saved, under two minutes") / loading spinner / "Clip unavailable" states (`ClipModal.tsx:669-743`). Paused (detection off) reads "Off duty" calm, distinct from danger "Camera offline" — correct (whimsy never masks danger).

### FINDING STATE-1 (MEDIUM): the Watch today-timeline error state is the app's only recovery-less dead-end.
`Watch.tsx:618-622` — on fetch failure it renders a bare `<p role="alert">` with phantom "pull to refresh" copy and **no actionable control**. Every other error surface in the app has a Retry (Events `ErrorState` retry `Events.tsx:1367-1372`, ClipModal fallbacks). The user's only recovery is to background+foreground the app to trigger the visibility refetch.
**Fix:** render a Retry button wired to `useTodayEvents`'s `refetch` (`Watch.tsx:132`). Trivial and closes the only true dead-end.

---

## 7. Focus order + keyboard

Pinned tab order (portrait mobile, Watch route): skip-link (`App.tsx:144`) → [ribbon hidden on Watch<lg] → `<main>` content (video corner buttons → glance → timeline rows → Full history) → BottomNav tabs. On other routes the WatchRibbon precedes main. DOM order matches visual order; BottomNav is last in DOM (`App.tsx:312`) and visually last — correct.

This layer is the app's strongest: focus traps in ClipModal (`ClipModal.tsx:787-806`), ConfirmDialog (`confirm-impl.tsx:69-87`), CalendarOverlay (`Events.tsx:1709-1731`); focus restore on close in all three; roving tabindex on chip radiogroups (`Events.tsx:1548-1604`) and speed pills; skip-to-content link. No changes needed except folding these into the single `<Overlay>` primitive (SHEET-1) so future modals inherit them instead of re-implementing.

### FINDING FOCUS-1 (HIGH, cross-cutting): no scroll restoration or scroll reset on navigation.
`App.tsx` uses `BrowserRouter` with no `<ScrollRestoration>` and no manual scroll handling (verified: zero `scrollTo`/`scrollTop`/`ScrollRestoration` in the client). The scroll container is `<main>` (`App.tsx:199`), and the routed page is keyed on pathname (`App.tsx:222`) so it *remounts*, but `<main>` keeps its `scrollTop`. Consequence: scroll deep into Events, tap Home → **Home opens already scrolled down** to wherever Events was. Go back to Events → your scroll position is lost (reset to whatever main happens to be at). Both directions are wrong. On a content-heavy list app this is felt constantly.
**Fix:** add a tiny scroll manager: on `location.pathname` change, reset `main.scrollTop = 0` for forward navigation, and optionally cache+restore per-path scrollTop on back/forward (read `main` via ref, all in an effect with the `cancelled`-flag discipline — it's a layout effect reading a ref, no setState, so no `set-state-in-effect` concern). Minimum viable: reset-to-top on every nav; that alone fixes the "Home opens mid-page" bug.

---

## Executive summary

The visual craft and accessibility engineering here are top-tier — focus traps, roving tabindex, the tri-state camera-truth model, and the ConfirmDialog bottom-sheet are all better than most shipping apps. The problems are in the *interaction model's coherence*, and they cluster into a fixable short list:

1. **NAV-1 (top finding):** Review is a nav destination that appears in landscape and vanishes in portrait — rotating the phone changes what exists. Demote it to a child of Faces on all surfaces so the 4 primary destinations are orientation-invariant.
2. **GESTURE-1 + GESTURE-4:** two identical-looking event cards behave differently (swipe-delete on Events, dead on Home), and the app literally instructs "pull to refresh" for a gesture that isn't implemented and has no Retry fallback. Unify the card, and either implement PTR or fix the copy + add Retry.
3. **GESTURE-2/3/5 + REACH-2:** the Ring/Nest-modeled fullscreen live view is missing every gesture Ring/Nest taught users — the "scrubber" is a fake nav link, there's no swipe-to-dismiss anywhere, no swipe-between-clips, and the only exit is a sub-44px top-LEFT chevron.
4. **FOCUS-1:** zero scroll restoration — navigating between tabs opens pages mid-scroll.
5. **SHEET-1:** three modal surfaces have drifted into three backdrop implementations (one re-introducing an a11y bug already fixed elsewhere) — collapse them into one `createPortal`-based `<Overlay>` primitive, which is also where swipe-dismiss lands once for all three.

All fixes respect Playroom Modern (pebble/ink/1.5px-border grammar, `createPortal`-only, ≥44px targets, React-19 `cancelled`-flag effect discipline) and add no dependencies. Highest ROI: NAV-1 and the single shared `<Overlay>` primitive, because they simplify code while removing the two most disorienting behaviors.

**Files cited:** `client/src/App.tsx`, `client/src/components/BottomNav.tsx`, `client/src/components/SideRail.tsx`, `client/src/components/WatchRibbon.tsx`, `client/src/pages/Watch.tsx`, `client/src/pages/Events.tsx`, `client/src/pages/People.tsx`, `client/src/pages/Settings.tsx`, `client/src/pages/Login.tsx`, `client/src/components/ClipModal.tsx`, `client/src/components/EventList.tsx`, `client/src/components/EventRow.tsx`, `client/src/lib/confirm-impl.tsx`.
