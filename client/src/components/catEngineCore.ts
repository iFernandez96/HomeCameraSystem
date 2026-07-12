import {
  sequenceDurationMs,
  type CatAnimFrame,
  type CatAnimId,
  type CatAnimSequenceName,
  type CatAnimStep,
} from './catAnimSequences'

// Playground Slice A: the pose/plan/roll machinery extracted from
// CatLayer.tsx so the Playground page can drive the same sprite
// engine with its OWN activity maps. Everything here is pure and
// activity-agnostic: CatLayer keeps thin wrappers bound to its own
// Activity union + maps, and CatLayer.test.tsx pins that the
// extraction changed nothing.

export type PoseGroup = 'walking' | 'seated' | 'sleeping' | 'crouched' | 'standing'

export const POSE_TRANSITIONS: Record<PoseGroup, Record<PoseGroup, readonly CatAnimSequenceName[]>> = {
  walking: {
    walking: [],
    seated: ['walk_to_front', 'stand_to_seated'],
    sleeping: ['walk_to_front', 'stand_to_seated', 'sleep_down'],
    crouched: ['walk_to_front', 'stand_to_seated', 'crouch_down'],
    standing: ['walk_to_front'],
  },
  seated: {
    walking: ['seated_to_stand', 'front_to_walk'],
    seated: [],
    sleeping: ['sleep_down'],
    crouched: ['crouch_down'],
    standing: ['seated_to_stand'],
  },
  sleeping: {
    walking: ['wake_up', 'seated_to_stand', 'front_to_walk'],
    seated: ['wake_up'],
    sleeping: [],
    crouched: ['wake_up', 'crouch_down'],
    standing: ['wake_up', 'seated_to_stand'],
  },
  crouched: {
    walking: ['crouch_up', 'seated_to_stand', 'front_to_walk'],
    seated: ['crouch_up'],
    sleeping: ['crouch_up', 'sleep_down'],
    crouched: [],
    standing: ['crouch_up', 'seated_to_stand'],
  },
  standing: {
    walking: ['front_to_walk'],
    seated: ['stand_to_seated'],
    sleeping: ['stand_to_seated', 'sleep_down'],
    crouched: ['stand_to_seated', 'crouch_down'],
    standing: [],
  },
}

/** The per-cat choreography table shape (CAT_ANIM_SEQUENCES matches it). */
export type SequenceTable = Readonly<
  Record<CatAnimSequenceName, Readonly<Record<CatAnimId, readonly CatAnimStep[]>>>
>

export type AnimationPlan = {
  frame: CatAnimFrame | null
  framesToPreload: readonly CatAnimFrame[]
  walkFrame: number | undefined
}

export function frameFromSteps(
  steps: readonly { frame: CatAnimFrame; ms: number }[],
  elapsedMs: number,
  loop: boolean,
): CatAnimFrame {
  const duration = sequenceDurationMs(steps)
  let cursor = loop ? elapsedMs % duration : Math.min(elapsedMs, duration - 1)
  for (const step of steps) {
    if (cursor < step.ms) return step.frame
    cursor -= step.ms
  }
  return steps[steps.length - 1].frame
}

export function transitionFrame(
  sequences: SequenceTable,
  catId: CatAnimId,
  sequenceNames: readonly CatAnimSequenceName[],
  elapsedMs: number,
): CatAnimFrame | null {
  let cursor = elapsedMs
  for (const name of sequenceNames) {
    const steps = sequences[name][catId]
    const duration = sequenceDurationMs(steps)
    if (cursor < duration) return frameFromSteps(steps, cursor, false)
    cursor -= duration
  }
  return null
}

export function uniqueFrames(
  sequences: SequenceTable,
  catId: CatAnimId,
  sequenceNames: readonly CatAnimSequenceName[],
): CatAnimFrame[] {
  return Array.from(new Set(
    sequenceNames.flatMap((name) => sequences[name][catId].map((step) => step.frame)),
  ))
}

/** What the plan builder needs to know about an actor — a structural
    subset of CatLayer's CatState so any sprite-driving surface can
    supply one. */
export type AnimActor<A extends string> = {
  id: CatAnimId
  activity: A
  previousActivity: A
  activityStartedAt: number
  idleSequence: CatAnimSequenceName | null
  idleSequenceStartedAt: number
}

/** The per-surface activity wiring: which sequences bridge a pose
    change, which loop while an activity runs, and which single frame
    holds otherwise. CatLayer binds its Activity maps; Playground will
    bind its own. */
export type AnimActivityMaps<A extends string> = {
  transitionNamesFor: (from: A, to: A) => readonly CatAnimSequenceName[]
  ongoingSequenceByActivity: Partial<Record<A, CatAnimSequenceName>>
  holdFrameByActivity: Partial<Record<A, CatAnimFrame>>
  sequences: SequenceTable
}

