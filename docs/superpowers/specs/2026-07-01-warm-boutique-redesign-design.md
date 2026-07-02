# Warm-boutique redesign — "Sunroom" (2026-07-01)

User directive: "Please make the UX way better… as professional as possible… completely
overhaul it, feel free to overwrite the work already done." Direction picked by user:
**Refined warm + cats** — keep Panther/Mushu/Coco as a real brand identity but rebuild
everything around them to boutique-app polish (Things 3 warmth). Cat layer redesigned,
not removed.

## Thesis

The app is the family's window into a sunlit house guarded by three cats. The previous
"Watchpost" iteration went dark den-at-dusk; this redesign returns to daylight but at
boutique quality: warm linen surfaces, ink-black text (Panther), one marmalade accent
(Coco), quiet brass details (the house's hardware). Serious security signal always wins
over whimsy: state colors and video are never decorated.

**Signature element:** the calico tri-tone discipline — Panther-ink for primary actions,
Coco-marmalade as the single accent, Mushu-white for paper surfaces — plus the paw-print
active-nav mark. Cats appear where they carry meaning (brand mark, empty states, the Live
habitat strip); nowhere else.

## Tokens (names preserved — the codebase flips automatically)

Color (all AA-checked on their intended ground):

| Role | Value |
|---|---|
| bg (warm linen) | `#f6f1e7` |
| surface (cream paper) | `#fffdf7` |
| surface-raised (hover) | `#f1e9d8` |
| border subtle / default / strong | `#e9dfc9` / `#d8c9a8` / `#b7a077` |
| text primary (Panther ink) | `#292013` |
| text secondary / tertiary / disabled | `#6b5c3d` / `#857550` / `#b6ab90` |
| accent default (marmalade) | `#b3540b` (bright `#d97316`, subtle `#faeeda`, muted `#f3ddbd`) |
| brass default / bright / subtle | `#9a742a` / `#b08a38` / `#f3ead3` |
| success / warning / danger / info | `#1e7d3f` / `#94660c` / `#b3372e` / `#64748b` |
| danger-strong (fill, white text) | `#dc2626` |
| skeleton / strong | `#ece3cf` / `#e2d7bd` |

Shadows: warm-brown alpha (`rgb(90 70 40 / …)`), soft and low — paper in daylight, not
neon glow. Card inset highlight becomes a white top edge. Semantic tints drop back to
light-bg percentages (10–14%).

Type: keep the self-hosted pair — Fraunces (display: page titles, wordmark, day headers)
+ Inter (everything else). Scale and tracking rules unchanged.

Radius / spacing / motion / z scales: unchanged.

## Structure (kept)

WatchRibbon (56px status bar) + SideRail (64px icon rail, desktop) + BottomNav (mobile)
survive — the shell architecture is right; only its skin flips. Per-page card system,
spacing rhythm (4px base), one primary action per screen.

## Cat-brand discipline

- CatTrioMark in ribbon; paw active-nav marks; PawSpinner: keep.
- CatEmptyState: keep as the only empty-state primitive (light-theme retune).
- CatLayer: Live route only (already); container blends with linen bg.
- No cat may obscure or soften a danger/offline state (security-UX guardrail).

## Invariants that must survive (from CLAUDE.md "Don't reintroduce")

Visibility-resume listeners, WS close-1008 semantics, auth window signals, WHEP/ICE
config, drawBoxes overlay, safe-area insets, reduced-motion global, sr-only skip link,
`bg-[var(--color-x)]` (never `bg-[--color-x]`), CatEmptyState as sole empty-state
primitive, accessible-name conventions. Tests update on touch (BDD-lite for new ones).

## Execution order

1. Token flip in `index.css` (+ global CSS retune: shadows, scrollbar, selection).
2. Hardcoded dark-leftover sweep (grep hexes + dark assumptions).
3. Shell polish (ribbon / rail / bottom nav).
4. Per-page polish (parallel agents): Live, Events, Settings, People+Training+Review,
   Login, shared modals/states.
5. Full verify (vitest, typecheck, lint, build) → Maya/Frank critic pass → fix → commit.
