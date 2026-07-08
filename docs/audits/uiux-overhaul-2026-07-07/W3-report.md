# W3 report — Controls, Settings, ClipModal, perf config (2026-07-07)

Implementer W3 of the 3-agent UI/UX overhaul. Scope: every item under
"W3 — Controls, Settings, ClipModal, perf config" in SYNTHESIS.md.
All 7 items shipped. No server/detection changes; no wire shapes touched.

## 1. Touch targets (portrait #1 / #3, Frank A2 / A3)

- `client/src/components/QualityMenu.tsx` — the trigger's visual pill is
  ~26px tall; it now gets the `p-2.5 -m-2.5` hit-area-expansion idiom
  (same as parts.tsx Toggle / DetectionSection's DisabledToggleDisplay):
  the `<button>` carries the expanded padding + negative margin, and the
  pill visuals (bg-black/60, ring, rounded-full, px-2 py-1) moved to an
  inner `<span data-ripple-host>` so the press ripple stays clipped to
  the visible pill instead of bleeding into the invisible padding
  (`useRipple` already prefers a `[data-ripple-host]` child). Visual
  pill size unchanged; tap target now ≥44px. Listbox option rows left
  as-is per the portrait audit's own anti-recommendation (#6 — they
  already measure ~44-46px).
- `client/src/components/VideoPlayer.tsx:152,166` — speed `<select>` and
  Repeat button `min-h-[36px]` → `min-h-[44px]`.
- `client/src/pages/settings/DetectionSection.tsx` ("What to detect"
  class chips) — `min-h-[36px]` → `min-h-[44px]`.
- Verified no other `min-h-[36px]` remains in owned files.

## 2. ClipModal landscape-phone two-pane reflow (coherence MOBILE #1)

`client/src/components/ClipModal.tsx` — a rotated phone (landscape,
height <520px) used to get the portrait stack inside a <400px-tall
viewport. The modal now mirrors its own `lg:` split at the existing
`landscape-phone` custom variant (index.css:16), expressed in flex to
extend the existing conditional rather than introducing a second grid
system (per coherence.md's own note that extracting components here
would be over-engineering):

- dialog container: `landscape-phone:flex-row landscape-phone:overflow-hidden`
- video-pane column: `landscape-phone:flex-1 landscape-phone:min-h-0`
  (fills remaining width, the 58%-ish left pane)
- video frame: `landscape-phone:flex-1 landscape-phone:aspect-auto
  landscape-phone:min-h-0` + tightened margins (`mx-3 mt-2 mb-1`)
