# Client Perceived-Performance Audit — HomeCam PWA

Date: 2026-07-07
Scope: `client/src` — layout shift, mount cost, animation frame cost, image/thumb handling, bundle/route-split, listener leaks, live-page re-render storms, orientation jank.
Device model assumed: 3-year-old Android, cellular over Tailscale, low battery, backgrounded tab. Every byte and frame counts.
Build measured: `npm run build` (Vite 7). Numbers below are from that run.

Legend: A=bundle, B=route-split, C=layout-shift, D=animation, E=listener/leak, F=network.

---

## TOP 5 HIGHEST-IMPACT FINDINGS

1. **[C1] Home route cold-start shows a LIST skeleton, then snaps to a VIDEO hero.** `App.tsx:70-78` `PageFallback` renders `<LoadingState shape="list" />` for every lazy route including `/` (Watch). Watch's resolved layout is a 16:9 video pinned on top + timeline below — not a list. On the primary cold entry the user watches a list-shaped skeleton get replaced by a video block = a full-screen re-layout flash on the single most-viewed screen. Fix: give Watch a dedicated `shape="video"` fallback (route-specific Suspense boundary or a `Watch.skeleton`), mirroring the video/aspect-box the tile occupies. Est. removes one full hero re-layout on every cold home load.

2. **[A1] No vendor chunk split — 90 KB gzip shell re-downloads on every deploy.** `index-*.js` = **289.73 KB raw / 90.09 KB gzip**, bundling react + react-dom + react-router-dom together with all shell code (App, providers, ConnectionBanner, SideRail, WatchRibbon, BottomNav). There is no `build.rollupOptions.output.manualChunks`. React + ReactDOM + Router (~45-50 KB gzip, byte-identical between deploys) share a content hash with app code, so every deploy busts the whole 90 KB blob. Fix: `manualChunks: { vendor: ['react','react-dom','react-router-dom'] }`. Repeat visits after a deploy then re-fetch only changed app code; ~45-50 KB gzip stays cached. Also shrinks the critical-path parse the shell blocks on.

3. **[C2/live re-render] Status poll (5 s) re-renders the entire Today timeline + all EventRows.** `Watch.tsx:137-249` — `useStatus()` (5 s), `useTicker()` (30 s), `useSentryCat()` (60 s) and `videoPlaying` all live in `Watch`, which renders `TodayTimeline` inline (`Watch.tsx:532`). `TodayTimeline`, `EventRow` (`EventRow.tsx` — no `memo`) and `VideoTile` (no `memo`) are all un-memoized, so each 5 s status tick re-runs the render of up to 50 `EventRow`s (`limit: 50`, `Watch.tsx:92`) plus VideoTile's full body — for data that did not change (the `events` array ref is stable between refetches). Fix: wrap `TodayTimeline` in `React.memo` (its props — `events`, `quietSince`, `error`, `nowMs`, `onOpen` — are ref-stable across status ticks). Est. eliminates ~50 component re-renders every 5 s while the home screen is open.

4. **[F1] Both variable fonts preloaded eagerly on the critical path (~115 KB) over cellular.** `index.html:86-87` preloads `inter-variable-latin.woff2` AND `bricolage-variable-latin.woff2` with equal priority. Bricolage is the display face (headings only — `page-title`, `font-display`), not first-paint body text. Two high-priority font fetches race the 90 KB JS on a cold cellular open. Fix: keep the Inter preload, drop the Bricolage `<link rel=preload>` and let it load via `font-display: swap` (headings briefly render in the fallback, then swap). Defers ~50-60 KB off the first-paint critical path with no body-text FOUT.

5. **[A2] `Settings` chunk = 81.15 KB raw / 21.48 KB gzip because all 8 tab sections load to show one.** `Settings.tsx:5-12` eagerly imports AccountSection, AppearanceSection, DangerZone, DebugSection, DetectionSection (bundles ZoneEditor), JetsonSection (637 lines), NotificationsSection (649 lines), TimelapsesSection — but only one tab is visible at a time. Fix: `lazy()` the three heavy tab bodies (Detection/ZoneEditor, Jetson, Notifications) behind the tab selection. Route is rare so this is lower-urgency than 1-4, but it is the single largest per-page payload after the shell.

