# Swipe-between-clips in ClipModal (hari GESTURE-5)

Deferred item from SYNTHESIS.md, implemented 2026-07-07.

## What shipped

A horizontal swipe on the ClipModal VIDEO PANE flips to the previous/next
event from the already-fetched "More from tonight" sibling window. No new
data fetching; the advance goes through the exact `setEvent` swap a rail-row
tap uses, so focus management, pending/loading states, the evidence pane and
the bbox-overlay wiring all behave identically to the existing mechanism.

Files touched (ownership respected, nothing else modified):

- `client/src/components/ClipModal.tsx`
- `client/src/components/ClipModal.test.tsx`

## Chosen direction (documented per task)

The "More from tonight" rail lists siblings newest-first (the
`/api/events/search` order). The swipe timeline sorts `[...moreTonight,
activeEvent]` descending by `ts` to match that visual order, so:

- **Swipe LEFT = next row DOWN the list = the next OLDER event.**
- **Swipe RIGHT = back UP the list = the NEWER event.**

The content follows the finger toward the row you would tap next, so the
motion reads as flipping through the same list shown below the video.

## Mechanics

- **Axis lock**: same `touchAxis` ref discipline as `EventList.tsx`
  (axis decided once per gesture at the first >6px move; a vertical
  start can never become a swipe). All gesture state lives in refs.
- **Drag feedback**: imperative `style.transform = translateX(...)` on the
  pane ref, zero per-move React state. Capped at 48px when a neighbor
  exists (`SWIPE_FEEDBACK_MAX_PX`).
- **Threshold**: 70px of raw finger travel (`SWIPE_ADVANCE_PX`) advances on
  release; below it the pane snaps back (160ms ease-out transition).
- **Reduced motion**: `prefers-reduced-motion: reduce` (checked via
  `matchMedia`, jsdom-safe guard) skips the snap transition; the pane jumps
  straight back.
- **Ends of the window**: no neighbor in that direction means rubber-band
  only: 1/3 drag resistance capped at 20px (`SWIPE_RUBBER_MAX_PX`), then
  snap back. No wrap-around.
- **Controls unaffected**: a touch beginning on any interactive element
  (`closest('button, select, input, a, label')`, which covers the bbox
  toggle and the speed/Repeat strip) never arms the gesture. The bottom
  64px of the pane is also excluded (`SWIPE_CONTROLS_GUARD_PX`) so drags on
  the native `<video controls>` scrubber keep seeking; the guard is skipped
  when the pane has no layout box (jsdom). `touch-pan-y` on the pane keeps
  native vertical scrolling alive.
- **touchcancel**: resets refs and snaps back, never advances.

## Tests (all fireEvent.touchStart/touchMove/touchEnd, BDD-lite + AAA)

New `describe('swipe between clips (GESTURE-5)')` block, 9 tests:

1. Swipe left past threshold advances to the older sibling (video src swaps).
2. Swipe right past threshold goes back to the newer sibling.
3. Below-threshold drag shows tracked feedback then snaps back, no change.
4. Long drag feedback clamps at 48px.
5. Vertically-started gesture stays a scroll even after later horizontal travel.
6. At the newest end, swipe right rubber-bands (resisted, 20px cap) and stays.
7. Touch starting on the bbox toggle button never becomes a swipe.
8. Reduced motion: snap-back applies no transition.
9. Motion allowed: snap-back uses a transform ease-out transition.

## Verification

- `npm test -- src/components/ClipModal.test.tsx`: 68/68 pass (59 existing + 9 new).
- `npm run typecheck`: clean.
- `npm run lint`: clean.
