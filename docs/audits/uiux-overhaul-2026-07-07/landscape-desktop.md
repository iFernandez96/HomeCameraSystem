# Landscape / Wide-Viewport Audit — 2026-07-07

Scope: phone landscape (~850x390), tablet landscape (~1024x768 and the
"tweener" 700-1023px-wide short-viewport band), laptop (1280+), desktop
(1920). Theme: Playroom Modern. Everything below is checked against what's
*actually shipped* on `main` as of this audit — a lot of prior landscape
work already exists (`landscape-phone:` custom variant, `lg:` rails on
Events/Settings/People). This file only lists the gaps that remain.

Breakpoint vocabulary used below (matches the codebase):
- `landscape-phone:` = `@media (orientation: landscape) and (max-height: 520px)` — `client/src/index.css:16`.
- `lg:` = Tailwind default `min-width: 1024px`.
- **"tweener" viewport** = landscape, width 700–1023px, height > 520px (a
  10" tablet, a Surface Duo, a small Chromebook in landscape). This band
  matches **neither** `landscape-phone:` (too tall) **nor** `lg:` (too
  narrow) — it silently falls through to the bare mobile-portrait styles.
  Nothing in the codebase currently targets it explicitly.

---

## Top finding — Watch (Home) has no desktop/landscape layout at all

`client/src/pages/Watch.tsx:302` — the page root:

```
<div className="flex flex-col landscape-phone:grid landscape-phone:grid-cols-[58%_1fr] ...">
```

There is **no `lg:` variant anywhere in this file** (`grep -c "lg:" Watch.tsx`
= 0, confirmed). Every other primary route caps its content width at `lg:`
(`People.tsx:159` `max-w-3xl lg:max-w-4xl mx-auto`, `EventList.tsx:180`
`lg:max-w-3xl lg:mx-auto`, `Settings.tsx:152` `lg:max-w-5xl lg:mx-auto`,
`Events.tsx:1333` `lg:max-w-6xl lg:mx-auto`) — Watch is the **only** route
that skips this pattern entirely. Consequences on a 1440x900 laptop or a
1920x1080 external display:

1. **Video tile stretches full-bleed with no ceiling.** The docked tile
   (`Watch.tsx:343`) is `relative aspect-video max-h-[48dvh] mx-4 ...` — a
   block-level div with only horizontal margins, no `max-w`. Its rendered
   width is the full main-column width (on a 1920 screen, `100% - 4rem`
   sidebar ≈ 1856px), but height is capped at `48dvh` (~432px @ 900px
   viewport height). Since the box is wider than its own `aspect-video`
   ratio would produce at that height, and the actions prop sets
   `fit="cover"` (`Watch.tsx:360`), the WebRTC `<video>` gets center-cropped
   to an extreme wide-and-short letterbox — most of the vertical frame
   (where a person/cat actually is, at ~5-6ft off the ground) gets cropped
   off-camera. This is the opposite of what `cover` was meant to buy back
   on a landscape phone (`Watch.tsx:19-30` comment block) — there the
   crop is a *minor* top/bottom sliver; on a 1856px-wide desktop box it's
   a canyon.
2. **"Today at home" timeline reads as a single giant full-width column.**
   `TodayTimeline` (`Watch.tsx:581-649`) and the `EventRow` cards it renders
   inherit whatever width the unconstrained parent gives them — up to
   ~1850px on a 1920 display. `EventRow.tsx:14`'s `ROW_CLASSES` has no
   `max-w` either. A 13.5px title + a right-aligned timestamp end up ~46
   inches apart with acres of dead card in between — the exact "blown-out
   card" failure mode the mobile-first-stretch problem statement describes,
   except it's happening on the app's *home* screen, the one page a user
   sees most.
3. **The natural desktop affordance — Live + Events timeline side-by-side
   — doesn't exist.** `landscape-phone:` already proves the two-pane
   pattern works technically (58%/1fr grid, `Watch.tsx:302`); it's scoped
   to short-height phones only. At `lg:` width with normal height (every
   laptop/desktop) the page falls through to the base flex-col stack —
   video on top capped at a dvh fraction, huge full-width timeline below.
   This is the single biggest wasted opportunity in the whole audit: the
   category-D "Live + Events side-by-side" desktop affordance the task
   brief calls out by name is *already built* for the wrong breakpoint.

**Fix:** add an `lg:` companion to the existing `landscape-phone:` grid —
reuse the same `grid-cols-[Nfr_Mfr]` shape (a 55/45 or 60/40 split reads
well at 1280+, adjust for 1920 with an `xl:` bump toward 50/50 so the
timeline column doesn't itself get too wide) and cap the timeline column's
inner content at `max-w-2xl` (per-card readability) the way `EventList`
already does. Cap the video tile's `max-w` so `cover` never has to crop
more than the landscape-phone case does (e.g. `lg:max-w-[960px]` alongside
`lg:aspect-video lg:max-h-none` so aspect-ratio governs height instead of
a dvh fraction fighting an unconstrained width).

---

## Category A — Max-width / centering

**[A1] Watch.tsx has zero content-width ceiling at any desktop breakpoint.**
See Top Finding above. `client/src/pages/Watch.tsx:302` (root),
`:343` (video tile), `:597` (`TodayTimeline` `<section className="px-4 pt-4 pb-6">`
— no `lg:max-w` either). Every sibling page caps width at `lg:`; Watch
does not. **Fix:** wrap the whole page (or at minimum the video tile and
the timeline section independently) in an `lg:max-w-*` + `lg:mx-auto`
pattern matching the rest of the app, layered under the new `lg:` two-pane
grid from the Top Finding.

**[A2] `EventRow` (shared by Watch + Review) has no width cap of its own.**
`client/src/components/EventRow.tsx:14` — `ROW_CLASSES` has no `max-w`.
Fine today because every current consumer (`Watch.tsx:639`,
presumably `Review.tsx`) sits inside a width-capped ancestor — but once
A1 is fixed, this component still needs to not silently rely on the
parent every time; a defensive test similar to `EventList`'s width pin
would catch a future unconstrained wrapper immediately.

**[A3] Tweener viewport (landscape, 700–1023px wide, >520px tall) gets the
raw mobile-portrait layout on every page.** Nothing targets this band —
`landscape-phone:` requires height ≤520px, `lg:` requires width ≥1024px.
A 10" Android tablet in landscape (~960x600), a Surface Duo unfolded
(~1892x720 halved per-pane, or ~900x673 combined), or a small Chromebook
window land here. Concretely on Watch: `landscape-phone:` doesn't fire
(height >520px) so the page stacks portrait-style — video capped at
`max-h-[48dvh]` (≈288px in a 600px-tall viewport) sitting above a
timeline that scrolls the *whole page* (not its own pane), and BottomNav
renders as the bottom-anchored floating pebble (not the left rail) since
that also gates on `landscape-phone:`. The bottom nav is fully usable
here (there's height for it), but the page layout wastes the ~650px+ of
horizontal room. **Fix:** either widen the `landscape-phone:` custom
variant's height ceiling to something like 620–640px so more real tablets
qualify for the two-pane treatment, or add a parallel `landscape-tablet:`
variant (`orientation: landscape) and (min-width: 700px) and (max-height: 900px)`,
excluding the already-handled `lg:` band via a `max-width` clause) that
opts Watch's grid + BottomNav's rail-docking into this band too.

**[A4] `WatchRibbon` is hidden below `lg:` on the Watch route** (App.tsx:127-134,
`hidden lg:block`) but shown unconditionally on every other route. On the
Top-Finding two-pane fix, decide explicitly whether the new `lg:` grid
should also show the ribbon (it currently only shows at `lg:`, which is
consistent) or keep hiding it in favor of the on-video armed-state pill —
right now the video's own floating camera-name pill (`Watch.tsx:452`) and
the ribbon's armed-state cluster would BOTH render simultaneously at
`lg:` widths once inside the `full` fullscreen state is exited, which is
already true today and worth a quick real-device check once A1 lands (two
"armed" indicators stacked, ribbon above + pill on video, is redundant —
same class of problem the code comments at `Watch.tsx:412-424` already
solved once for the fullscreen cluster).

---

## Category B — Hover affordances

**[B1] `EventRow` (Watch's "Today at home" list + Review's "more from
tonight") has zero `hover:` styling.** `client/src/components/EventRow.tsx:53-61`
— the `<button>` wrapper only wires `onPointerDown={ripple}` (a touch/press
effect) and `focus-visible` styles; no `hover:bg-*` / `hover:border-*`.
Compare to `EventList.tsx:538`'s `EventCard`, which has
`hover:border-[var(--color-border-strong)] hover:bg-[var(--color-surface-raised)]`
for the *exact same kind of row* rendered on the Events page. On a laptop
with a mouse, the Watch home page's primary interactive list (today's
whole story) gives no visual feedback on hover — every row looks
identical whether or not it's clickable, until the user clicks and sees
the ripple. **Fix:** add the same `hover:border-[var(--color-border-strong)]
hover:bg-[var(--color-surface-raised)]` pair EventList already uses so the
two shared-shape components read consistently and desktop users get a
hover cue.

**[B2] Range-slider thumb has no `:hover` state.** `client/src/index.css:718-728`
(`.slider::-webkit-slider-thumb`) defines `:active` (scale 1.15) and
`.slider:focus-visible` (outline), but no `:hover`. Every settings slider
(`Slider.tsx`, used across `DetectionSection.tsx` for sensitivity/schedule
knobs) is a flat circle until the mouse button is actually down. On
desktop, where a mouse can hover before committing to a drag, this reads
as slightly inert. **Fix:** add
`.slider::-webkit-slider-thumb:hover { transform: scale(1.08); }` (and the
`-moz-range-thumb` equivalent) — small, matches the existing `:active`
idiom, no layout shift since it's a `transform`.

**[B3] `EventRow`'s time/subline text has no hover-distinct treatment from
its container** — minor, folds into B1; once the row itself gets a hover
background the text doesn't need its own state.

---

## Category C — Keyboard navigation

No new gaps found beyond what's already fixed. Spot-checked and confirmed
solid:
- `ClipModal` (`client/src/components/ClipModal.tsx:365-376,775-803`) and
  `SnapshotPreview` (`client/src/components/SnapshotPreview.tsx:78-116`)
  both trap focus, close on Escape, and return focus to the trigger.
- `confirm-impl.tsx:48-93` (the app-wide confirm dialog) does the same.
- Settings tabs (`Settings.tsx:272-309`) and the Events chip rows use the
  WAI-ARIA roving-tabindex pattern via `nextRovingIndex` — arrow keys move
  selection, Tab moves out. `aria-orientation` flips with the `lg:`
  vertical-rail layout (`Settings.tsx:290-298`).
- `SideRail` (`client/src/components/SideRail.tsx:81`) and `WatchRibbon`
  buttons all carry `focus-visible:outline-2 outline-[var(--color-accent-default)]`.

**[C1] Watch's fullscreen ESC handler is page-scoped, not element-scoped —
fine functionally, but worth a note for the A1 rework:** `Watch.tsx:253-264`
attaches `keydown` to `window` while `full` is true and locks
`document.body.style.overflow`. Once a desktop two-pane layout exists
alongside fullscreen, double-check the new pane's internal scroll
container doesn't fight `document.body.style.overflow: hidden` (the pane
uses its own `overflow-y-auto` per `landscape-phone:overflow-y-auto` at
`Watch.tsx:503` — the same class needs to exist at `lg:` once A1 ships,
and body-scroll-lock during fullscreen should still work since fullscreen
is a `fixed inset-0` sibling, not a descendant of the pane).

---

## Category D — Information density

**[D1] Watch home: see Top Finding + A1 — the single largest density gap
in the app.** A 1920x1080 desktop currently shows one 48dvh-capped video
strip and a single-column event list running the full 1850px width. The
"Live + Events side-by-side" opportunity the audit brief names explicitly
is the correct fix and is already half-built (`landscape-phone:` proves
the grid shape works) — it's just gated to the wrong breakpoint.

**[D2] Settings, Events, People are already well-covered** — confirmed
in-repo:
- Settings has an `lg:` left-nav rail of section anchors
  (`Settings.tsx:311-329`, `lg:w-48 lg:flex-none lg:sticky`) — exactly the
  category-D "left-nav of section anchors" fix the brief calls out, already
  shipped (iter-356.58 "LAYOUT REBUILD" comment).
- Events has an `lg:` right-rail calendar (`Events.tsx:1495-1513`, `w-80
  shrink-0 sticky self-start`) sitting beside a deliberately single-column
  incident-log timeline (`EventList.tsx:159-179` — Maya's documented
  rejection of a Pinterest/Stripe-dashboard grid is on record in the
  comment; not re-litigating that call here).
- People has `lg:max-w-4xl` + a grid pairing at `lg:` (`People.tsx:159`,
  referenced "iter-262 grid layout pairs at lg").

**[D3] Events' inner timeline column is double-capped and can leave a
visible gap on wide screens.** `Events.tsx:1333` wraps the whole row in
`lg:max-w-6xl lg:mx-auto lg:flex lg:items-start lg:gap-4`; inside it,
`.flex-1 min-w-0` (`Events.tsx:1334`) wraps `<EventList>`, which itself
re-caps at `lg:max-w-3xl lg:mx-auto` (`EventList.tsx:180`). On a viewport
wide enough that `max-w-6xl` (1152px) minus the `w-80` (320px) aside minus
gap leaves more than 768px for the flex-1 slot (true above ~1300px
content-column width, i.e. most 1440p+ laptops), the timeline's own
`mx-auto` re-centers it inside the leftover space rather than hugging the
aside — producing an uneven, slightly-off-center gap between the timeline
and the calendar rail. Minor (a few tens of px), but easy to fix: drop the
inner `lg:mx-auto` (keep `lg:max-w-3xl` only) so the flex parent's own
alignment governs, or accept it as intentional if the current visual has
been eyeballed and approved.

**[D4] Training / Review pages not depth-audited this pass** — flagged for
follow-up, not enough signal gathered to make a specific claim; both are
lower-traffic than Watch/Events/Settings/People and were deprioritized
given the time budget.

---

## Category E — Pointer precision

**[E1] `ZoneEditor` already does the touch-vs-cursor split correctly** —
confirmed, not a finding. `client/src/components/ZoneEditor.tsx:26-27`
comment + implementation: a transparent `r=0.04` hit-ring sits over each
visible `r=0.018` vertex dot (`:360-373`, `:425-432`), giving touch a big
target while the visible dot stays small/precise-looking for a mouse
cursor. `cursor: 'grab'` is set explicitly on the hit ring
(`ZoneEditor.tsx:373,431`). No change needed.

**[E2] Slider track width scales with its container, which is a net
positive for desktop precision** (wider track = finer per-pixel
resolution) — not a finding, noting it as confirmed-good since the brief
asks specifically about this.

**[E3] Slider thumb has no hover growth** — see B2 (filed under hover, the
fix is the same one line).

---

## Category F — Dual-device parity

**[F1] Watch's `useIsLandscape()` fullscreen fit-mode hook only reacts to
`matchMedia('(orientation: landscape)')`, not viewport size** —
`client/src/pages/Watch.tsx:31-45`. On a landscape *desktop* monitor
(1920x1080 is `orientation: landscape` too), entering the CSS-only
fullscreen (`full` state) will pick `fit="cover"` exactly like a rotated
phone (`Watch.tsx:360`). For a 16:9 stream inside a fixed `inset-0` on a
16:9 or wider monitor this is usually fine/desired (fills the screen), but
on an ultrawide (21:9) desktop monitor it will crop the stream's vertical
extent aggressively — the same crop tradeoff described in the F4 real-
device comment (`Watch.tsx:19-30`), but that comment's rationale ("minor
top/bottom sliver") was reasoned about a phone's ~19.5:9 aspect, not a
32:9 super-ultrawide desktop panel where the crop stops being minor.
**Fix:** gate the `cover` choice on viewport aspect ratio too (e.g. only
`cover` when `window.innerWidth / window.innerHeight < ~2.0`), or simply
scope `useIsLandscape()`'s cover behavior to `landscape-phone:`-equivalent
short-viewport conditions (mirrors the CSS variant already defined) rather
than raw `matchMedia('orientation: landscape')` which fires identically on
every desktop monitor.

**[F2] BottomNav's `landscapeOnly` Review tab and SideRail's always-visible
Review tab are the intended nav-parity fix and are correctly implemented**
— confirmed, not a finding (`BottomNav.tsx:18-27`, `:32`). No action.

---

## Summary table

| # | Category | Finding | File:line | Severity |
|---|----------|---------|-----------|----------|
| Top | A/D | Watch has no `lg:` layout at all — video crops wide, timeline runs full-bleed | `Watch.tsx:302,343,597` | Critical |
| A1 | A | No content-width ceiling on Watch at any desktop breakpoint | `Watch.tsx:302` | Critical (dup of Top) |
| A2 | A | `EventRow` has no width cap of its own (currently parent-dependent) | `EventRow.tsx:14` | Low |
| A3 | A | "Tweener" landscape viewport (700–1023px wide, tall) gets raw mobile layout everywhere | index.css:16 (variant gap) | Medium |
| A4 | A | WatchRibbon visibility vs on-video pill needs re-check once A1 ships | `App.tsx:127-134`, `Watch.tsx:412-424` | Low |
| B1 | B | `EventRow` button has zero `hover:` styling | `EventRow.tsx:53-61` | Medium |
| B2 | B | Slider thumb has no `:hover` | `index.css:718-728` | Low |
| C1 | C | Body-scroll-lock vs new pane scroll container — verify after A1 | `Watch.tsx:253-264` | Low (advisory) |
| D1 | D | Same as Top Finding | — | Critical (dup) |
| D3 | D | Events timeline double-`mx-auto` leaves uneven gap next to calendar rail on wide screens | `Events.tsx:1333`, `EventList.tsx:180` | Low |
| D4 | D | Training/Review not audited this pass | — | Follow-up |
| F1 | F | Fullscreen `cover` fit-mode fires on any landscape orientation, including ultrawide desktop monitors | `Watch.tsx:31-45,360` | Medium |

---

## Top 3 to ship first

1. **Top Finding / A1 / D1** — give Watch an `lg:` two-pane grid (mirror
   the already-proven `landscape-phone:` 58/42 grid shape) with a capped
   video `max-w` and a capped, independently-scrolling timeline column.
   This single change fixes the worst max-width violation, the worst
   wasted-space problem, and delivers the exact "Live + Events side-by-
   side" desktop affordance the audit brief asks for by name.
2. **B1** — add `hover:border-[var(--color-border-strong)]
   hover:bg-[var(--color-surface-raised)]` to `EventRow` (one class-string
   change, matches the sibling `EventCard` component exactly).
3. **A3** — extend `landscape-phone:`'s height ceiling (or add a sibling
   `landscape-tablet:` variant) so the ~700-1023px-wide, >520px-tall
   tablet/foldable band isn't silently left on the raw mobile-portrait
   layout.