export function animationPlanFor<A extends string>(
  actor: AnimActor<A>,
  now: number,
  maps: AnimActivityMaps<A>,
): AnimationPlan {
  const { transitionNamesFor, ongoingSequenceByActivity, holdFrameByActivity, sequences } = maps
  const transitionNames = transitionNamesFor(actor.previousActivity, actor.activity)
  const elapsed = Math.max(0, now - actor.activityStartedAt)
  const transitioningFrame = transitionFrame(sequences, actor.id, transitionNames, elapsed)
  const ongoingName = ongoingSequenceByActivity[actor.activity]
  const idleName = actor.idleSequence
  const sequenceNames = [
    ...transitionNames,
    ...(ongoingName ? [ongoingName] : []),
    ...(idleName ? [idleName] : []),
  ]
  const framesToPreload = uniqueFrames(sequences, actor.id, sequenceNames)

  if (transitioningFrame) {
    return { frame: transitioningFrame, framesToPreload, walkFrame: undefined }
  }

  const transitionDuration = transitionNames.reduce(
    (total, name) => total + sequenceDurationMs(sequences[name][actor.id]),
    0,
  )
  if (idleName) {
    const steps = sequences[idleName][actor.id]
    if (steps.length > 0) {
      return {
        frame: frameFromSteps(steps, Math.max(0, now - actor.idleSequenceStartedAt), false),
        framesToPreload,
        walkFrame: undefined,
      }
    }
  }
  if (ongoingName) {
    const steps = sequences[ongoingName][actor.id]
    const frame = frameFromSteps(steps, Math.max(0, elapsed - transitionDuration), true)
    const walkFrame = ongoingName === 'walk'
      ? Number(frame.slice('walk_'.length)) - 1
      : undefined
    return { frame, framesToPreload, walkFrame }
  }
  const holdFrame = holdFrameByActivity[actor.activity]
  return {
    frame: holdFrame ?? null,
    framesToPreload: holdFrame ? [holdFrame] : framesToPreload,
    walkFrame: undefined,
  }
}

// === Turn-around pivot =======================================================

/** A direction reversal in flight. `from` renders for the first half of
    the pivot sequence, `to` for the second — the switch lands inside the
    centered symmetric `stand` frame, so the instant mirror flip has no
    visible seam. Replaces the 220ms CSS scaleX morph for walking flips
    (user 2026-07-11: "cats turn around soo slowly"). */
export type TurnPivot = {
  startedAt: number
  from: 'L' | 'R'
  to: 'L' | 'R'
}

export type TurnPivotView = {
  frame: CatAnimFrame
  facing: 'L' | 'R'
  done: boolean
}

export function turnPivotView(
  steps: readonly CatAnimStep[],
  pivot: TurnPivot,
  now: number,
): TurnPivotView {
  const elapsed = Math.max(0, now - pivot.startedAt)
  const duration = sequenceDurationMs(steps)
  return {
    frame: frameFromSteps(steps, elapsed, false),
    facing: elapsed < duration / 2 ? pivot.from : pivot.to,
    done: elapsed >= duration,
  }
}

// === Randomness helpers ======================================================

export function rand(min: number, max: number) {
  return Math.random() * (max - min) + min
}

/** Weighted roll shared by CatLayer's interaction/solo/idle pools.
    Consumes exactly ONE Math.random() call (tests pin rolls by
    mocking Math.random). Returns null on an empty pool or a
    floating-point fall-through — callers pick their own fallback. */
export function rollWeighted<T>(
  pool: readonly T[],
  weightOf: (item: T) => number,
): T | null {
  const totalWeight = pool.reduce((s, item) => s + weightOf(item), 0)
  let roll = Math.random() * totalWeight
  for (const item of pool) {
    roll -= weightOf(item)
    if (roll <= 0) return item
  }
  return null
}

// Anti-repeat wrapper (user feedback 2026-07-11 "contrived and repeating"):
// weighted random happily rolls the same state twice in a row, which is
// the #1 thing that reads as robotic. Standard fix in idle-animation
// systems ("shuffle bag" family): if the roll lands on the activity the
// cat JUST finished, re-roll once. A second collision is accepted — real
// cats do occasionally resume the same thing, and a hard exclusion would
// skew the personality weights.
export function rollWithoutImmediateRepeat<C extends { activity: string }>(
  roller: (c: C, now: number, w: number) => C,
  c: C,
  now: number,
  w: number,
): C {
  const first = roller(c, now, w)
  if (first === c || first.activity !== c.activity) return first
  const second = roller(c, now, w)
  return second === c || second.activity === c.activity ? first : second
}
