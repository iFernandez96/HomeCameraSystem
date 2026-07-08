# Portrait Mobile Audit — 2026-07-07

**Scope:** `client/src` viewed strictly through the portrait-phone lens (360/390/430 CSS px). Theme is Playroom Modern (dual light/dark, Bricolage Grotesque display, pill/1.5px-border grammar, floating pebble BottomNav) — this audit assumes that theme is correct and looks for places that don't yet live up to it, not places to replace it.

**Method:** read `client/index.html`, `client/src/index.css` (design tokens), `App.tsx`/`AppShell`, `BottomNav.tsx`, `VideoTile.tsx`, `Watch.tsx`, `WatchRibbon.tsx`, `VideoPlayer.tsx`, `EventRow.tsx`, `EventList.tsx`, `Events.tsx`, `ClipModal.tsx`, `Login.tsx`, `Slider.tsx`, `QualityMenu.tsx`, `ZoneEditor.tsx`, `Settings.tsx` + `settings/parts.tsx`, `EventHeatmap.tsx`, `ConnectionBanner.tsx`, `CaptureSavingPill.tsx`, plus greps for `100vh`, `cursor-pointer`, hover-only styles, small input font sizes, and touch-target sizing conventions (`min-h-[44px]`, the `p-2.5 -m-2.5` hit-area-expansion idiom).

**Headline finding up front:** this codebase has already been through many mobile-audit passes (the `iter-356.x`, "Fuzz F#", "Painfix #", "bug sweep" comment trail is extensive and mostly correct — safe-area handling, the pebble nav's 90px real footprint math, `100dvh` usage, `interactive-widget=resizes-content`, the 44px touch-target convention, swipe-to-delete, focus traps, etc. are all already right). What's left is a small number of **specific undersized controls that never got the `min-h-[44px]` / hit-area-expansion treatment the rest of the app uses religiously**, plus a couple of second-order polish items. There is no `100vh` anywhere in the client (grep confirmed zero hits) — the app already exclusively uses `100dvh`/`min-h-full`/flex sizing.

---

## Ranked findings

### 1. [CRITICAL-ish / B] Stream-quality trigger button on the live tile is ~24px tall — well under the 44px floor the rest of the app enforces

`client/src/components/QualityMenu.tsx:141`

```
className="relative overflow-hidden flex items-center gap-1.5 bg-black/60 backdrop-blur ring-1 ring-white/20 px-2 py-1 rounded-full text-xs font-medium text-white focus-visible:outline-2 ..."
```

This is the "Auto / HQ / Data-saver / Ultra-low" trigger that sits at `bottom-3 left-3` on every `VideoTile` (`VideoTile.tsx:655-657`) — i.e. the bottom-left corner of the live video on Watch, right next to the Snapshot/Expand/bbox-toggle/fullscreen buttons in the bottom-right corner, all of which are correctly `w-11 h-11` (44px). The quality trigger is `px-2 py-1` with `text-xs` (11px) and a 14px icon — real height comes out to roughly **20-24px**, against a live video background, on a control whose whole job is "pick your cellular data tier," which matters most exactly when someone is fumbling with a phone on a weak signal. It's also the one interactive glyph on the tile that doesn't share the `w-11 h-11` grammar every sibling button on the same corner-row uses, so it reads visually inconsistent as well as being hard to hit.

**Fix:** wrap in the same hit-area-expansion idiom already used elsewhere in this file's sibling components (`Login.tsx`'s show-password button, `Settings/parts.tsx`'s `Toggle`) — add `p-2.5 -m-2.5` (or bump to `min-h-[44px]` directly, since this sits over black video and a slightly taller pill won't clash with anything) without changing the visual pill size. The `role="listbox"` popover items opened by this trigger (`QualityMenu.tsx:188`, `px-3 py-2` with two stacked text lines) are borderline OK (~44px) but would benefit from the same `min-h-[44px]` explicit floor rather than relying on content height.

### 2. [B] "Full history →" link on the Watch/Home timeline header has no expanded hit area at all

`client/src/pages/Watch.tsx:601-608`

```tsx
<button
  type="button"
  onClick={() => navigate('/events')}
  className="text-xs font-semibold text-[var(--color-accent-deep)] hover:text-[var(--color-accent-bright)] focus-visible:outline-2 focus-visible:outline-[var(--color-accent-default)] focus-visible:outline-offset-2 rounded"
>
  Full history →
</button>
```

No padding, no `min-h`, no `-m` hit-area trick — the tappable region is exactly the glyph box of an 11px `text-xs` line, maybe 16-18px tall. Every other small text-link button in the codebase that isn't this one got the treatment (Events.tsx's "Select" button at `Events.tsx:1015` is `min-h-[44px] ... px-1`; the Events "Filter by day" calendar icon button is `p-2.5 -m-2.5`). This one link was missed. It's the primary escape hatch from the Home timeline into full Events history, so it's a real navigation control, not decoration.

