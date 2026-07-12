import type { CatAnimFrame } from '../components/catAnimSequences'
import type { PlaygroundCatFrameName, PlaygroundCatId } from './playgroundAssets'

// Playground Slice A — declarative choreography for the playground-
// only bouts. Pure data, no React. Typed compatibly with
// catAnimSequences' CatAnimStep shape ({ frame, ms }) so the shared
// catEngineCore step-walkers (frameFromSteps et al) can consume these
// once the Slice B cat brain lands; the frame union simply widens to
// include the playground-only frames.
//
// Convention carried over from CAT_ANIM_SEQUENCES: the final 1ms step
// in a bout is its hold pose; callers clamp there instead of looping
// unless the bout explicitly repeats.

export type PlaygroundAnimFrame = PlaygroundCatFrameName | CatAnimFrame

export type PlaygroundAnimStep = Readonly<{
  frame: PlaygroundAnimFrame
  ms: number
}>

export const PLAYGROUND_SEQUENCES = {
  // Tween wave 2 (2026-07-11): every a↔b flank in the bouts below now
  // rides its generated *_ab midpoint (symmetric — the same in-between
  // serves both directions). Donor steps split in half; the final full
  // step keeps its original ms so each bout's TOTAL duration is exact.
  //
  // Toy-batting bout — two quick paw swipes, then settle back to the
  // shared seated hold (served from /cats/anim/, not the playground set).
  bat_bout: [
    { frame: 'bat_a', ms: 70 },
    { frame: 'bat_ab', ms: 70 },
    { frame: 'bat_b', ms: 60 },
    { frame: 'bat_ab', ms: 60 },
    { frame: 'bat_a', ms: 140 },
    { frame: 'seated', ms: 1 },
  ],
  // Food-bowl bout — three unhurried chew cycles, then the seated hold.
  eat_bout: [
    { frame: 'eat_a', ms: 175 },
    { frame: 'eat_ab', ms: 175 },
    { frame: 'eat_b', ms: 150 },
    { frame: 'eat_ab', ms: 150 },
    { frame: 'eat_a', ms: 175 },
    { frame: 'eat_ab', ms: 175 },
    { frame: 'eat_b', ms: 150 },
    { frame: 'eat_ab', ms: 150 },
    { frame: 'eat_a', ms: 175 },
    { frame: 'eat_ab', ms: 175 },
    { frame: 'eat_b', ms: 300 },
    { frame: 'seated', ms: 1 },
  ],
  // Contentment hold — a single purring frame; the 1ms hold-pose
  // convention makes it a clamp target, duration is the caller's call.
  purr_hold: [
    { frame: 'purr', ms: 1 },
  ],
  // Scratching-post bout — three deliberate full-arm strokes (slower
  // than the toy-bat flurry), then settle back to the seated hold.
  scratch_bout: [
    { frame: 'scratch_a', ms: 140 },
    { frame: 'scratch_ab', ms: 140 },
    { frame: 'scratch_b', ms: 120 },
    { frame: 'scratch_ab', ms: 120 },
    { frame: 'scratch_a', ms: 140 },
    { frame: 'scratch_ab', ms: 140 },
    { frame: 'scratch_b', ms: 120 },
    { frame: 'scratch_ab', ms: 120 },
    { frame: 'scratch_a', ms: 140 },
    { frame: 'scratch_ab', ms: 140 },
    { frame: 'scratch_b', ms: 240 },
    { frame: 'seated', ms: 1 },
  ],
  // drink_bout and climb are PER-CAT — see PLAYGROUND_PER_CAT_SEQUENCES
  // below (their tween midpoints only generated cleanly for some cats).
  // Draped side-lie hold for the hammock nap (breathe pulse rides the
  // render layer, same as sleep).
  hammock_hold: [
    { frame: 'hammock_lie', ms: 1 },
  ],
  // Back-view seated hold for the window perch — the turned back sells
  // "watching out the window"; tailflick micro-life interrupts it.
  window_hold: [
    { frame: 'window_watch', ms: 1 },
  ],
  // === Frames-30 wave 2c bout variants (2026-07-12) =========================
  // Each variant of an existing bout keeps that bout's slot shape and
  // EXACT total, so beat durations and arrival math never see the roll.
  //
  // High-stretch scratch — same 3-stroke cadence as scratch_bout
  // (1561ms), reaching to the top of the post. 160-tall canvases.
  scrhi_bout: [
    { frame: 'scrhi_a', ms: 140 },
    { frame: 'scrhi_ab', ms: 140 },
    { frame: 'scrhi_b', ms: 120 },
    { frame: 'scrhi_ab', ms: 120 },
    { frame: 'scrhi_a', ms: 140 },
    { frame: 'scrhi_ab', ms: 140 },
    { frame: 'scrhi_b', ms: 120 },
    { frame: 'scrhi_ab', ms: 120 },
    { frame: 'scrhi_a', ms: 140 },
    { frame: 'scrhi_ab', ms: 140 },
    { frame: 'scrhi_b', ms: 240 },
    { frame: 'seated', ms: 1 },
  ],
  // Left-paw / right-paw bat variants — the far-reach key rides the
  // contact slots of bat_bout's 401ms swipe pattern.
  bat_left: [
    { frame: 'batl_a', ms: 70 },
    { frame: 'bat_ab', ms: 70 },
    { frame: 'bat_b', ms: 60 },
    { frame: 'bat_ab', ms: 60 },
    { frame: 'batl_a', ms: 140 },
    { frame: 'seated', ms: 1 },
  ],
  bat_right: [
    { frame: 'batr_a', ms: 70 },
    { frame: 'bat_ab', ms: 70 },
    { frame: 'bat_b', ms: 60 },
    { frame: 'bat_ab', ms: 60 },
    { frame: 'batr_a', ms: 140 },
    { frame: 'seated', ms: 1 },
  ],
  // Head-lift eat variant — the middle chew cycle lifts the head
  // mid-meal (eatlift frames), same 1951ms total as eat_bout.
  eat_lift_bout: [
    { frame: 'eat_a', ms: 175 },
    { frame: 'eat_ab', ms: 175 },
    { frame: 'eat_b', ms: 150 },
    { frame: 'eat_ab', ms: 150 },
    { frame: 'eatlift_a', ms: 175 },
    { frame: 'eatlift_ab', ms: 175 },
    { frame: 'eatlift_b', ms: 150 },
    { frame: 'eatlift_ab', ms: 150 },
    { frame: 'eat_a', ms: 175 },
    { frame: 'eat_ab', ms: 175 },
    { frame: 'eat_b', ms: 300 },
    { frame: 'seated', ms: 1 },
  ],
  // Sniff-the-bowl prelude — plays as an ENTRY sequence before every
  // eat bout (700ms, no hold step; the bout follows immediately).
  sniff_prelude: [
    { frame: 'sniff_a', ms: 200 },
    { frame: 'sniff_ab', ms: 150 },
    { frame: 'sniff_b', ms: 250 },
    { frame: 'sniff_ab', ms: 100 },
  ],
  // Paw-dip drink variant (rare) — the cat dips a paw in the bowl and
  // licks it instead of lapping. Its own total (2951ms), pinned.
  drink_pawdip_bout: [
    { frame: 'pawdip_a', ms: 400 },
    { frame: 'pawdip_ab', ms: 250 },
    { frame: 'pawdip_b', ms: 700 },
    { frame: 'pawdip_ab', ms: 250 },
    { frame: 'pawdip_a', ms: 400 },
    { frame: 'pawdip_ab', ms: 250 },
    { frame: 'pawdip_b', ms: 700 },
    { frame: 'seated', ms: 1 },
  ],
} as const satisfies Record<string, readonly PlaygroundAnimStep[]>