- evidence aside: `landscape-phone:w-[42%]` (proportional, mirroring
  Watch.tsx's `grid-cols-[58%_1fr]` ratio; lg keeps its fixed `w-80`),
  `landscape-phone:border-l landscape-phone:border-t-0`; it already had
  `overflow-y-auto overscroll-contain` so it scrolls independently.

The mobile-collapse fixes documented in the file (shrink-0 column,
aspect-video frame, poster/fillHeight) are untouched on portrait — all
landscape-phone classes are additive overrides. Known benign edge: a
desktop window that is BOTH ≥1024px wide and <520px tall matches both
variants; the two layouts are the same shape (row + clipped + side
aside) so whichever margin/width rule wins is visually equivalent.

## 3. CatEmptyState landscape scaling (device run-through #9/#10)

`client/src/components/CatEmptyState.tsx` — in short viewports the
mascot filled the screen with the CTA below the fold (Faces) and
clipped under the ribbon (Review). The sprites size themselves via
inline width/height props (RasterSprite / SleepingCatIllustration), so
CSS width overrides can't win; instead the figure row gets
`landscape-phone:h-14 landscape-phone:items-center` (56px layout
footprint) with `landscape-phone:[&>*]:scale-[0.55]
landscape-phone:[&>*]:origin-center` shrinking the artwork inside it,
plus `landscape-phone:py-3` / `landscape-phone:space-y-2` compressing
the vertical rhythm. Heading + body + CTA now fit a 520px-short
viewport without scrolling. No index.css helper needed — done entirely
with the registered custom variant + arbitrary child variant.

## 4. Settings theme row width cap (device run-through #11)

`client/src/pages/settings/AppearanceSection.tsx` — the three-tile
theme grid ("Match device / Sunroom / Lights off" hints) gets
`max-w-md` so it reads as a compact segmented group instead of
stretching across the full landscape/desktop content width. Portrait
phones are narrower than the cap, so nothing changes there. (The cap
lives in AppearanceSection — within ownership, no fallback report
needed.)

## 5. Login /live → / (Mira, Login)

`client/src/pages/Login.tsx:68,77` — both the already-authed
`<Navigate to="/live">` and the post-login `navigate('/live')` now
point at `/` (Watch), no longer bouncing through the retired alias.
`Login.test.tsx` migrated: test router exposes `/` instead of `/live`,
and the two touched tests were renamed to BDD-lite Given/When/Then with
arrange/act/assert blocks per convention.

## 6. People page-title alignment (Mira #3)

`client/src/pages/People.tsx` — the visible "Faces" title moves from
`font-display font-bold tracking-tight` (700) to the shared
`page-title` class (Bricolage 800, -0.03em tracking, 32px at lg) so it
matches Home's treatment exactly. The sr-only `<h1>` semantics are
unchanged. (Events' header is W2's per the synthesis split.)

## 7. Perf config (perf A1 / F1 / A5, landscape B2)

- `client/vite.config.ts` — added
  `build.rollupOptions.output.manualChunks = { vendor: ['react',
  'react-dom', 'react-router-dom'] }`. The framework trio now lands in
  a stable `vendor` chunk that survives app deploys in cache.
- `client/index.html` — removed ONLY the Bricolage variable-font
  preload; Inter's preload stays. Bricolage still loads via its
  @font-face (font-display: swap) in src/index.css; headings render in
  the fallback face for a beat on cold cache and upgrade.
- `client/src/lib/drawBoxes.ts:12` — reworded the comment so the
  backticked bracketed token no longer appears; Tailwind v4's scanner
  was emitting a junk utility rule + an `Unexpected token Delim('.')`
  build warning from it. Comment now also explains WHY it avoids the
  token form so nobody reintroduces it.
- `client/src/index.css` — added `.slider::-webkit-slider-thumb:hover`
  and `.slider::-moz-range-thumb:hover` at `scale(1.08)`, declared
  before the existing `:active` (1.15) rule so press wins while both
  apply. Nothing else in index.css was touched (the CatEmptyState work
  turned out not to need a helper there).

## Tests

New pins added (all BDD-lite Given/When/Then + arrange/act/assert):

- `QualityMenu.test.tsx` — trigger hit-area idiom + inner ripple-host pill.
- `VideoPlayer.test.tsx` — 44px floor on speed select + Repeat.
- `DetectionSection.test.tsx` — 44px floor on class chips.
- `ClipModal.test.tsx` — landscape-phone classes on dialog / video pane
  / evidence aside.
- `CatEmptyState.test.tsx` — landscape-phone compaction classes on
  wrapper + figure (query scoped by accessible name because the Button
  primitive mounts its own sr-only role="status").
- `AppearanceSection.test.tsx` — max-w-md cap on the tile grid.
- `People.test.tsx` — visible title carries `.page-title`.
- `Login.test.tsx` — the two /live-pinning tests migrated to `/` and to
  BDD-lite naming on touch.

Targeted vitest run (only touched files, per instructions):
**8 files, 144 tests, all passing** (`QualityMenu`, `VideoPlayer`,
`ClipModal`, `CatEmptyState`, `Login`, `People`, `DetectionSection`,
`AppearanceSection`).

## Build verification

`npm run build` (full `tsc -b` + `vite build`) PASSES on the shared
working tree with all three agents' changes present, including the PWA
service-worker pass (30 precache entries, 717.78 KiB). Earlier attempts
failed on a transient JSX syntax error in W2's in-flight
`EventHeatmap.tsx` (their file, never touched by W3); an interim build
in an isolated tree copy with only that file reverted to HEAD produced
byte-identical chunk sizes, and the final full-tree build below
confirms them.

Chunk sizes (raw / gzip):

| chunk | raw | gzip |
| --- | --- | --- |
| **vendor** (new: react + react-dom + react-router-dom) | 48.85 kB | 17.22 kB |
| index (app shell) | 238.90 kB | 73.36 kB |
| Settings | 81.19 kB | 21.50 kB |
| Watch | 39.42 kB | 11.24 kB |
| Events | 34.61 kB | 10.91 kB |
| Training | 19.56 kB | 5.79 kB |
| ClipModal | 16.86 kB | 6.00 kB |
| People | 8.86 kB | 3.13 kB |
| Login | 7.59 kB | 2.52 kB |
| EventHeatmap.lazy | 6.92 kB | 2.39 kB |
| Review | 5.06 kB | 2.08 kB |
| VideoPlayer | 2.52 kB | 1.20 kB |
| CSS | 80.59 kB | 14.73 kB |

The framework trio now lives in the standalone ~17 kB-gzip `vendor`
chunk (was fused into the index chunk, which correspondingly shrank by
about that much), so app-only deploys no longer invalidate the
framework bytes in client caches. Numbers reflect the shared tree as
of this build (W1/W2 changes included); they may drift a little if
those agents keep editing.

## Out-of-ownership notes

- The perf A5 junk-rule warning (`.bg-\[var\(\.\.\.\)\]` /
  `Unexpected token Delim('.')`) has a SECOND source the audit missed:
  `client/src/components/states/ErrorState.test.tsx:124` carries the
  same literal token in a comment. That file is outside W3's ownership
  list, so it was left alone — the warning persists until that one
  comment is reworded the same way drawBoxes.ts was. One-line
  follow-up.
- DangerZone was in the ownership list but had no W3 item (its
  themed-listbox finding is explicitly deferred in SYNTHESIS.md) —
  left untouched.
- W1/W2 files were not modified by W3; the interim EventHeatmap.tsx
  revert happened only inside a throwaway build copy, which was
  deleted after the build. The final `npm run build` ran on the real
  shared tree and passed.
