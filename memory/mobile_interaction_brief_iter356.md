# Mobile Interaction Brief — iter-356

**Author:** Hari (mobile interaction designer, persona).
**Read-only audit + design.** Cites file:line against current `main` (post iter-356.62).
**Audience:** the next /loop iter that touches navigation, sheet/modal patterns, or per-page interaction.

---

## 1. Nav model — pick ONE primary

The app today runs **two navs in parallel**: a 4-tab `BottomNav` on `< lg`
(`client/src/components/BottomNav.tsx:3-9`) and a 5-icon `SideRail` on `lg+`
(`client/src/components/SideRail.tsx:36-42`). Both are gated on `state === 'authed'`
in `client/src/App.tsx:235-239`. Above them sits `WatchRibbon`
(`client/src/components/WatchRibbon.tsx:37`) — a 56 px sticky top bar. This is
the right shape; my critique is the *contents* of each.

**Primary pattern (mobile): bottom tabs.** Keep `BottomNav`. Already 4 slots,
56 px touch targets (`BottomNav.tsx:35`), backdrop-blur surface, paw-mask active
indicator. Do **not** extend to 5 — Settings/Training/Review compete for the
4th slot and breaking 4 → 5 puts the rightmost target inside the iOS reach-arc
ceiling on a 6.7" device.

**Top-level mobile slots (final):** `Live` · `Events` · `People` · `Settings`.
Training stays as a sub-route entered from the People page header
(`client/src/pages/People.tsx`) and the SideRail on desktop only.
`/training/review` is reached *only* from Training's header — it's a triage
sub-flow, not a destination.

**Asymmetry to fix:** SideRail today exposes Training as a top-level icon
(`SideRail.tsx:40`); BottomNav does not. The SideRail should drop Training
to keep the desktop and mobile mental model identical. Power users still
reach it via People → Training; that path is one tap shorter than today's
"is it under the people icon? the gear icon?" hesitation.

**WatchRibbon stays universal.** It is the system-state spine. On mobile it
shrinks to centered cluster only (already implemented, `WatchRibbon.tsx:80,131`).
Don't put navigation in it — that fights the BottomNav.

## 2. Reach map — primary action in the bottom 50%

Target viewport: 390×844 (iPhone 13/14/15 Pro). Bottom 50% = below y=422.
Add the BottomNav at 56+safe-area ≈ 90 px and the WatchRibbon at 56+safe-area
≈ 84 px — so the **thumb-easy zone is roughly y=422 → y=754**.

| Page | Primary action | Today's location | Verdict |
|---|---|---|---|
| Live | "Snapshot" button | mobile action strip *below* the video, ~y≈ video-bottom + 60 (`Live.tsx:218-237`). On a 390×844 the dynamic-vh video tile (`Live.tsx:149`) renders ~474 tall, so the strip lands ~y=540. | OK — bottom 40%. Keep. |
| Live | "Pause/Resume detection" | Same strip (`Live.tsx:218-223`). | OK. |
| Events | Tap an event card | Card grid, top of feed ≈ y=200 (filter chips above). Top card edge ≈ within reach. | Borderline. Filter row + day-banner can push first card to y=280. Acceptable on 6.1"; risky on 6.7". |
| Events | Filter chip toggle | Chip row at top, y≈90-130 (`Events.tsx:768-817`). | **OUT OF REACH** on 6.7". Acceptable because chip-tweak is a low-frequency action; do not add a sticky-bottom CTA, but ensure horizontal-scroll chip strip preserves the radiogroup roving-tabindex (already done). |
| Events | Open calendar | `lg:hidden` button in header (`Events.tsx:751-765`). | y≈80 — out of reach. Mitigated by iter-356.62 portal-overlay (`Events.tsx:1230-1276`) — once tapped, the calendar lands center-top regardless of scroll. Keep. |
| People | Tap a person | List rows. First row ≈ y=160. | OK. |
| People | Search input | Renders at ≥5 enrolled (`People.tsx:54`). Top of list. | Borderline. Consider sticky-bottom search field at >20 enrolled — out of scope for iter-356. |
| Settings | Switch tab | Horizontal pill row above content (`Settings.tsx:227`). y≈90. | Out of reach but tab switching is one-time-per-visit. Acceptable. |
| Settings | "Send test push" / save / sign out | Inside section content; varies. | Currently scrolls into reach. OK. |

