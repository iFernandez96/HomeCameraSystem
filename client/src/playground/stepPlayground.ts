import {
  CAT_ANIM_SEQUENCES,
  gaitVelocityPxPerMs,
  sequenceDurationMs,
  type CatAnimSequenceName,
} from '../components/catAnimSequences'
import { rollWeighted } from '../components/catEngineCore'
import { rollNextBeat, rollPairInteraction, type BeatContext } from './catBrain.beats'
import {
  SEATED_IDLE_PLAY_ACTIVITIES,
  playTransitionNamesFor,
  setPlayActivity,
  setPlayMood,
  type PlayCat,
  type PlaygroundState,
} from './playgroundState'
import {
  CAT_WIDTH_PX,
  anchorById,
  anchorCatX,
  anchorCatY,
  clampCatX,
  feederPerchPoint,
  laneFloorY,
} from './sceneModel'
import { stepToyLayer } from './toyLayer'
import type { VerbCatView } from './catBrain.verbs'
import type {
  AmbientEntity,
  PlaygroundInput,
  VerbStimulus,
} from './playgroundTypes'
import {
  PLAYGROUND_SEQUENCES,
  playgroundSequenceDurationMs,
} from './playgroundSequences'

// Playground Slice B — the single pure step function. Called once per
// rAF tick by PlaygroundScene. Order per the blueprint: step cats
// (travel / mount / at phases), step ambient critters, THEN call the
// toy layer seam (Slice C) and apply its VerbStimulus[] to the cats.
//
// STRICT bail-out discipline (CatLayer perf A2): every sub-step
// returns the SAME reference when nothing changed; when no cat, toy,
// or ambient entity changed, the ORIGINAL state object comes back so
// React's setState updater skips the re-render entirely.

export type StepOptions = {
  compact?: boolean
  random?: () => number
}

// Vertical travel rate (px/ms) for lane cross-fade + tier climbs. A
// constant rate (not an ease) keeps the step deterministic per dt.
const CLIMB_PX_PER_MS = 0.18
const ARRIVE_EPSILON_PX = 1.5
const INTERACTION_DISTANCE_PX = 50
const INTERACTION_COOLDOWN_MS = 5000
const AMBIENT_MIN_GAP_MS = 20000
const AMBIENT_MAX_GAP_MS = 45000
const BUTTERFLY_FLAP_MS = 160
const BIRD_HOP_MS = 420
const BIRD_VISIT_MS = 9000
const PET_HOLD_GRACE_MS = 600

const BAT_BOUT_MS = playgroundSequenceDurationMs(PLAYGROUND_SEQUENCES.bat_bout) * 3
const EAT_BOUT_MS = playgroundSequenceDurationMs(PLAYGROUND_SEQUENCES.eat_bout)

