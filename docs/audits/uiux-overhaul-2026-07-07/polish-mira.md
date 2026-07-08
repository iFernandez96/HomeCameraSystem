# Polish Gate — Mira · Playroom Modern, 390px + landscape

Reviewed: `client/src` on branch `main` (redesign already merged into the working tree).
Method: source read at a mental 390×844 viewport + the landscape-phone variant, judged
against Playroom Modern's OWN grammar (pill/1.5px-border controls, 18/26 radius, ink
primary, identity-color, Bricolage display, pebble nav, `card-paper`).

Verdict scale: PASS / NEEDS WORK / REJECTED. No curve. If it improved 9 things and
missed 4, the 4 are below.

---

## TL;DR ranked blockers (fix before ship)

1. **Three different vocabularies describe ONE system state, on ONE screen.** On Home a
   user can simultaneously read "On watch" (ribbon, lg), "Watching" (glance card), and
   "Live" (video pill) — plus WatchRibbon/Watch/VideoTile each recompute the dot color
   independently. State-clarity fails the glance test.
2. **The design system's type scale is bypassed.** `--text-*` tokens exist but the hot
   surfaces hand-roll `text-[17px]`, `text-[12.5px]`, `text-[13.5px]`, `text-[11px]`,
   `text-[9px]`, `text-[8.5px]`. That is the exact "tokens shipped but never adopted"
   tell the overhaul was supposed to kill. Typography rhythm is not actually systematic.
3. **Page-title treatment is inconsistent across routes.** Home renders a visible 800-weight
   `.page-title`; Faces renders a visible 700-weight `.font-display`; Events + Settings
   render NO visible title (sr-only only). Same slot, three answers.
4. **Home's timeline error state is a bare red `<p>`** while every other list surface uses
   the designed `<ErrorState>`. The one place the redesign forgot to finish.
5. **The docked video control row mixes circles and squares.** VideoTile owns
   `w-11 h-11 rounded-full` circles; Watch slots Snapshot/Expand into the SAME row as
   `rounded-2xl`. Optical edges don't line up.

---

## PAGE — Login (`pages/Login.tsx`) — PASS

What works:
- First-glance lands on the brand mark + "HomeCam", then the single input bar. Correct.
- Real product touches: show-password 44px toggle, Caps Lock live-region, expired-session
  banner, reserved error-slot height (no layout jump), 16px inputs (no iOS zoom), ink
  primary via the Button primitive, staggered brand entrance gated on reduced-motion.
- Shared-bar input with hairline seam is distinctive, not SaaS-default.

What still falls short:
- `Login.tsx:68` redirects authed users to `/live`, and `:77` navigates to `/live` after
  sign-in — but `/live` is now only a `<Navigate to="/" replace>` (App.tsx:237). Every
  login does a double redirect. Works, but it's a stale-address smell.

Required fixes before ship:
- `pages/Login.tsx:68,77` — navigates to the retired `/live` alias — point both at `/`.

---

## PAGE — Home / Watch (`pages/Watch.tsx`) — NEEDS WORK

What works:
- Correct information architecture: live video is the first and largest thing; glance row
  then today's story. Docked↔fullscreen is a CSS state on the same node so WebRTC never
  remounts — genuinely well-built.
- Fullscreen hour scrubber reuses Events' identity-color ranking (`_HOUR_KIND_RANK`) and a
  neutral "now" ring instead of a green fill — good cross-surface coherence.
- Empty timeline uses `<CatEmptyState>` ("All quiet so far"). Correct brand placement:
  calm surface gets the cat.
- Landscape reflows to a real two-pane grid instead of letterboxing the portrait stack.

