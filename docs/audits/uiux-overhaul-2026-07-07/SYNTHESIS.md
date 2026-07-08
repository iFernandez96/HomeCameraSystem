# Synthesis — UI/UX overhaul change-set (2026-07-07)

Sources: 7 expert agents + Codex gpt-5.5 + live device run-through (SM-S928U1, portrait+landscape, Jetson live). Consensus was strong; nearly every high item was flagged independently by 2+ auditors.

## Shipping now (3 worktree implementers)

### W1 — Watch/Home overhaul (owns Watch.tsx, WatchRibbon.tsx, VideoTile.tsx, EventRow.tsx, new lib/watchState.ts)
1. **`lg:` two-pane desktop layout for Watch** (landscape-desktop Top; coherence; codex#2): mirror the proven `landscape-phone:` grid at `lg:` — video left w/ `max-w` cap so `cover` stops canyon-cropping, glance+timeline right rail w/ inner `max-w`, independently scrolling. Also content-width ceiling on the timeline.
2. **One state vocabulary** (mira#1, codex#1): extract shared label map; glance card adopts ribbon vocab (On watch / Off duty / Camera offline); VideoTile pill stays stream-truth (Live/Connecting/Offline).
3. **Timeline error → `<ErrorState>` + Retry**, kill phantom "pull to refresh" copy (mira#4, hari GESTURE-4/STATE-1).
4. Fullscreen exit chevron `w-9`→`w-11` (frank#1, hari REACH-2); rail label `text-[8.5px]`→11px; scrubber labels 9px→11px + `safe-area-inset-right`; "Full history →" hit-area `-m-2 p-2`; Snapshot/Expand slotted actions → `rounded-full w-11 h-11` to match VideoTile row (mira#5); VideoTile status-pill radius unification (rounded-full).
5. **Honest hour scrubber** (hari GESTURE-2): tap a cell → that hour on /events (cheap), or drop scrubber dress-up.
6. Type-scale: map `text-[17px]/[12.5px]/[13.5px]` to `--text-*` tokens (mira#2).
7. `React.memo(TodayTimeline)` — kills 50-row re-render every 5 s poll (perf C2).
8. EventRow `hover:` parity with EventCard (landscape B1).
9. **"Alerts are off" chip** on Home when notification permission revoked, links to Settings→Alerts (frank I1).

### W2 — Nav + Events + shell (owns App.tsx, BottomNav.tsx, SideRail.tsx, Events.tsx, EventList.tsx, EventHeatmap.tsx, components/NavIcons.tsx)
1. **NAV-1**: remove `landscapeOnly` Review from BottomNav — portrait and landscape phone expose the same 4 destinations (hari top, codex#4). SideRail (desktop) keeps 5.
2. Extract shared `NavIcons.tsx` (kills the byte-identical duplicated glyphs).
3. **Scroll reset on route change** (hari FOCUS-1): `main.scrollTop = 0` on pathname change.
4. **Watch-shaped Suspense fallback** for `/` (perf C1): video-shaped skeleton instead of list.
5. Events: compact visible page header (codex#3, mira#3) using `.page-title` grammar; People title aligned same pass (W2 owns Events only; People handled by W3 to avoid overlap — see below).
6. **Events landscape-phone filter compaction** (device #7): TYPE+WHO in one row / tighter, so events are visible above the fold in landscape.
7. EventList `lg:mx-auto` double-centering fix (landscape D3); BottomNav landscape label 9px→10-11px (frank B3); heatmap count 9px→11px (frank B4).

### W3 — Controls, Settings, ClipModal, perf config (owns QualityMenu.tsx, VideoPlayer.tsx, DetectionSection.tsx, DangerZone.tsx, ClipModal.tsx, CatEmptyState.tsx, Login.tsx, People.tsx, vite.config.ts, index.html, drawBoxes.ts, index.css slider)
1. Touch targets: QualityMenu trigger ≥44px (portrait#1); VideoPlayer speed/repeat 36→44 (portrait#3, frank A3); DetectionSection class chips 36→44 (frank A2).
2. **ClipModal `landscape-phone:` two-pane reflow** (coherence MOBILE#1): video left, evidence right, mirroring Watch's grid.
3. Empty-state landscape scaling (device #9/#10): CatEmptyState shrinks illustration in short viewports so headline+CTA fit.
4. Settings theme row width cap in landscape (device #11).
5. Login `/live` → `/` (mira Login).
6. People page-title weight aligned to `.page-title` (mira#3).
7. Perf config: `manualChunks` vendor split (perf A1); drop Bricolage preload (perf F1); fix drawBoxes.ts comment token (perf A5); slider thumb `:hover` (landscape B2).

## Deliberately deferred (follow-up iters)
- Single `<Overlay>` primitive + swipe-down dismiss on all full-bleed surfaces (hari SHEET-1/GESTURE-3) — right fix, own iter.
- EventRow swipe-delete unification with EventCard (hari GESTURE-1).
- Swipe-between-clips in ClipModal (hari GESTURE-5).
- Real pull-to-refresh (copy fix ships now instead).
- Tweener landscape-tablet variant (landscape A3).
- Settings lazy-split heavy tabs (perf A2); DangerZone themed listbox (mira).
- Review demotion on desktop SideRail (kept 5 there deliberately — rotation invariance was the bug, cross-device difference is acceptable).
- `.focus-ring` adoption sweep; `font-display` letter-spacing debate (codex#9) — needs Israel's eye.

## Verification gate (all three)
vitest + typecheck + lint green; pinned tests updated in the same change (BottomNav/Watch/EventList copy pins WILL fire); BDD-lite for new tests; wire shapes untouched (no server changes anywhere in this set).