export function stepPlayground(
  state: PlaygroundState,
  input: PlaygroundInput,
  dt: number,
  now: number,
  sceneW: number,
  sceneH: number,
  opts: StepOptions = {},
): PlaygroundState {
  const random = opts.random ?? Math.random
  const compact = opts.compact ?? false
  const ctx: BeatContext = {
    cats: state.cats,
    ambient: state.ambient,
    sceneW,
    sceneH,
    compact,
    random,
  }

  // --- Pass 1: cats ----------------------------------------------------------
  let anyCatChanged = false
  let cats = state.cats.map((cat) => {
    const next = stepCat(cat, input, dt, now, ctx)
    if (next !== cat) anyCatChanged = true
    return next
  })

  // --- Pass 2: cat-cat interactions (floor tier only) ------------------------
  if (now - state.lastInteractionAt > INTERACTION_COOLDOWN_MS) {
    outer: for (let i = 0; i < cats.length; i++) {
      for (let j = i + 1; j < cats.length; j++) {
        const a = cats[i]
        const b = cats[j]
        if (!openToInteraction(a) || !openToInteraction(b)) continue
        if (a.lane !== b.lane) continue
        if (
          (a.lastInteractedWith === b.id && now - a.lastInteractedAt < INTERACTION_COOLDOWN_MS * 2) ||
          (b.lastInteractedWith === a.id && now - b.lastInteractedAt < INTERACTION_COOLDOWN_MS * 2)
        ) {
          continue
        }
        if (Math.abs(a.x - b.x) < INTERACTION_DISTANCE_PX) {
          const result = rollPairInteraction(a, b, now, sceneW, random)
          if (result) {
            if (cats === state.cats) cats = [...cats]
            cats[i] = result[0]
            cats[j] = result[1]
            anyCatChanged = true
            state = { ...state, lastInteractionAt: now }
            break outer
          }
        }
      }
    }
  }

  // --- Pass 3: ambient critters ----------------------------------------------
  const ambientResult = stepAmbient(
    state.ambient,
    state.ambientNextAt,
    state.ambientNextId,
    dt,
    now,
    sceneW,
    sceneH,
    random,
  )

  // --- Pass 4: toy layer seam (Slice C) + stimulus application ---------------
  // The ctx is REQUIRED for verbs to work at all (toyLayer runs toys
  // silently without it). It is also the ONE seam where the two
  // coordinate systems meet: cats live in bottom-offset y / left-edge
  // x, toys in top-origin y / center x — the view converts so the verb
  // brain's distance gates (BAT_RANGE_PX etc.) compare like with like.
  // Anchor focus reads as FREE to the verb brain: an anchor beat is the
  // cat's own idle plan, not a commitment — a cat lounging on the rug
  // must still be able to chase the laser (Mushu the first responder).
  // Toy/treat/pet/ambient focuses pass through as real commitments.
  const catViews: VerbCatView[] = cats.map((cat) => ({
    id: cat.id,
    x: cat.x + CAT_WIDTH_PX / 2,
    y: sceneH - cat.y,
    lane: cat.lane,
    focus: cat.focus !== null && cat.focus.type === 'anchor' ? null : cat.focus,
    asleep: cat.activity === 'sleep' || cat.activity === 'hammock',
  }))
  const toyResult = stepToyLayer(state.toys, input, dt, now, sceneW, sceneH, {
    cats: catViews,
    random,
  })
  if (toyResult.stimuli.length > 0) {
    const applied = applyVerbStimuli(cats, toyResult.stimuli, toyResult.toys, now, ctx)
    if (applied !== cats) {
      cats = applied
      anyCatChanged = true
    }
  }

  const nothingChanged =
    !anyCatChanged &&
    ambientResult.ambient === state.ambient &&
    ambientResult.nextAt === state.ambientNextAt &&
    toyResult.toys === state.toys
  if (nothingChanged) return state

  return {
    ...state,
    cats: anyCatChanged ? cats : state.cats,
    toys: toyResult.toys,
    ambient: ambientResult.ambient,
    ambientNextAt: ambientResult.nextAt,
    ambientNextId: ambientResult.nextId,
  }
}

function openToInteraction(cat: PlayCat): boolean {
  if (cat.focus?.type === 'pet' || cat.focus?.type === 'toy' || cat.focus?.type === 'treat') return false
  if (cat.activity !== 'walk' && cat.activity !== 'sit') return false
  // Only free-roaming floor cats mingle; anchored/en-route cats commit
  // to their beat.
  return cat.targetAnchor === null && (cat.anchorId === null || anchorById(cat.anchorId).tier === 'floor')
}

// === Per-cat step ============================================================