**Recommendation, not new code:** for any page that grows a *destructive* primary
action (e.g. Settings → Danger Zone), put the action button at the *bottom* of
its section, never the top. This pattern is already followed.

## 3. Gesture grammar

| Gesture | Where used | Affordance | Notes |
|---|---|---|---|
| **tap** | universal | label / icon | default. |
| **long-press** | NOT USED | — | Don't introduce. Long-press has no visual affordance and is invisible to non-mobile users. Use a visible kebab/overflow if a row needs a secondary menu. |
| **swipe-left on row** | `EventList` event card (`EventList.tsx:296,358,386`) | reveals red Delete pad behind the card | Confirm modal still required (`Events.tsx:614-621` via `useConfirm`). Touch-only; pointer users get a visible ✕ when the row is hovered. **Pin: keep this pattern; do not extend swipe-left to other lists** without first adding a visible affordance for non-touch users. |
| **swipe-down at top of scroll (pull-to-refresh)** | NOT USED | — | Skip. Events and People already auto-refresh on `visibilitychange` (`Events.tsx:359-362`, `People.tsx:71-87`). Pull-to-refresh is a redundant gesture and conflicts with the iOS overscroll bounce. Status polls every 5 s (`useStatus.ts`). |
| **swipe-right to go back** | system gesture (browser/iOS edge) | — | Don't intercept. ClipModal close is via ✕ button + ESC + backdrop-tap (`ClipModal.tsx:514-521`). |
| **swipe sheet down to dismiss** | NOT USED | — | We don't have bottom sheets today. Defer until a sheet is introduced (see §4). |
| **horizontal scroll on chip rows** | Events filter chips (`Events.tsx:1109`), Settings tabs (`Settings.tsx:227`) | overflow + `scrollbar-hide` | Roving tabindex via `nextRovingIndex` (`lib/a11y.ts`) for keyboard users. Keep. |

Rule: **no invisible gesture without a visible-affordance fallback.**
Today's only "invisible" gesture is swipe-to-delete; the visible fallback is
the desktop-revealed ✕ button on hover and the always-tappable ClipModal Delete
button (owner only). Compliant.

## 4. Sheet vs modal vs overlay — decision tree

```
Need to gather a YES/NO destructive answer?
  → modal-dialog via useConfirm (lib/confirm.tsx:40-72). focus-trapped, ESC dismisses.

Need to gather a single selection from <8 items?
  → inline radiogroup chip strip (Events.tsx ChipRadiogroup:1088). NOT a sheet.

Need to gather a single selection from a calendar/grid?
  → top-anchored portal overlay. Pattern: CalendarOverlay (Events.tsx:1230-1276).
    - createPortal to document.body
    - fixed inset-0 + items-start (anchor TOP, not center)
    - backdrop click + ESC dismiss
    - aria-modal="true"
    - lg:hidden — desktop has dedicated rail real-estate

Need to display media (video clip, snapshot)?
  → full-screen overlay. Pattern: ClipModal (ClipModal.tsx:514).
    - fixed inset-0 + z-40 + bg-black/95
    - safe-area padded top + bottom
    - flex-col on mobile, flex-row on lg+

Need a temporary toast?
  → ToastProvider (lib/toast). Self-dismissing, top-of-viewport.

Need a transient preview (snapshot result)?
  → SnapshotPreview overlay (Live.tsx:244).
```

**Bottom sheets (drawn-up panels): NOT used today.** Don't add them lightly.
The only justification would be a future "Share / Export / Download" multi-action
menu invoked from a single button on a Live snapshot or an event card. If
introduced: respect prefers-reduced-motion, dismiss on swipe-down OR backdrop tap,
trap focus, render via createPortal — same primitives as ClipModal/CalendarOverlay.
**No new dependency.**

## 5. Per-page interaction walkthroughs