**Fix:** add `-m-2 p-2` (or the codebase's `-m-2.5 p-2.5` convention) so the 44px floor is met without moving the visible text.

### 3. [C / B] `VideoPlayer`'s speed-select and Repeat button are 36px, below the 44px floor — and they're the ONLY playback-speed controls on mobile

`client/src/components/VideoPlayer.tsx:152` (`<select>`, `min-h-[36px]`) and `:166` (Repeat `<button>`, `min-h-[36px]`).

The component's own header comment explains why native `<video controls>` is used instead of a hand-rolled bar ("sub-44px targets" was literally one of the reasons the old custom control bar was thrown out) — but the *replacement* strip that was added back underneath (Speed `<select>` + Repeat toggle, because "mobile Chrome's native bar has no speed control") reintroduces exactly the sub-44px problem it was trying to avoid, just in a smaller, easier-to-miss strip. This strip is the only way to change playback speed on mobile Chrome/Safari (per the component's own comment — desktop gets it for free from native controls), and it renders inside `ClipModal` (the most-used mobile surface after Watch/Events) and `TimelapsesSection`.

**Fix:** bump both `min-h-[36px]` → `min-h-[44px]` in `VideoPlayer.tsx:152` and `:166`. The strip already sits on its own `bg-black px-3 py-1.5` row below the video with room to grow slightly taller without disturbing the video frame above it.

### 4. [A, minor] `HourScrubber`'s live time labels (`12 AM / 6 AM / 12 PM / NOW`) sit under `pr-16` with no safe-area-right accounting on notch-less phones, but do carry it correctly for the bottom via inline style

`client/src/pages/Watch.tsx:757, 799`

The scrubber container correctly pads its *bottom* for the home-indicator (`paddingBottom: 'max(1.5rem, env(safe-area-inset-bottom))'`, `:757`), but the label row (`:799`, `flex justify-between ... pr-16`) uses a hardcoded `pr-16` to dodge the fixed-width `● LIVE` chip instead of reading the chip's actual width or padding for the *right* safe-area inset. On a landscape-locked fullscreen video (which is exactly the mode this scrubber renders in — see `screen.orientation.lock('landscape')` in `VideoTile.tsx:576`) on a notched iPhone the right-side safe-area inset (Dynamic Island / camera housing, depending on physical rotation) can eat into that `pr-16` reserve. This is a narrow edge case (only manifests in fullscreen + landscape + notch) and low severity, but it's the one un-safe-area-audited corner of an otherwise very safe-area-disciplined page.

**Fix:** `paddingRight: 'max(4rem, env(safe-area-inset-right))'` on the label row, mirroring the pattern already used everywhere else in this file (`Watch.tsx:427`, `:471`).

### 5. [B, minor] `Slider` (`Settings` sensitivity / clip-duration sliders) has no explicit minimum touch height on the `<input type="range">` track itself

`client/src/components/Slider.tsx:74-89`, styled via `.slider` in `index.css:705-745`.

The `.slider` class sets `height: 0.375rem` (6px) for the visual track and a `1.25rem` (20px) thumb, with no `min-height` on the `<input>` element itself beyond what the thumb naturally occupies (browsers typically size a range input's box to roughly the thumb height, ~20-24px, not 44px). Range inputs are a known, accepted exception to the strict 44px button-target rule (the entire width is draggable, and precision tapping isn't really how anyone uses a slider), so I'm not flagging this as a hard violation — but the wrapping `<div className="px-4 py-3">` (`Slider.tsx:64`) only adds 12px top/bottom, giving a total interactive column of roughly 12+24+12 ≈ 48px, which is fine for *dragging* but tight for a precise single tap-to-set on a narrow phone. Given every other control in this app got the explicit `min-h-[44px]` treatment, it's worth a `min-h-[44px] flex items-center` wrapper around the `<input>` for consistency, purely for the tap-to-jump-to-value gesture (which range inputs do support).

**Fix (nice-to-have, not urgent):** wrap the `<input type="range">` in a `min-h-[44px] flex items-center` div so a tap anywhere in a taller invisible band still lands on the track.

### 6. [Anti-recommendation — NOT a finding] `QualityMenu` listbox items (`px-3 py-2` with two stacked lines)

`client/src/components/QualityMenu.tsx:188`. Measured height with the `text-xs`/`text-[11px]` two-line label + `py-2` padding comes to roughly 44-46px — right at the floor, not under it. Left as an observation only; no fix needed unless a future copy change lengthens the subtitle to three lines, at which point an explicit `min-h-[44px]` would future-proof it.

---

## What's already right (do not touch / do not "fix")

- **Safe-area coverage is comprehensive and correct.** `BottomNav.tsx:79` folds `env(safe-area-inset-bottom)` directly into the pebble's `mb-[calc(...)]` (not a naive `pb-`), with a documented ~90px real footprint (`BottomNav.tsx:61-68`) that `App.tsx:199-203`'s `<main>` clearance (`pb-[calc(6rem+env(safe-area-inset-bottom)+7.5rem)]` on Watch, `6rem` elsewhere) is kept in lock-step with via paired comments. `WatchRibbon.tsx:108-113` handles top/left/right insets independently for the notch AND the landscape Dynamic Island case. This is more thorough safe-area handling than most production PWAs ship.
- **`100dvh`/`100vh` discipline.** Zero raw `100vh` anywhere in `client/src`; the codebase already uses `100dvh` (`Watch.tsx:302`) or flex/`min-h-full` sizing everywhere else. No iOS address-bar-jitter risk from this class of bug.
- **Input font-size floor.** Every `<input>` I found (`Login.tsx:227/252`, `People.tsx:268`, `ZoneEditor.tsx`, `Settings` sections) uses `text-base` (16px) or an explicit `text-base` override, which suppresses the iOS Safari auto-zoom-on-focus bug. None slip below 16px.
- **Touch-target discipline is the *norm*, not the exception**, which is exactly why findings #1-#3 above stand out — `BottomNav` tabs, `Toggle`, `Login`'s show-password eye, `EventList`'s swipe-delete pad + corner ✕, `EventHeatmap` day cells, `ZoneEditor`'s vertex hit-rings (`r=0.04` transparent ring over a smaller visible dot, explicitly sized "~32px on an 800px editor" per its own comment), `Settings` tab strip — all correctly use either a real `min-h-[44px]`/`w-11 h-11` box or the `p-2.5 -m-2.5` invisible-padding trick. This is a codebase where 44px is clearly a written-down convention that's followed almost everywhere, which is why the misses above are worth calling out specifically rather than being lost in a sea of "make buttons bigger" generic notes.
- **`ClipModal` mobile-collapse layout** (`ClipModal.tsx:813-822, 843-851, 1013-1031`) is a genuinely well-reasoned fix for a real bug class (flex children racing to zero height when a sibling grows) — the comments show it was caught on a real device (Firefox Android) and fixed at the right layer (`shrink-0` + `aspect-video` on the video pane instead of ad-hoc `min-h` numbers). No changes needed.
- **`EventList` swipe-to-delete** (`EventList.tsx:386-457`) correctly disambiguates horizontal vs vertical touch drags (`touchAxis` gate at `:423-428`) so a vertical scroll gesture starting on a card never gets misread as a swipe, and it degrades to an always-visible corner ✕ on touch (not hover-only) — this is exactly the right mobile-first call.
- **Adjacent touch-target spacing** — checked the Watch glance-row (`gap-2.5` = 10px between two `flex-1` cards, `Watch.tsx:505`), the Events filter chip rows, and the ClipModal action row (`gap-x-3` = 12px, wraps via `flex-wrap` below 379px per its own fix-wave comment at `ClipModal.tsx:943-951`) — all clear the 8px minimum gap comfortably.
- **`<video>` `playsinline` / iOS quirks** — `VideoTile.tsx:649` and `VideoPlayer.tsx:124` both carry `playsInline`; `VideoTile.tsx:584-600` explicitly binds `webkitbeginfullscreen`/`webkitendfullscreen` because the standard `fullscreenchange` event doesn't fire on iOS Safari's native player — a quirk most audits miss entirely.

## Anti-recommendations (things a less-careful audit might flag as bugs — they are not)

- `Slider`'s 6px visual track height is a deliberate Playroom Modern token (`--space` scale, `index.css:705-745`) matched to the 20px thumb — not a touch-target bug on its own (see finding #5, which is about the wrapper, not the track height).
- The `HourScrubber`'s tiny per-hour bucket cells (`Watch.tsx:769-788`, `flex-1` cells in a `h-8` row, no individual button semantics) are correctly `aria-hidden` and non-interactive — only the wrapping `<button>` (`Watch.tsx:760-764`) is a target, and that one *is* sized (`h-8` = 32px, but full-width tap area within a `flex-1` row inside a fullscreen scrim with generous vertical padding around it). Not flagged as its own item since the whole row is one 32px-tall button, not N tiny ones.
- `ZoneEditor`'s visible vertex dots being small (`r=0.018` ≈ a few px) is fine — the actual hit target is the separate, larger, invisible `r=0.04` ring layered on top (documented in the component's own header comment), which is the correct pattern (visual size ≠ hit size) and not a bug.
- `WatchRibbon` being hidden on mobile Watch/Home (`App.tsx:127-134`, `hidden lg:block` wrapper) is intentional — the on-video scrim carries the armed state on that route so a second status bar doesn't duplicate it. Not a missing-safe-area bug; it's a deliberate one-status-source-of-truth decision, documented at `Watch.tsx:66-70`.

## Top 3 to ship first

1. **QualityMenu trigger button** (`QualityMenu.tsx:141`) — smallest fix (one class change), highest actual-use frequency (every Watch page load renders this on the live tile), and it's inconsistent with its own sibling buttons on the same video corner.
2. **VideoPlayer speed/repeat strip** (`VideoPlayer.tsx:152`, `:166`) — affects every clip review on mobile (the app's second-most-visited surface after Watch), and the component's own comments show the team already cares deeply about touch-target correctness here — this is a straightforward oversight, not a design tradeoff.
3. **"Full history →" link** (`Watch.tsx:601-608`) — the one primary-navigation control that never got the hit-area-expansion pass the rest of the app got; cheap one-line fix.