function stepCat(
  cat: PlayCat,
  input: PlaygroundInput,
  dt: number,
  now: number,
  ctx: BeatContext,
): PlayCat {
  let {
    x,
    y,
    direction,
    mood,
    moodSecondary,
    idleSequence,
    idleSequenceStartedAt,
    nextIdleLifeAt,
    lastIdleLifeWasSpecial,
  } = cat
  const { activity } = cat
  let changed = false

  // Mood expiry
  if (mood && now > cat.moodUntil) {
    mood = null
    moodSecondary = null
    changed = true
  }

  // Petting hold: while the finger stays down on this cat, the purr
  // never expires (petting preempts everything; release lets the
  // short grace window run out naturally).
  let activityUntil = cat.activityUntil
  if (activity === 'purr' && input.petTarget === cat.id) {
    const extended = now + PET_HOLD_GRACE_MS
    if (extended > activityUntil) {
      activityUntil = extended
      changed = true
    }
  }

  // --- Travel phase -----------------------------------------------------------
  const gaitReady = activity === 'walk' || activity === 'run' || activity === 'chase' || activity === 'flee'
  let arrivedFinal = false
  let arrivedWaypoint = false
  if (gaitReady) {
    const dest = travelDestination(cat, ctx)
    if (dest) {
      const gait = activity === 'walk' ? 'walk' : 'run'
      const step = gaitVelocityPxPerMs(gait, CAT_WIDTH_PX) * dt
      const dx = dest.x - x
      if (Math.abs(dx) <= step) {
        x = dest.x
      } else {
        x += Math.sign(dx) * step
        direction = dx > 0 ? 'R' : 'L'
      }
      // Lane cross-fade / tier climb: y moves at a constant rate.
      const climb = CLIMB_PX_PER_MS * dt
      const dy = dest.y - y
      if (Math.abs(dy) <= climb) {
        y = dest.y
      } else {
        y += Math.sign(dy) * climb
      }
      if (Math.abs(dest.x - x) < ARRIVE_EPSILON_PX && Math.abs(dest.y - y) < ARRIVE_EPSILON_PX) {
        if (cat.targetAnchor && cat.route.length > 1) arrivedWaypoint = true
        else arrivedFinal = true
      }
      changed = true
    } else if (activity === 'flee' || activity === 'chase') {
      // Un-targeted sprint (ported interaction outcomes): straight run.
      const step = gaitVelocityPxPerMs('run', CAT_WIDTH_PX) * dt
      x += direction === 'R' ? step : -step
      changed = true
    }
  } else if (activity === 'play') {
    x += direction === 'R' ? 0.012 * dt : -0.012 * dt
    changed = true
  }

  // Wall clamps
  const clampedX = clampCatX(x, ctx.sceneW)
  if (clampedX !== x) {
    x = clampedX
    direction = direction === 'L' ? 'R' : 'L'
  }

  // --- Mount phase: waypoint hop-through --------------------------------------
  if (arrivedWaypoint) {
    return {
      ...cat,
      x,
      y,
      direction,
      mood,
      moodSecondary,
      route: cat.route.slice(1),
      targetAnchor: cat.route[1] ?? null,
      phaseTime: now,
    }
  }

  // --- At phase: final arrival — start the beat's activity --------------------
  if (arrivedFinal && cat.targetAnchor && cat.arrival) {
    const anchor = anchorById(cat.targetAnchor)
    const arrived = setPlayActivity(cat, cat.arrival.activity, cat.arrival.durationMs, now, ctx.random)
    return {
      ...arrived,
      x,
      y,
      direction,
      mood,
      moodSecondary,
      lane: anchor.lane,
      anchorId: cat.targetAnchor,
      targetAnchor: null,
      route: [],
      arrival: null,
      targetX: null,
      targetY: null,
    }
  }
  if (arrivedFinal && cat.targetX !== null) {
    // Point travel (wander / ambient pursuit / toy chase).
    const arrival = cat.arrival ?? { activity: 'sit' as const, durationMs: 4000 }
    const arrived = setPlayActivity(cat, arrival.activity, arrival.durationMs, now, ctx.random)
    return {
      ...arrived,
      x,
      y,
      direction,
      mood,
      moodSecondary,
      targetX: null,
      targetY: null,
      arrival: null,
      // Toy focus survives arrival (Slice C keeps steering); ambient
      // focus survives into the pounce and clears when it misses.
    }
  }

  // --- Seated-idle sub-system (ported from CatLayer) ---------------------------
  if (SEATED_IDLE_PLAY_ACTIVITIES.has(activity)) {
    const birdLive = ctx.ambient.some((a) => a.kind === 'bird')
    const watchingBird = activity === 'watch' && birdLive
    if (idleSequence) {
      const duration = sequenceDurationMs(CAT_ANIM_SEQUENCES[idleSequence][cat.id])
      if (now - idleSequenceStartedAt >= duration) {
        idleSequence = null
        nextIdleLifeAt = now + nextIdleGap(watchingBird, ctx.random)
        changed = true
      }
    } else if (now >= nextIdleLifeAt) {
      if (watchingBird) {
        // Bird chatter: fast tailflicks, no blink filler.
        idleSequence = 'tailflick'
        lastIdleLifeWasSpecial = true
      } else if (lastIdleLifeWasSpecial) {
        idleSequence = cat.id === 'coco' ? null : 'blink'
        lastIdleLifeWasSpecial = false
      } else {
        idleSequence = pickSeatedIdle(cat.id)
        lastIdleLifeWasSpecial = idleSequence !== 'blink'
      }
      idleSequenceStartedAt = now
      nextIdleLifeAt = now + nextIdleGap(watchingBird, ctx.random)
      changed = true
    }
  } else if (idleSequence) {
    idleSequence = null
    changed = true
  }

  // --- phaseTime: advance only while a sprite timeline runs -------------------
  const transitionNames = playTransitionNamesFor(cat.previousActivity, activity)
  const transitionDuration = transitionNames.reduce(
    (total, name) => total + sequenceDurationMs(CAT_ANIM_SEQUENCES[name]?.[cat.id] ?? []),
    0,
  )
  const timelineActive =
    now - cat.activityStartedAt < transitionDuration ||
    hasOngoingSequence(activity) ||
    idleSequence !== null
  const phaseTime = timelineActive ? now : cat.phaseTime
  if (phaseTime !== cat.phaseTime) changed = true

  // --- Beat expiry -------------------------------------------------------------
  if (now > activityUntil && !gaitReady) {
    const base: PlayCat = {
      ...cat,
      x,
      y,
      direction,
      mood,
      moodSecondary,
      activityUntil,
      phaseTime,
      idleSequence,
      idleSequenceStartedAt,
      nextIdleLifeAt,
      lastIdleLifeWasSpecial,
    }
    return expireBeat(base, now, ctx)
  }
  // Travel cap: a cat stuck walking too long re-rolls (self-heal).
  if (now > activityUntil && gaitReady) {
    const base: PlayCat = {
      ...cat, x, y, direction, mood, moodSecondary, activityUntil, phaseTime,
      targetAnchor: null, route: [], arrival: null, targetX: null, targetY: null, focus: null,
      idleSequence, idleSequenceStartedAt, nextIdleLifeAt, lastIdleLifeWasSpecial,
    }
    return rollNextBeat(base, now, ctx)
  }

  if (!changed) return cat
  return {
    ...cat,
    x,
    y,
    direction,
    mood,
    moodSecondary,
    activityUntil,
    phaseTime,
    idleSequence,
    idleSequenceStartedAt,
    nextIdleLifeAt,
    lastIdleLifeWasSpecial,
  }
}