### Live (`pages/Live.tsx`)
- **Entry:** route `/`, `/live`, default landing (`App.tsx:167`). RequireAuth + ErrorBoundary.
- **Primary:** stare at video. WHEP autoplays via `VideoTile` (`Live.tsx:152-159`). Connectionstate flips to error on disconnect — manual Retry only (CLAUDE.md rule).
- **Secondary on mobile:** Pause/Resume detection (`Live.tsx:219-223`), Snapshot, Talk (placeholder toast).
- **Tertiary:** read armed-badge overlay (`Live.tsx:175-178`), camera name H1 over gradient (`Live.tsx:170-172`).
- **Exit:** BottomNav.
- **Dead-ends:** none. Talk currently shows a toast — fine until hardware lands.
- **Trap risk:** `100dvh` calc relies on iOS 15.4+ (handled, `Live.tsx:144-149`).

### Events (`pages/Events.tsx`)
- **Entry:** `/events` from BottomNav OR deep-link `/events?person=Alice` from People (`People.tsx:107`).
- **Primary:** scan recent cards, tap one to open ClipModal. Auto-marks-seen on mount + on tap (`Events.tsx:338-348, 543-549`).
- **Secondary:** filter by class chip → filter by person chip → calendar overlay → day-filter banner → time-of-day inputs.
- **Tertiary (owner only):** swipe-left → Delete one (`EventList.tsx:296`); Delete day in banner; Bulk-download.
- **Exit:** BottomNav, or ClipModal close.
- **Modal trap risk:** CalendarOverlay's backdrop button (`Events.tsx:1251-1257`) — verify it never traps when content scrolls. It's `absolute inset-0` behind the panel; clicks on the panel itself land on the panel, not the backdrop. OK.
- **Visibility-aware refetch:** load-bearing (`Events.tsx:359-362`). Don't remove.

