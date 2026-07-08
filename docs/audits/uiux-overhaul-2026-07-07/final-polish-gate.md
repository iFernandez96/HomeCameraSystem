# Final Polish Gate — UI/UX overhaul 2026-07-07

Reviewer: Mira (final professional-bar gate)
Scope: c8546ce^..HEAD + working tree, `client/src`.
Method: source read on a 390px mental viewport, thumb-arc + state-clarity + interaction-collision passes. 250/250 vitest green across the seven touched suites.
Bar: Playroom Modern's own grammar, and "would Ring/Nest ship this".

Commits in range:
- df96015 multicam switcher/filter/registry names
- ea2ea7c multicam server/worker/store dimension
- 9575903 push notification tap opens exact clip
- 067fde9 swipe-between-clips in ClipModal
- 4302d87 fullscreen "acts like a camera app"
- cc3384a overlay drift + one silent reconnect
- 3f928cf one overlay baseline + quality menu unclip
- fb64950 frame-gated Live pill + connecting shimmer
- 26a80c2 / f6d6492 / 181f578 nav/events/perf follow-ups

---

## 1. Fullscreen live-view contract (Watch.tsx) — PASS

**What works**
- Real fullscreen is done right: `requestFullscreen({navigationUI:'hide'})` + `orientation.lock('landscape')` fired *inside* the tap's transient activation (Watch.tsx:389-419), with the fixed-inset CSS overlay as the honest iOS-Safari fallback. This is the exact shape a native camera app uses.
- Back-gesture arbitration is correct and single-consumption: `pushState` on enter, every exit funnels through `history.back()`, popstate flips `full` and resets chrome + zoom (Watch.tsx:421-439). The reload-loses-state edge is acknowledged and harmless.
- `fullscreenchange` reconciliation (Watch.tsx:448-466) keeps React honest when the browser exits on its own, and releases the orientation lock in cleanup. Wake lock re-acquires on visibility resume (472-500). Body scroll locks; ESC exits.
- Chrome auto-hide (3.5s, Watch.tsx:247-254) is timer-in-handler, never set-state-in-effect. `visibility:hidden` rides in after the 300ms fade so hidden chrome can't eat taps (530-537) — the correct fix, not `pointer-events:none` alone.
- The gesture arbiter (558-705) is genuinely good: 2 fingers = pinch, 1 finger zoomed = pan, 1 finger at scale 1 downward = swipe-dismiss, motionless = tap. Axis locks once at 12px. Pinch/pan/swipe all write transforms imperatively — no per-move React render (CatLayer rule honored). pinchZoom.ts is pure, clamped so panning never reveals black edges, unit-tested.
- Landscape `cover` vs portrait `contain` fit decision (Fuzz F4, 844-851) is reasoned from a real device, not guessed.

**What still falls short (non-blocking)**
- Sub-threshold swipe-down snaps back with NO animation: `clearSwipeTransform()` clears `transform` + `transition` on release (573-578, 697-699), so a 90px pull that doesn't dismiss jumps home instantly. ClipModal's sibling gesture eases back over 160ms (`snapPaneBack`). Two swipe systems, two release feels — the exact cross-feature incoherence this gate is meant to catch. Ring rubber-bands. Minor, but it's the one place fullscreen feels unfinished.
- During a fullscreen cold-connect the user sees the shimmer + the armed pill ("On watch · Front Door") but no stream-state word, because `showStatusPill={!full}` hides VideoTile's "Connecting" pill and the fullscreen pill shows detection-armed state, not stream truth. The shimmer carries it, so acceptable — but the armed pill reading "On watch" over a black connecting frame is a hair dishonest.

Verdict: PASS. Ship it. File the snap-back easing as fast-follow.

---

## 2. Frame-gated Live pill + connecting shimmer (VideoTile.tsx) — PASS

**What works**
- This is the standout fix of the batch. `'live'` now requires a real frame signal — `playing`/`loadeddata`/`requestVideoFrameCallback` (VideoTile.tsx:358-395) — not ICE-connected. The old ~4s of "Live" over pure black is gone. The 8s media-timeout fallback (408-415) means a signaling-succeeds-but-ICE-dead session lands on a Retry, not a frozen "connecting" forever.
- The connecting shimmer (741-748) reads as deliberate: white-alpha pulse + spinner, `motion-reduce:animate-none`, removed from the DOM the instant frames flow. White-alpha is safe because the video field is always black.
- One silent reconnect per live episode (445-452), re-armed only by real frames — bounded, visible-tab-gated, no tight loop on a dead server. Correct.
- StatusPill vocabulary ("Live"/"Connecting"/"Offline") is deliberately kept SEPARATE from watchState's armed vocabulary, and the code says why (stream-truth vs detection-truth). This is the right call — collapsing them would reintroduce the status-truth contradiction.