function travelDestination(
  cat: PlayCat,
  ctx: BeatContext,
): { x: number; y: number } | null {
  if (cat.targetAnchor) {
    return {
      x: anchorCatX(cat.targetAnchor, ctx.sceneW),
      y: anchorCatY(cat.targetAnchor, ctx.sceneH),
    }
  }
  if (cat.targetX !== null) {
    return { x: cat.targetX, y: cat.targetY ?? cat.y }
  }
  return null
}

function hasOngoingSequence(activity: PlayCat['activity']): boolean {
  switch (activity) {
    case 'walk':
    case 'run':
    case 'chase':
    case 'flee':
    case 'groom':
    case 'play':
    case 'pounce':
    case 'pooped':
    case 'scratch':
    case 'bat':
    case 'eat':
      return true
    default:
      return false
  }
}

function nextIdleGap(watchingBird: boolean, random: () => number): number {
  // Bird chatter runs the tail at ~2× cadence.
  return watchingBird ? 900 + random() * 1300 : 3000 + random() * 4000
}

const SEATED_IDLE_CHOICES: Record<PlayCat['id'], readonly { name: CatAnimSequenceName; weight: number }[]> = {
  panther: [
    { name: 'blink', weight: 12 },
    { name: 'tailflick', weight: 4 },
    { name: 'groom_bout', weight: 2 },
    { name: 'yawn', weight: 1 },
  ],
  mushu: [
    { name: 'blink', weight: 12 },
    { name: 'tailflick', weight: 4 },
    { name: 'groom_bout', weight: 3 },
    { name: 'yawn', weight: 1 },
  ],
  coco: [
    { name: 'tailflick', weight: 8 },
    { name: 'groom_bout', weight: 3 },
    { name: 'yawn', weight: 1 },
  ],
}

function pickSeatedIdle(catId: PlayCat['id']): CatAnimSequenceName {
  const choices = SEATED_IDLE_CHOICES[catId]
  return rollWeighted(choices, (c) => c.weight)?.name ?? choices[choices.length - 1].name
}