export type PlaygroundSequenceName =
  | keyof typeof PLAYGROUND_SEQUENCES
  | keyof typeof PLAYGROUND_PER_CAT_SEQUENCES

// Tween wave 2 per-cat asymmetry (2026-07-11): the re-rolled midpoints
// for coco/drink_ab, mushu/climb_ab and panther/climb_ab came out
// deformed twice and were permanently dropped, so these two bouts are
// per-cat (same pattern as CAT_ANIM_SEQUENCES' blink / sleep_b2).
// Totals are identical across variants (drink 2241ms, climb 400ms per
// loop), so beat/bout math never sees the asymmetry.

// Water-bowl bout — four quick lapping cycles (tongue out / swallow),
// a touch faster than eating, then the seated hold. drink_ab midpoints
// on every flank; donor halves keep the 2241ms total exact.
const drinkTweened: readonly PlaygroundAnimStep[] = [
  { frame: 'drink_a', ms: 130 },
  { frame: 'drink_ab', ms: 130 },
  { frame: 'drink_b', ms: 150 },
  { frame: 'drink_ab', ms: 150 },
  { frame: 'drink_a', ms: 130 },
  { frame: 'drink_ab', ms: 130 },
  { frame: 'drink_b', ms: 150 },
  { frame: 'drink_ab', ms: 150 },
  { frame: 'drink_a', ms: 130 },
  { frame: 'drink_ab', ms: 130 },
  { frame: 'drink_b', ms: 150 },
  { frame: 'drink_ab', ms: 150 },
  { frame: 'drink_a', ms: 130 },
  { frame: 'drink_ab', ms: 130 },
  { frame: 'drink_b', ms: 300 },
  { frame: 'seated', ms: 1 },
]