**What still falls short**
- Nothing blocking. The pill precedence ladder (streamStale > workerDead > lowMem > therm > paused) is coherent and each pill has a glyph + dot + plain-English copy.

Verdict: PASS.

---

## 3. Unified bottom overlay row (VideoTile.tsx) — PASS

**What works**
- Single-owner flex row (778-889) kills the three-`right-N`-magic-number collision where Watch and VideoTile both absolutely-positioned over the same corner. `justify-between` puts the quality menu left, action cluster right, on ONE baseline in docked AND fullscreen.
- `safeAreaBottom` opt-in (781-783) is the correct fix for the Firefox-Android "buttons drift up on resume" report — the inset only applies when the tile bottom IS the viewport bottom.
- Every control is a 44px circle now (Snapshot demoted from a wide text pill to an icon circle, Watch.tsx:890-908; the exit chevron bumped w-9→w-11, 941-945). Uniform `w-11 h-11 rounded-full` grammar throughout. Consistency test: pass.

Verdict: PASS.

---

## 4. Swipe-between-clips (ClipModal.tsx) — PASS

**What works**
- Axis lock once at 6px (ClipModal.tsx:399-403); a vertical scroll-start can never become a horizontal swipe mid-gesture. Refs + imperative transform, zero per-move renders.
- Control-safety is thorough: touch that starts on `button/select/input/a/label` is never a swipe (375-376), AND the bottom 64px (native-scrubber strip) is guarded (384-386). `touch-pan-y` keeps vertical scroll alive.
- Rubber-band at window ends (no neighbor → 1/3 resistance, 20px cap, snaps back), real-neighbor → 48px follow + advance at 70px. Eased snap-back with reduced-motion respect (423-433).
- Advance reuses the EXACT `setEvent` path a "More from tonight" row tap uses (447-449) — so focus, pending/loading, bbox-wiring all behave identically. No parallel code path. This is the right way to build it.

**What still falls short (non-blocking)**
- The swipe timeline is only `[...moreTonight(≤5), event]` (347-351). You can swipe through at most ~6 events; a busy evening with 10 siblings caps you at 5 in each direction with no signal that more exist beyond the rail. Acceptable for a review affordance, but it's a silent ceiling.
- Axis arbitration vs Watch's swipe-down: these live on DIFFERENT surfaces (ClipModal horizontal-only + vertical-scroll; Watch fullscreen vertical-dismiss), so there is NO direct collision. The only shared-feel gap is the snap-back easing asymmetry noted in §1.

Verdict: PASS.

---

## 5. Notification deep-link flow (sw.ts + Events.tsx) — PASS

**What works**
- `notificationClickTarget` (sw.ts:123-133) is a pure, exported, tested helper. Guards the generic `'event'` test-push tag so it can't masquerade as a real id. Correctly appends `?event=` or `&event=` based on existing query.
- `notificationclick` compares pathname+search (not just pathname, sw.ts:190-196) so an already-open /events window still navigates to the deep-linked clip instead of skipping. This is the subtle bug most implementers miss; it's handled.
- Events.tsx auto-open (diff: `_deepLinkEventIdRef`): id snapshotted once into a ref so chip toggles / WS arrivals can't re-trigger; param stripped via `replaceState` BEFORE open so back/refresh don't re-fire; set-state deferred out of the effect body (React 19 discipline).

**What still falls short**
- There is no fetch-by-id route, so the open only works if the event is in the already-loaded list; a paginated-out or pruned event gets a plain-English `info` toast. For a *notification* (always recent, always in the newest-first first page) this is fine in practice. But the failure copy — "That event is not in the recent list. It may have been removed." — will occasionally lie: the event isn't removed, it's just below the initial 100. Honest-enough, low frequency. Not a blocker.

Verdict: PASS.

---