function expireBeat(cat: PlayCat, now: number, ctx: BeatContext): PlayCat {
  // Tunnel dive re-emerges: pop out of the mouth with a stretch, THEN
  // the next beat rolls (discovery beat — the rustle pays off).
  if (cat.activity === 'tunnel') {
    const emerged = setPlayActivity(cat, 'stretch', 1100, now, ctx.random)
    return setPlayMood(emerged, '✨', 1600, now)
  }
  // Ambient pursuit always misses — shake it off, then move on.
  if (cat.activity === 'pounce' && cat.focus?.type === 'ambient') {
    const missed = setPlayActivity(cat, 'sit', 2500, now, ctx.random)
    return setPlayMood({ ...missed, focus: null }, '😹', 1800, now, '💨')
  }
  // Petting released: the purr winds down into a contented sit.
  if (cat.activity === 'purr') {
    const done = setPlayActivity(cat, 'sit', 3000, now, ctx.random)
    return { ...done, focus: null, petStartedAt: null }
  }
  // A toy focus is PARKED, never expired: Panther sitting on the laser
  // dot (and any cat mid-engagement) holds its spot in a sit until the
  // verb brain emits 'release' — the engine must not abandon a toy on
  // its own (Slice C integration contract).
  if (cat.focus?.type === 'toy') {
    const parked = setPlayActivity(cat, 'sit', 4000, now, ctx.random)
    return { ...parked, targetX: null, targetY: null, arrival: null }
  }
  const cleared: PlayCat =
    cat.focus?.type === 'treat' || cat.focus?.type === 'ambient' || cat.focus?.type === 'pet'
      ? { ...cat, focus: null, petStartedAt: null }
      : cat
  return rollNextBeat(cleared, now, ctx)
}

// === Ambient critters ========================================================

type AmbientStep = {
  ambient: AmbientEntity[]
  nextAt: number
  nextId: number
}

function stepAmbient(
  ambient: AmbientEntity[],
  nextAt: number,
  nextId: number,
  dt: number,
  now: number,
  sceneW: number,
  sceneH: number,
  random: () => number,
): AmbientStep {
  if (ambient.length > 0) {
    const critter = ambient[0]
    const t = critter.t + dt
    if (critter.kind === 'butterfly') {
      // Looping drift across the scene: advance x, bob on a sine.
      const x = critter.x + 0.045 * dt
      if (x > sceneW + 24) {
        return { ambient: [], nextAt, nextId }
      }
      const y = laneFloorY('back', sceneH) + 0.22 * sceneH + Math.sin(t / 420) * 0.06 * sceneH
      const frame: 'a' | 'b' = Math.floor(t / BUTTERFLY_FLAP_MS) % 2 === 0 ? 'a' : 'b'
      return {
        ambient: [{ ...critter, x, y, t, frame }],
        nextAt,
        nextId,
      }
    }
    // Bird: sits on the feeder hopping occasionally, then flies off.
    if (t > BIRD_VISIT_MS) {
      return { ambient: [], nextAt, nextId }
    }
    const frame: 'a' | 'b' = Math.floor(t / BIRD_HOP_MS) % 2 === 0 ? 'a' : 'b'
    if (frame !== critter.frame || t !== critter.t) {
      return { ambient: [{ ...critter, t, frame }], nextAt, nextId }
    }
    return { ambient, nextAt, nextId }
  }
  // Spawn window: every 20–45 s, max 1 live critter.
  if (now >= nextAt) {
    const isBird = random() < 0.5
    const perch = feederPerchPoint(sceneW, sceneH)
    const spawned: AmbientEntity = isBird
      ? { kind: 'bird', id: nextId, x: perch.x, y: perch.y, t: 0, frame: 'a' }
      : {
          kind: 'butterfly',
          id: nextId,
          x: -24,
          y: laneFloorY('back', sceneH) + 0.22 * sceneH,
          t: 0,
          frame: 'a',
        }
    return {
      ambient: [spawned],
      nextAt: now + AMBIENT_MIN_GAP_MS + random() * (AMBIENT_MAX_GAP_MS - AMBIENT_MIN_GAP_MS),
      nextId: nextId + 1,
    }
  }
  return { ambient, nextAt, nextId }
}

// === Verb stimulus application (Slice C proposes, Slice B applies) ===========