// Coco has no drink_ab — she keeps the plain 2-frame lapping rhythm.
const drinkPlain: readonly PlaygroundAnimStep[] = [
  { frame: 'drink_a', ms: 260 },
  { frame: 'drink_b', ms: 300 },
  { frame: 'drink_a', ms: 260 },
  { frame: 'drink_b', ms: 300 },
  { frame: 'drink_a', ms: 260 },
  { frame: 'drink_b', ms: 300 },
  { frame: 'drink_a', ms: 260 },
  { frame: 'drink_b', ms: 300 },
  { frame: 'seated', ms: 1 },
]

// Vertical-cling travel loop — plays WHILE a cat lerps up/down a
// mount (tree / shelf / window / hammock), replacing the old
// jump_post pop. No hold step: the loop runs for exactly as long as
// the vertical travel does. Coco's is the classic 3-frame ping-pong
// (climb_ab reused on the return); Panther/Mushu keep the plain a/b
// loop. Both total 400ms per cycle.
const climbPingPong: readonly PlaygroundAnimStep[] = [
  { frame: 'climb_a', ms: 100 },
  { frame: 'climb_ab', ms: 100 },
  { frame: 'climb_b', ms: 100 },
  { frame: 'climb_ab', ms: 100 },
]

const climbPlain: readonly PlaygroundAnimStep[] = [
  { frame: 'climb_a', ms: 200 },
  { frame: 'climb_b', ms: 200 },
]

// Frames-30 wave 2c: look-up-from-the-bowl drink ending (25% roll) —
// two lap cycles, then the drip look-up. Per-cat because the lap
// rhythm is (coco has no drink_ab). Own totals, pinned.
const drinkLookupTweened: readonly PlaygroundAnimStep[] = [
  { frame: 'drink_a', ms: 130 },
  { frame: 'drink_ab', ms: 130 },
  { frame: 'drink_b', ms: 150 },
  { frame: 'drink_ab', ms: 150 },
  { frame: 'drink_a', ms: 130 },
  { frame: 'drink_ab', ms: 130 },
  { frame: 'drink_b', ms: 150 },
  { frame: 'drink_ab', ms: 150 },
  { frame: 'drinkup_a', ms: 350 },
  { frame: 'drinkup_b', ms: 450 },
  { frame: 'seated', ms: 1 },
]

const drinkLookupPlain: readonly PlaygroundAnimStep[] = [
  { frame: 'drink_a', ms: 260 },
  { frame: 'drink_b', ms: 300 },
  { frame: 'drink_a', ms: 260 },
  { frame: 'drink_b', ms: 300 },
  { frame: 'drinkup_a', ms: 350 },
  { frame: 'drinkup_b', ms: 450 },
  { frame: 'seated', ms: 1 },
]

export const PLAYGROUND_PER_CAT_SEQUENCES = {
  drink_bout: {
    panther: drinkTweened,
    mushu: drinkTweened,
    coco: drinkPlain,
  },
  drink_lookup_bout: {
    panther: drinkLookupTweened,
    mushu: drinkLookupTweened,
    coco: drinkLookupPlain,
  },
  climb: {
    panther: climbPlain,
    mushu: climbPlain,
    coco: climbPingPong,
  },
} as const satisfies Record<
  string,
  Readonly<Record<PlaygroundCatId, readonly PlaygroundAnimStep[]>>
>

/** Total run time of a playground bout. The shared sequenceDurationMs
    is typed over the base CatAnimFrame steps; this twin accepts the
    widened PlaygroundAnimFrame union so callers never cast. */
export function playgroundSequenceDurationMs(
  steps: readonly PlaygroundAnimStep[],
): number {
  return steps.reduce((total, step) => total + step.ms, 0)
}