---

## A — Bundle

- **[A1] Vendor not split** — see Top-5 #2. Add `manualChunks`. Highest cache-efficiency win.
- **[A2] Settings loads all tabs** — see Top-5 #5.
- **[A3] CSS is one 78.60 KB / 14.36 KB gzip sheet loaded on every route** including Login. 14 KB gzip is acceptable for Tailwind v4; not worth splitting. No action, noted for completeness.
- **[A4] Precache is healthy.** `sw.js` precache = **29 entries / 713.89 KiB** — well under the 2 MB cellular-install pain threshold. Cat PNG sprites are correctly excluded from precache (`vite.config.ts:96-98` `globIgnores`) and served CacheFirst at runtime. woff2 deliberately precached (~115 KB) for offline. No action.
- **[A5-hygiene] Malformed Tailwind token emits a junk CSS rule.** The build logs `Unexpected token Delim('.')` for a generated `.bg-[var(...)]` rule; the scanner is picking up the literal `` `var(...)` `` string in a `.ts` comment (`drawBoxes.ts:12`). Harmless but it ships a dead rule + a build warning. Reword the comment (e.g. `var(…)` unicode ellipsis, or drop the backticked token) to silence it.

## B — Route-splitting

- **[B1] Route-splitting is done well.** `App.tsx:26-50` lazy-loads Watch, Events, Login, People, Settings, Training, Review; each emits its own chunk (Watch 10.89 / Events 10.79 / People 3.12 / Training 5.77 / Review 2.06 / Login 2.50 KB gzip). No non-Live route is eagerly pulled into the shell. No action.
- **[B2] CatLayer is fully unmounted — the animation-budget concern is moot at runtime.** `App.tsx:334-340` documents that the ambient `CatLayer` is UNMOUNTED; grep confirms nothing imports/renders it (only its own tests + a lazy reference in `__viewport__` that is "never reached"). Its per-frame rAF cost, `dt` clamp, `willChange`, etc. are all dead code paths today. The sprite art (`CatIcons`, `CatParticles`) is still used by empty states, so those stay. If CatLayer is never revived, consider deleting it to stop paying its maintenance + test cost; if revived, re-audit D.

## C — Layout shift / mount cost

- **[C1] Home fallback shape mismatch** — see Top-5 #1. The worst perceived-jank item.
- **[C2] Live re-render storm from status poll** — see Top-5 #3.
- **[C3] Watch video box reserves space correctly.** `Watch.tsx:343` docks the tile in a fixed `aspect-video max-h-[48dvh]` box and VideoTile paints black immediately (`VideoTile.tsx:643`), so no CLS when the stream resolves. Good.
- **[C4] Glance/timeline text-swaps are non-shifting.** `todayCount`/`todayBreakdown` swap "Loading…" → values in fixed-height cards (`Watch.tsx:505-528`); the timeline `<ol>` is the last section so its growth pushes nothing. Fine.
- **[C5] `VideoTile` is not memoized and `actions` is a fresh element per render.** `Watch.tsx:386-409` builds the `actions` JSX inline every render, so even if VideoTile were wrapped in `memo` it would still re-render every 5 s. Re-render is cheap (refs stable, no reconnect — connect effect deps are `[effectiveSrc, retryNonce]`, canvas effect deps are the stable `EMPTY_BOXES`/boxes), so this is a lower-severity companion to C2: memoizing TodayTimeline captures most of the win; a full VideoTile memo would additionally need `actions` hoisted/`useMemo`'d.

## D — Animation / motion

- **[D1] CatLayer (`CatLayer.tsx`) does not run** (see B2). For the record its loop is well-built: `dt` clamped to 33 ms (`:647`), `transform: translateX` composited off-thread with `willChange: 'transform'` (`:914-923`), no CSS transition on the per-frame transform, `setCats` bails to the prior array ref when nothing changed (`:1255`), and `React.memo(CatRender)` short-circuits (`:873`). Nothing to fix — it just isn't mounted.
- **[D2] ClipModal per-frame bbox draw is bounded and self-stopping.** `ClipModal.tsx:499-566` uses `requestVideoFrameCallback` (reschedules only after a presented frame → naturally stops when the tab is backgrounded, since a hidden tab presents no frames), with a Firefox `requestAnimationFrame` fallback that returns early on `paused`/`ended` (`:532-539`). rVFC is deferred to the `play` event, not kicked eagerly (`:550-555`). Cleanup cancels both handles. Good.
- **[D3] `StatusPill` correctly reserves `animate-pulse` for connecting/error only** (`VideoTile.tsx:956-961`) — the live pill uses a solid dot, avoiding a permanent compositor layer on the first thing the user sees. Good.