export function applyVerbStimuli(
  cats: PlayCat[],
  stimuli: readonly VerbStimulus[],
  toys: PlaygroundState['toys'],
  now: number,
  ctx: BeatContext,
): PlayCat[] {
  if (stimuli.length === 0) return cats
  let out = cats
  const replace = (index: number, next: PlayCat) => {
    if (out === cats) out = [...cats]
    out[index] = next
  }
  for (const stim of stimuli) {
    const index = out.findIndex((c) => c.id === stim.catId)
    if (index < 0) continue
    const cat = out[index]
    // Petting preempts everything: a held cat ignores toy stimuli.
    if (cat.focus?.type === 'pet' && stim.request.type !== 'purr' && stim.request.type !== 'release') {
      continue
    }
    const next = applyOneStimulus(cat, stim, toys, now, ctx)
    if (next !== cat) replace(index, next)
  }
  return out
}

function applyOneStimulus(
  cat: PlayCat,
  stim: VerbStimulus,
  toys: PlaygroundState['toys'],
  now: number,
  ctx: BeatContext,
): PlayCat {
  const req = stim.request
  switch (req.type) {
    case 'chase': {
      const gaitActivity = req.gait === 'run' ? 'run' : 'walk'
      const next = setPlayActivity(cat, gaitActivity, 6000, now, ctx.random)
      return {
        ...next,
        targetAnchor: null,
        route: [],
        anchorId: null,
        // Toy targets arrive in toy space (center x / top-origin y);
        // ground the cat on the target lane's floor under the toy —
        // cats run along floors, never levitate to a mid-air dot.
        targetX: clampCatX(req.targetX - CAT_WIDTH_PX / 2, ctx.sceneW),
        targetY: laneFloorY(req.lane, ctx.sceneH),
        lane: req.lane,
        arrival: null,
        // CONTRACT FRICTION: the chase request carries no toy identity,
        // so infer it from the live toy state (laser wins, then wand,
        // then yarn).
        focus: {
          type: 'toy',
          toy: toys.laser.on ? 'laser' : toys.wand.held ? 'wand' : 'yarn',
        },
      }
    }
    case 'bat': {
      const next = setPlayActivity(cat, 'bat', BAT_BOUT_MS, now, ctx.random)
      return { ...next, targetX: null, targetY: null, arrival: null }
    }
    case 'eat': {
      const treat = toys.treats.find((t) => t.id === req.treatId)
      if (!treat) return cat
      const next = setPlayActivity(cat, 'walk', 60000, now, ctx.random)
      return {
        ...next,
        activityUntil: now + 60000,
        targetAnchor: null,
        route: [],
        anchorId: null,
        targetX: clampCatX(treat.x - CAT_WIDTH_PX / 2, ctx.sceneW),
        targetY: laneFloorY(treat.lane, ctx.sceneH),
        lane: treat.lane,
        arrival: { activity: 'eat', durationMs: EAT_BOUT_MS },
        focus: { type: 'treat', treatId: req.treatId },
      }
    }
    case 'purr': {
      const next = setPlayActivity(cat, 'purr', PET_HOLD_GRACE_MS, now, ctx.random)
      return setPlayMood(
        {
          ...next,
          petStartedAt: cat.petStartedAt ?? now,
          focus: { type: 'pet' },
          targetAnchor: null,
          route: [],
          arrival: null,
          targetX: null,
          targetY: null,
        },
        '😻',
        2400,
        now,
        '💕',
      )
    }
    case 'grump': {
      // Tolerance ran out: grumpy mood + walk-off away from the touch.
      const next = setPlayActivity(cat, 'walk', 60000, now, ctx.random)
      const away = cat.direction === 'L' ? cat.x - 140 : cat.x + 140
      return setPlayMood(
        {
          ...next,
          activityUntil: now + 60000,
          focus: null,
          petStartedAt: null,
          targetAnchor: null,
          route: [],
          anchorId: null,
          targetX: clampCatX(away, ctx.sceneW),
          targetY: laneFloorY(cat.lane, ctx.sceneH),
          arrival: { activity: 'sit', durationMs: 5000 },
        },
        '😾',
        2200,
        now,
        '💢',
      )
    }
    case 'release': {
      if (cat.focus === null) return cat
      // Wind the bout down shortly; the beat brain takes back over.
      return {
        ...cat,
        focus: null,
        petStartedAt: null,
        activityUntil: Math.min(cat.activityUntil, now + 400),
        targetX: null,
        targetY: null,
        arrival: null,
      }
    }
  }
}