### People (`pages/People.tsx`)
- **Entry:** BottomNav.
- **Primary:** tap a person → navigate `/events?person=NAME`.
- **Secondary:** search filter (>=5 enrolled), Train link in header.
- **Empty state:** `CatEmptyState` (CLAUDE.md pin — don't replace with plain text).
- **Effect pattern compliant:** `cancelled` flag inside `.then/.catch` (`People.tsx:71-87`).

### Training (`pages/Training.tsx`)
- **Entry:** People header link OR SideRail (desktop). Drop SideRail entry (see §1).
- **Primary:** browse face crops, send to Review.
- **Sub-route:** `/training/review` for active-learning triage.
- **Misplaced control risk:** the SideRail entry currently makes Training a top-level icon on desktop but not on mobile. Asymmetry is the dead-end — fix per §1.

### Settings (`pages/Settings.tsx`)
- **Entry:** BottomNav, SideRail.
- **Primary:** tab switch (Detection / Notifications / Account). 90% of visits land on Notifications.
- **Tab persistence:** localStorage with role-gated fallback (`Settings.tsx:31-53`).
- **Owner-gated content:** Detection tab content, Danger Zone — server `require_role` is the truth-source; client gating (`Settings.tsx:69`) is belt+braces.

### Login (`pages/Login.tsx`)
- **Entry:** anything 401 + RequireAuth redirect.
- **Primary:** username + password, submit.
- **Shell hidden:** WatchRibbon, SideRail, BottomNav, CatLayer all suppressed (`App.tsx:101-102`). Login owns the viewport.
- **Auto-focus:** verify the username input has `autoFocus` for keyboard users — not load-bearing for mobile interaction.

## 6. State interaction matrix

| State | Live | Events | People | Settings |
|---|---|---|---|---|
| **Loading** | `VideoTile` skeleton; `LiveStats` reads null status. Cat layer mounts later (`App.tsx:257`). | `EventListSkeleton`. | `null` people → role="status" announcement. | content section paints; status null briefly. |
| **Empty** | n/a (camera always present). | `CatEmptyState` ("nothing's happened yet" vs "camera offline" branch — `Events.tsx:1017-1021`). | `CatEmptyState` ("no people enrolled"). | n/a. |
| **Offline** | `WatchRibbon` red dot + "Camera offline" + `ConnectionBanner` strip. `VideoTile` error pill. | EventList "camera offline" branch. | unaffected. | live values dim. |
| **Error** | Toast on snapshot failure (`Live.tsx:88-97`). | `ErrorState` w/ Retry (`Events.tsx:1193-1221`). | persistent `role="status"` + Retry (`People.tsx:95-100`). | per-section. |
| **Paused** (detection off) | "Off duty" pill in WatchRibbon + ArmedBadge; `DetectionStatusToggle` says "Resume". | empty-state "camera off duty" branch. | unaffected. | Notifications tab shows the toggle. |

**Recovery path for every error state:** Retry button OR auto-retry via the
visibility-aware listeners. Three load-bearing listeners, do not remove:
`useStatus.ts` (5 s status poll, paused on hidden tab), `Events.tsx:359` (refetch
on visible), `ConnectionBanner.tsx` (cancels WS backoff on visible).

**WS close-1008** has no auto-retry (CLAUDE.md). The `homecam:auth-failed`
window event triggers AuthProvider self-heal — leave alone.

## 7. Focus order + keyboard

Per page, the tab order should be: skip-link → WatchRibbon Jump-to-Live (lg+ only)
→ page chrome → page primary content → BottomNav.

**Skip-link** is in place (`App.tsx:126-142`) — lands on `<main id="main">`.
**Roving tabindex** is in place for the Events chip strip and the ClipModal speed
pills (CLAUDE.md `lib/a11y.ts::nextRovingIndex`).

**Pinned order, mobile (Events page):**
1. Skip to content (visually hidden until focused).
2. WatchRibbon — center cluster. Currently *not* focusable, fine — it's
   `role="status" aria-live="polite"`.
3. "Watch log" subhead (decorative, `aria-hidden`, not focusable).
4. Calendar toggle button (`lg:hidden`).
5. Class-filter chips (one tab stop, arrows within).
6. Person-filter chips (one tab stop, arrows within).
7. Day-filter banner controls when active (Download → Delete day → Clear → time inputs → Reset).
8. Event cards in chronological order (each card is one tab stop).
9. Load more button.
10. BottomNav (4 tabs).

**Modal focus trap obligations** (`ClipModal`, `ConfirmDialog`, `CalendarOverlay`,
`SnapshotPreview`): focus the first interactive on open, restore focus to invoker
on close. ConfirmDialog and ClipModal already do this; **CalendarOverlay does
not** — the heatmap day cells take focus on open which is fine, but on dismiss
the focus needs to land back on the calendar toggle button. *Action item for next
iter:* add a `useRef<HTMLButtonElement>(null)` on the toggle and `.focus()` on
`onClose` in `Events.tsx:1230-1276`. Keep effect-pattern lint-clean: do the focus
restoration inside the `onClose` handler (event context), not inside a `useEffect`
cleanup.

## 8. Things to NOT do (anti-recommendations)

- **No hamburger menu.** BottomNav + WatchRibbon already carry the load.
- **No expanding rail-on-hover.** SideRail commits to icons-only-always (`SideRail.tsx:23-25`). It's a console, not a SaaS sidebar.
- **No drawer/sheet for filters.** The chip radiogroup is the right shape — visible state, low friction.
- **No long-press for secondary actions.** Invisible gesture, no affordance.
- **No pull-to-refresh.** Conflicts with iOS overscroll bounce; visibility-listeners cover the resume case.
- **No auto-retry on WS close-1008** (CLAUDE.md pin).
- **No swipe-to-delete extension** beyond `EventList`. Other lists do not have visible affordances yet.
- **No 5th BottomNav tab.** 4 is the limit.

---

## Executive summary

Mobile interaction model is in good shape post iter-356.58/.62 — `BottomNav` + `WatchRibbon` + `SideRail` form a coherent shell, `EventList` swipe-to-delete has a visible-affordance fallback for non-touch, and the calendar moved from in-flow scroll-leak to a fixed top-anchored portal that anchors to the viewport regardless of scroll position. The biggest *interaction* (not visual) gap remaining is the desktop-vs-mobile asymmetry around Training (top-level on SideRail, sub-route on mobile) — collapse it by dropping Training from SideRail. The biggest *technical* hygiene item is restoring focus to the calendar-toggle button when `CalendarOverlay` dismisses (event-handler context, not effect, to stay lint-clean). Don't add bottom sheets, long-press, or pull-to-refresh — none of them buy enough on top of the existing visibility-aware listeners and the explicit-button vocabulary the rest of the app already speaks.