## E — Listeners / leaks

- **[E1] All visibility listeners unsubscribe.** `useStatus.ts:90-96`, `Watch.tsx:118-125` (useTodayEvents), and `VideoTile.tsx:502-508` each pair `addEventListener('visibilitychange', …)` with a matching `removeEventListener` in cleanup. ConnectionBanner (per CLAUDE.md) is the third; its `setTimeout`s are cleared (`ConnectionBanner.tsx:103,146,164`). No leak.
- **[E2] Status polling pauses in background.** `useStatus.ts:77-89` stops the interval and aborts the in-flight request on `visibilitychange → hidden`, resumes with an immediate fetch on visible. Correct for the low-battery/backgrounded scenario.
- **[E3] No WS auto-retry on close-1008.** `ws.ts:74-93` dispatches `homecam:auth-failed` and returns without scheduling a reconnect; normal closes back off exponentially (`:96-108`) and `maybeShutdown` clears the timer when the last listener leaves. Matches the CLAUDE.md sharp edge. No leak.
- **[E4] All `setInterval`/`setTimeout` are cleared.** Audited: `useTicker.ts:14`, `useStatus.ts:68`, `ClipModal.tsx:141`, `sentryCat.ts:98`, `VideoTile.tsx:180/304/353`, `CatParticles.tsx:157`, `toast.tsx:95`, `ZoneEditor.tsx:92`, `webrtc.ts:410`, `ripple.ts:92` — each has a paired clear in its effect cleanup or callback. No orphaned timers found.
- **[E5] ClipModal ticks a 5 s clock while open** (`ClipModal.tsx:141`, `setNowMs` every 5 s) — a re-render every 5 s for a relative-time label. Modal is transient and single-instance, so low impact; noted only for symmetry with C2.

## F — Network / images

- **[F1] Drop the Bricolage font preload** — see Top-5 #4.
- **[F2] Thumbnails already lazy-load.** `EventList.tsx:32` (`loading="lazy"`), `People.tsx:424`, `Training.tsx:762`, `Review.tsx:258` all set `loading="lazy"`; sprite `CatIcons` mixes eager (first-paint mascots) + lazy (below-fold) appropriately; `WhoMark` avatars are `loading="eager"` (tiny, above-fold — fine). `decoding="async"` is set on the sprite/avatar images. No action.
- **[F3] Preconnect to the WHEP origin is NOT needed — it is same-origin by design.** `streamQuality.ts:88` builds the WHEP URL as `${window.location.origin}/whep/…`; MediaMTX is reached through the Tailscale-Serve same-origin path proxy (`vite.config.ts:197-201`). The TLS/TCP socket to that origin is already warm from loading the document, so a `<link rel=preconnect>` would be a no-op. The item 15 premise (separate mediamtx origin, ~80-120 ms TLS to save) does not apply here. No action — noted so it isn't "fixed" by adding a useless hint.
- **[F4] `index.html` per-route modulepreload is punted (documented).** `index.html:88-98` — the Watch chunk is already requested as soon as the shell mounts (home is `/`), so a modulepreload would save at most one round trip. Low priority; if implemented, pair it with the C1 skeleton fix so the preloaded chunk lands on a correctly-shaped fallback.

---

## Suggested execution order

1. C1 — Watch video-shaped Suspense fallback (biggest perceived-jank fix, small diff).
2. A1 — `manualChunks` vendor split (biggest byte/cache win, ~5-line config).
3. C2 — `React.memo(TodayTimeline)` (kills the 5 s 50-row re-render, small diff).
4. F1 — drop Bricolage preload (~50-60 KB off critical path, 1-line HTML).
5. A2 — lazy-split the three heavy Settings tabs (larger diff, rarer route).
6. A5 — silence the malformed Tailwind token (hygiene).