What still falls short:
- **State vocabulary collision (blocker #1).** `Watch.tsx:193-200` computes `stateLabel`
  = "On watch"/"Off duty"/"Camera offline"; `:514` the glance card independently prints
  "Watching"/"Paused"/"Offline"; `VideoTile StatusPill` (VideoTile.tsx:962) prints
  "Live"/"Connecting"/"Offline". Three names, one truth, all potentially visible at once.
  A security console must say the same word everywhere.
- **Timeline error is undesigned (blocker #4).** `Watch.tsx:618-622` renders
  `<p className="text-sm text-[var(--color-danger)]">Couldn't load…</p>`. Every other
  fetch-failure surface (People, Events) uses `<ErrorState>` with icon + retry. This one
  has no glyph, no retry button — it fails the "error has a plain-English next step + a
  button" test.
- **Type scale bypass (blocker #2).** `:513` `text-[17px] font-extrabold`, `:519`/`:525`
  `text-[12.5px]`, plus `EventRow` `text-[13.5px]`. These are one-off sizes that exist
  nowhere in `--text-*`. Pick scale steps (`--text-lg`, `--text-sm`, `--text-xs`) or add
  the intermediate token — don't scatter arbitrary px.
- **Page-title weight mismatch (blocker #3).** `:313` "Home" uses `.page-title` (800,
  -0.03em). Faces (People.tsx:176) uses `font-display font-bold` (700). Home reads visibly
  heavier than its sibling for no reason.
- **Docked control row mixes shapes (blocker #5).** `:394,:403` Snapshot + Expand are
  `rounded-2xl`; VideoTile.tsx:696,724 bbox + fullscreen are `rounded-full`. They render
  in one flex row (VideoTile `actions` slot). Circles next to squircles at the same size
  reads unfinished.
- Fullscreen over-video chrome uses four radii for the same class of button: exit chevron
  `rounded-xl` w-9 (`:435`), RailButton `rounded-[19px]` 54px (`:830`), Snapshot pill
  `rounded-2xl` (`:394`), camera pill `rounded-full` (`:452`). Pick one over-video radius.
- Cellular test: during the WHEP gap the docked area is pure black + a small top-left
  "Connecting" pill. Honest but bleak — no poster/shimmer inside the 16:9 box. Reassuring-
  ness is marginal on a 4s first-frame.

Required fixes before ship:
- `pages/Watch.tsx:618-622` — bare red `<p>` for load failure — replace with `<ErrorState
  title=… retry={refetchTodayEvents}/>` to match People/Events.
- `pages/Watch.tsx:193-200,514` + `components/WatchRibbon.tsx:50-56` + `components/VideoTile.tsx:962` —
  three state vocabularies — collapse to one shared label map (extract a `watchState.ts`).
- `pages/Watch.tsx:394,403` — `rounded-2xl` action buttons sit in VideoTile's `rounded-full`
  row — make Watch's slotted actions `rounded-full w-11 h-11` to match the row owner.
- `pages/Watch.tsx:313` vs `pages/People.tsx:176` — page titles at different weights —
  standardize on `.page-title` everywhere a visible title renders.
- `pages/Watch.tsx:513,519,525` — arbitrary `text-[17px]/[12.5px]` — map to `--text-*`.

---

## PAGE — Live video tile (`components/VideoTile.tsx`) — NEEDS WORK

What works:
- The status precedence ladder (stream-stale > worker-dead > low-mem > thermal > paused)
  is real engineering: each pill has a distinct glyph (colorblind-safe), plain-English
  copy, and a live-region wrapper that announces once, not per-poll.
- Stream-stale pill is a real Retry button (not passive text) — good recovery-action test.
- Error state uses the `compact` `<OfflineState>` sized for the 16:9 box.

What still falls short:
- Pill ladder shape drift: `:865,:910` are `rounded-full`; `:878,:895` are `rounded-2xl`;
  `:837` stream-stale is `rounded-lg`. Same pill family, three radii.
- The connecting state has no in-box treatment beyond the pill — see cellular note above.

Required fixes before ship:
- `components/VideoTile.tsx:837,878,895` — status pills at `rounded-lg`/`rounded-2xl` while
  siblings are `rounded-full` — unify to `rounded-full` (or `--radius-md` for all).

---

## PAGE — Events / Watch log (`pages/Events.tsx` + `components/EventList.tsx`) — PASS (with notes)

What works:
- Timeline rail (dotted spine + time gutter + identity dot) is distinctive and clearly
  NOT a default table. `EventList.tsx:196-214`.
- Two labeled filter axes ("Type" / person) with eyebrow captions — prevents the silent
  AND-to-zero trap. Chips are a proper roving-tabindex radiogroup.
- Swipe-to-delete + selection-mode bulk delete, owner-gated. Designed empty via CatEmptyState.
- Recognized/confidence badges use identity/success tokens with borders — legible, on-grammar.

What still falls short:
- No visible page title (sr-only h1 only) — defensible on its own, but see blocker #3:
  the app is not consistent about this decision across routes.
- Recognized-pill `text-[11px]` and card title `text-[13.5px]` (EventList.tsx:591,619) —
  same arbitrary-px scale bypass as Home.

Required fixes before ship:
- Adopt the app-wide page-title decision (visible vs sr-only) chosen for blocker #3, here too.

---

## PAGE — Faces / People (`pages/People.tsx`) — PASS

What works:
- Identity-color left edge + WhoMark corner badge on each card ties directly to the palette
  system; the subhead explains the color language to first-timers. Distinctive.
- Full state coverage: `<LoadingState shape="grid">`, `<ErrorState retry>`, `<CatEmptyState
  mood="curious">` naming Mushu-as-greeter (justified, not decorative). Recent/Earlier
  partition, client search only at ≥5, Load-more with truncation callout.
- Cards correctly dropped the shadow to obey the flat `card-paper` rule.

What still falls short:
- Visible title is a `font-display font-bold` `<p>` (700), lighter than Home's 800
  `.page-title` — blocker #3.
- Brass-chip avatar fallback vs identity-colored border: two color systems on one card
  (brass initial disc + wheel-hue edge). Minor, but slightly muddies "color = who."

Required fixes before ship:
- `pages/People.tsx:176` — title weight/treatment differs from Home — align per blocker #3.

---

## PAGE — Settings (`pages/Settings.tsx` + `settings/*`) — PASS

What works:
- Two-pane control-room layout (mobile pill rail → desktop vertical rail) genuinely escapes
  the flat-scroll SaaS settings template. Proper WAI-ARIA tabs with roving arrows.
- Sections share the `.card-paper` grammar; Toggle (26px ink-fill track, 44px hit area via
  padding trick), TimeInput (16px, invalid-border), RetentionPresetPicker radios all
  consistent. DangerZone groups maintenance (secondary) vs danger (destructive outline)
  with honest stub-with-note toasts.

What still falls short:
- Native `<select>` for the restore-backup file (`settings/DangerZone.tsx:322`) is the one
  browser-default control left in the app — QualityMenu proved the team will hand-roll a
  themed listbox when it matters. On the danger surface it clashes with the paper card.
- Active tab pill uses `accent-subtle` bg + `accent-default` text — a THIRD active-state
  grammar (BottomNav/SideRail use ink-fill; this uses accent-tint). Not wrong, but the app
  has three "selected" idioms now (ink pill / accent-tint pill / accent-underline links).

Required fixes before ship:
- `pages/settings/DangerZone.tsx:322` — raw native `<select>` on a themed danger card —
  wrap in the QualityMenu-style listbox (or at minimum token the border/radius to match).

---

## COMPONENT — Navigation (BottomNav pebble / SideRail / WatchRibbon) — PASS

What works:
- The floating pebble bar with ink active pill is the strongest single distinctive move in
  the redesign; landscape docks it to a left rail so it never floats over content.
- SideRail icon-only console (64px) + tooltip flyouts + ripple-host overlay is deliberate
  and non-generic. Active grammar matches the pebble (ink fill) — good consistency.
- WatchRibbon safe-area handling (notch top + landscape left/right + rail margin-left) is
  thorough.

What still falls short:
- Ribbon "On watch"/"Off duty" wording vs Home glance "Watching"/"Paused" — blocker #1.

---

## COMPONENT — Designed states (Loading / Error / Offline / Empty / Connection / Toast) — PASS

What works:
- Shape-aware `<LoadingState>` (list/grid/video/form) instead of spinner-on-white; skeleton
  tone tuned between bg and card. Toast/modal/page-in/banner-pulse all have real transitions,
  all reduced-motion-clamped. ConnectionBanner has a genuine 3-step cadence with a recovery
  announcement (not a silent unmount). Offline/Error correctly withhold the cat and use a
  danger/warn glyph + recovery action.

What still falls short:
- These primitives are excellent — which is exactly why the un-migrated holdouts
  (Watch timeline error `<p>`, DangerZone native `<select>`) stand out as the finish gap.
- `.focus-ring` util was created to replace the inline outline triplet; near-zero adoption —
  the long `focus-visible:outline-2 outline-[var(--color-accent-default)]` string is copied
  into ~80 className strings. Cosmetic/debt, not a visual reject, but it's the same
  "system built, not adopted" pattern as the type scale.

---

## Overall verdict — NEEDS WORK (close)

This is not SaaS-default-with-cat-decals. The token foundation, the pebble nav, the identity-
color system, the hand-rolled listbox, the designed state primitives, and the layout rebuild
are real, distinctive, paid-tier work. The cat brand is load-bearing (Login, empty states)
rather than pasted-on, and correctly withheld from error/offline surfaces.

But it is not finished to its own standard. The gap is CONSISTENCY, not capability: one screen
speaks three dialects of its own status, the type scale it shipped is bypassed by arbitrary px,
the page-title decision was never applied uniformly, and two surfaces (Home timeline error,
DangerZone select) skipped the very primitives the rest of the app proves the team can build.
Those are the four blockers. Fix them and this passes.

---

## The one question the implementer must answer before shipping

**"Stand on Home with the Jetson mid-restart. Read the ribbon, then the glance card, then the
video pill out loud — do they say the same word? If not, which one is the truth, and why are
the other two allowed to disagree with it?"**

Answering that forces the single shared state-vocabulary the redesign is currently missing —
and it will surface that "armed/watching/live/on-watch" was never actually reconciled, just
restyled three times.
