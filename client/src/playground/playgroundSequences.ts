import type { CatAnimFrame } from '../components/catAnimSequences'
import type { PlaygroundCatFrameName } from './playgroundAssets'

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
  // Toy-batting bout — two quick paw swipes, then settle back to the
  // shared seated hold (served from /cats/anim/, not the playground set).
  bat_bout: [
    { frame: 'bat_a', ms: 140 },
    { frame: 'bat_b', ms: 120 },
    { frame: 'bat_a', ms: 140 },
    { frame: 'seated', ms: 1 },
  ],
  // Food-bowl bout — three unhurried chew cycles, then the seated hold.
  eat_bout: [
    { frame: 'eat_a', ms: 350 },
    { frame: 'eat_b', ms: 300 },
    { frame: 'eat_a', ms: 350 },
    { frame: 'eat_b', ms: 300 },
    { frame: 'eat_a', ms: 350 },
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
    { frame: 'scratch_a', ms: 280 },
    { frame: 'scratch_b', ms: 240 },
    { frame: 'scratch_a', ms: 280 },
    { frame: 'scratch_b', ms: 240 },
    { frame: 'scratch_a', ms: 280 },
    { frame: 'scratch_b', ms: 240 },
    { frame: 'seated', ms: 1 },
  ],
  // Water-bowl bout — four quick lapping cycles (tongue out / swallow),
  // a touch faster than eating, then the seated hold.
  drink_bout: [
    { frame: 'drink_a', ms: 260 },
    { frame: 'drink_b', ms: 300 },
    { frame: 'drink_a', ms: 260 },
    { frame: 'drink_b', ms: 300 },
    { frame: 'drink_a', ms: 260 },
    { frame: 'drink_b', ms: 300 },
    { frame: 'drink_a', ms: 260 },
    { frame: 'drink_b', ms: 300 },
    { frame: 'seated', ms: 1 },
  ],
  // Vertical-cling travel loop — plays WHILE a cat lerps up/down a
  // mount (tree / shelf / window / hammock), replacing the old
  // jump_post pop. No hold step: the loop runs for exactly as long as
  // the vertical travel does.
  climb: [
    { frame: 'climb_a', ms: 200 },
    { frame: 'climb_b', ms: 200 },
  ],
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
} as const satisfies Record<string, readonly PlaygroundAnimStep[]>

export type PlaygroundSequenceName = keyof typeof PLAYGROUND_SEQUENCES

/** Total run time of a playground bout. The shared sequenceDurationMs
    is typed over the base CatAnimFrame steps; this twin accepts the
    widened PlaygroundAnimFrame union so callers never cast. */
export function playgroundSequenceDurationMs(
  steps: readonly PlaygroundAnimStep[],
): number {
  return steps.reduce((total, step) => total + step.ms, 0)
}