## 6. Multicam switcher / filter (Watch.tsx + Events.tsx) — PASS

**What works**
- INVISIBLE-with-one-camera acceptance bar is met on every surface I traced:
  - Watch switcher gated on `multiCam = (cameras?.length ?? 0) > 1` (Watch.tsx:236, 774).
  - Events camera chip band gated on `cameras.length > 1` (Events.tsx diff, `multiCam`).
  - `registerCameraNames` self-gates to the >1 case, so single-camera event-row + ClipModal header copy stays byte-identical.
  - `streamPath` defaults to `DEFAULT_CAMERA_PATH` → WHEP URL byte-identical for single-cam.
  - Selected camera label falls back to `status.camera_label` for single-cam (297-299).
- Registry fetch failure degrades to single-camera layout on both pages (logged WHY). Stored camera id that no longer exists falls back to first camera (152-154).
- CameraSwitcher uses the same radiogroup + roving-tabindex + 44px + ink-fill grammar as the Events filter chips (1402-1457). Consistency: pass. Camera is correctly placed as the coarsest filter axis (WHERE) above TYPE and WHO.

**What still falls short (non-blocking)**
- Fullscreen has no camera switcher — the switcher lives only in the docked header. A multicam user in immersive fullscreen can see "· Back Door" in the pill but cannot switch without exiting fullscreen. Ring/Nest let you cycle cameras in fullscreen. This is a genuine gap for multicam, but multicam is not yet deployed hardware, and single-camera (the shipping config) is unaffected. Flag for the multicam hardware milestone, not this ship.
- Camera-filter is client-side-narrow + server `camera=` param on paginate — the loaded pool is filtered instantly but "Load more" re-queries with the param. Coherent with the existing labelFilter split.

Verdict: PASS.

---

## Cross-feature incoherence scan

1. **swipe-down-dismiss (Watch) vs swipe-between-clips (ClipModal):** no axis collision — different surfaces, different axes. The ONLY shared-system gap is release-animation asymmetry (Watch snaps instant, ClipModal eases 160ms). Fix by giving Watch's sub-threshold swipe-down the same eased snap-back.
2. **camera switcher vs fullscreen chrome:** no collision — switcher is docked-only. The gap is *absence* (can't switch in fullscreen), not conflict.
3. **watchState vocabulary unification:** genuine win. WatchRibbon, Watch glance card, and Watch fullscreen pill now all resolve through `lib/watchState.ts` (same label + dot + text-color maps). VideoTile's stream pill stays deliberately separate and documents why. No surface says two different words for one state anymore.
4. **deep-link ?event= vs swipe setEvent vs "More from tonight" tap:** all three funnel through the same `setEvent`/`selectedEvent` open path. No parallel invalidation. Delete reuses the single existing refetch key. Clean.

---

## Overall verdict: PASS — ship it.

This is a finished, distinctive batch, not SaaS-default-with-cat-decals. The frame-gated Live pill and the fullscreen contract are the kind of details Ring/Nest actually get right and most clones don't. The multicam work clears the invisible-with-one-camera bar cleanly, and the state-vocabulary unification removes a real "three words for one truth" defect. Nothing here is a ship-blocker.

Two fast-follows (neither blocks):
1. `client/src/pages/Watch.tsx:697-699` — sub-threshold swipe-down snaps back with no animation while ClipModal's swipe eases 160ms — give the viewport the same eased transform-reset so the two gesture systems feel like one.
2. Multicam-milestone only: no in-fullscreen camera switch, and the deep-link "may have been removed" toast can misdescribe a merely-paginated-out event.

---

## One question the implementer must answer before shipping

**In fullscreen, when the WHEP session is still connecting (black frame + shimmer), the combined pill reads "On watch · Front Door" — the detection-armed state, not the stream state. Have you watched a real cold-mount fullscreen entry on a cellular phone, and is a user genuinely reassured by "On watch" printed over a black box for up to 8 seconds, or does the shimmer need to own a "Connecting…" word of its own in fullscreen the way the docked tile's pill does?**

This is the seam most likely to have been reasoned-about-but-not-device-verified: the docked mode got a real "Connecting" pill; fullscreen deliberately dropped it to avoid a third redundant "Live" — but "avoid redundancy" quietly cost fullscreen its only honest stream-state word during the exact window (first-frame gap on cellular) where the user is most anxious that it's broken.
