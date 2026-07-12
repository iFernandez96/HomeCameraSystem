import {
  CAT_ANIM_SEQUENCES,
  gaitVelocityPxPerMs,
  sequenceDurationMs,
  type CatAnimSequenceName,
} from '../components/catAnimSequences'
import { rollWeighted, turnPivotView } from '../components/catEngineCore'
import {
  forceDismountStroll,
  rollNextBeat,
  rollPairInteraction,
  type BeatContext,
} from './catBrain.beats'
import {
  SEATED_IDLE_PLAY_ACTIVITIES,
  perchDwellDeadlineFor,
  playTransitionDurationMs,
  playTransitionNamesFor,
  setPlayActivity,
  setPlayMood,
  turnPivotSteps,
  type PlayCat,
  type PlaygroundState,
  PLAYGROUND_SEQUENCE_TABLE,
} from './playgroundState'
import {
  CAT_WIDTH_PX,
  anchorById,
  anchorCatX,
  anchorCatY,
  clampCatX,
  feederPerchPoint,
  isElevatedAnchor,
  laneFloorY,
  packedSpotFor,
} from './sceneModel'
import { groundPoopExpired, spawnGroundPoop } from '../components/GroundPoop'
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
/** Gait ease-in: ~250ms from standstill to full stride. */
const GAIT_RAMP_MS = 250
/** Gait ease-out: stride tapers inside this many px of the target. */
const ARRIVE_EASE_PX = 56
/** Floor of the ease factors so travel always converges. */
const GAIT_EASE_MIN = 0.2
/** Depth cross-fade time for a lane switch (render scale, never a pop). */
const LANE_FADE_MS = 450
const INTERACTION_DISTANCE_PX = 50
export const INTERACTION_MIN_GAP_PX = 24
const INTERACTION_COOLDOWN_MS = 5000
const AMBIENT_MIN_GAP_MS = 20000
const AMBIENT_MAX_GAP_MS = 45000
const BUTTERFLY_FLAP_MS = 160
const BIRD_HOP_MS = 420
const BIRD_VISIT_MS = 9000
const PET_HOLD_GRACE_MS = 600
/** Below this much remaining vertical distance a climb leg reads as
    done — the gait returns to walk frames for the horizontal tail. */
const CLIMB_ANIM_EPS_PX = 4

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
    now,
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
        // Trigger window [24px, 50px): close enough to interact, far
        // enough apart that grounding the pair in place reads as two
        // cats side by side. Cats have no collision and can pass
        // through each other — without the lower bound a pair could
        // freeze a 4s snuggle fully SUPERPOSED (10Hz live audit
        // 2026-07-11 caught Mushu and Coco 2px apart).
        const pairGap = Math.abs(a.x - b.x)
        if (pairGap >= INTERACTION_MIN_GAP_PX && pairGap < INTERACTION_DISTANCE_PX) {
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
    compact,
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

  // Ground poop lifecycle: leaves state once its visible window + fade
  // have fully played out (the fade itself is CSS — no re-render needed
  // between spawn and removal).
  let poop = cat.poop
  if (poop && groundPoopExpired(poop, now)) {
    poop = null
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
  // Climb rendering (interaction wave 2026-07-11): while a mount or
  // dismount leg still has vertical distance, the render layer swaps
  // the walk gait for the climb_a/b cling loop.
  let climbing = false
  // Frames-30 wave 4: a climb leg's direction + start time drive the
  // one-shot mount/dismount arc before the cling loop.
  let climbDir = cat.climbDir
  let climbStartedAt = cat.climbStartedAt
  // Turn-around pivot lifecycle (2026-07-11): a completed pivot clears
  // and the frozen travel resumes toward the same destination this
  // very tick; an in-flight one plants the paws below.
  let turn = cat.turn
  if (turn && turnPivotView(turnPivotSteps(cat), turn, now).done) {
    turn = null
    changed = true
  }
  // A reversal pivots only once the gait is ESTABLISHED (past its
  // ease-in): the facing-establishment tick of a fresh travel is the
  // get-up chain's turn to cover, not a mid-stride whip-around. Never
  // while clinging to a climb — the pivot frames are standing poses.
  const strideEstablished =
    now - Math.max(cat.activityStartedAt, cat.moveRampAt) > GAIT_RAMP_MS && !cat.climbing
  if (gaitReady) {
    const dest = travelDestination(cat, ctx)
    if (dest) {
      const dx = dest.x - x
      // Look before you go: face the destination immediately; paws wait
      // for moveRampAt (the get-up chain + a jittered regard hold).
      if (Math.abs(dx) > ARRIVE_EPSILON_PX) {
        const facing: 'L' | 'R' = dx > 0 ? 'R' : 'L'
        if (facing !== direction) {
          // An IN-MOTION reversal pivots in place (plant → whip around
          // → resume) instead of mirror-morphing mid-stride. A cat
          // still waiting on moveRampAt (or just launching) keeps the
          // instant re-face — its get-up chain covers the turn.
          if (turn === null && strideEstablished) {
            turn = { startedAt: now, from: direction, to: facing }
          }
          direction = facing
          changed = true
        }
      }
      if (now >= cat.moveRampAt && turn === null) {
        const gait = activity === 'walk' ? 'walk' : 'run'
        // Ease in from standstill over ~250ms; ease out inside the
        // arrival zone. Never 0-to-full-stride in one frame.
        const easeIn = Math.min(1, (now - cat.moveRampAt) / GAIT_RAMP_MS)
        const arrive = Math.min(1, Math.abs(dx) / ARRIVE_EASE_PX)
        const ease = Math.max(GAIT_EASE_MIN, Math.min(easeIn, arrive))
        const step = gaitVelocityPxPerMs(gait, CAT_WIDTH_PX) * dt * ease
        if (Math.abs(dx) <= step) {
          x = dest.x
        } else {
          x += Math.sign(dx) * step
        }
        // Lane cross-fade / tier climb: y moves at a constant rate.
        const climb = CLIMB_PX_PER_MS * dt
        const dy = dest.y - y
        if (Math.abs(dy) <= climb) {
          y = dest.y
        } else {
          y += Math.sign(dy) * climb
        }
        climbing = cat.climbTravel && Math.abs(dest.y - y) > CLIMB_ANIM_EPS_PX
        if (climbing && !cat.climbing) {
          // Frames-30 wave 4: the one-shot mount/dismount arc only arms on
          // legs long enough to fit the arc AND a full cling cycle — short
          // hops keep the plain cling loop (and the pinned a/b alternation).
          const legMs = Math.abs(dest.y - y) / CLIMB_PX_PER_MS
          climbDir = legMs >= 900 ? (dest.y < y ? 'up' : 'down') : null
          climbStartedAt = now
        }
        if (Math.abs(dest.x - x) < ARRIVE_EPSILON_PX && Math.abs(dest.y - y) < ARRIVE_EPSILON_PX) {
          if (cat.targetAnchor && cat.route.length > 1) arrivedWaypoint = true
          else arrivedFinal = true
        }
        changed = true
      }
    } else if (activity === 'flee' || activity === 'chase') {
      // Un-targeted sprint (ported interaction outcomes): straight run,
      // once the get-up chain has played.
      if (now >= cat.moveRampAt && turn === null) {
        const easeIn = Math.max(GAIT_EASE_MIN, Math.min(1, (now - cat.moveRampAt) / GAIT_RAMP_MS))
        const step = gaitVelocityPxPerMs('run', CAT_WIDTH_PX) * dt * easeIn
        x += direction === 'R' ? step : -step
        changed = true
      }
    }
  } else if (activity === 'play') {
    x += direction === 'R' ? 0.012 * dt : -0.012 * dt
    changed = true
  }

  // Wall clamps — an in-motion bounce whips through the pivot too.
  const clampedX = clampCatX(x, ctx.sceneW)
  if (clampedX !== x) {
    x = clampedX
    const bounced: 'L' | 'R' = direction === 'L' ? 'R' : 'L'
    if (turn === null && gaitReady && strideEstablished) {
      turn = { startedAt: now, from: direction, to: bounced }
    }
    direction = bounced
  }
  if (turn !== cat.turn) changed = true

  // --- Depth cross-fade: rendered scale chases the logical lane ---------------
  let laneBlend = cat.laneBlend
  const laneTarget = cat.lane === 'back' ? 1 : 0
  if (laneBlend !== laneTarget) {
    const move = dt / LANE_FADE_MS
    laneBlend =
      laneTarget > laneBlend
        ? Math.min(laneTarget, laneBlend + move)
        : Math.max(laneTarget, laneBlend - move)
    changed = true
  }

  // --- Mount phase: waypoint hop-through --------------------------------------
  if (arrivedWaypoint) {
    return {
      ...cat,
      x,
      y,
      laneBlend,
      direction,
      mood,
      moodSecondary,
      poop,
      climbing,
      climbDir,
      climbStartedAt,
      turn,
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
      laneBlend,
      direction,
      mood,
      moodSecondary,
      poop,
      lane: anchor.lane,
      anchorId: cat.targetAnchor,
      // Fresh anchor acquisition: restart the continuous-stay clock and
      // roll this stay's jittered dwell deadline (RESIDUAL B).
      anchorSince: now,
      perchDwellDeadline: perchDwellDeadlineFor(now, ctx.random),
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
      laneBlend,
      direction,
      mood,
      moodSecondary,
      poop,
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
      const steps = CAT_ANIM_SEQUENCES[idleSequence]?.[cat.id]
        ?? PLAYGROUND_SEQUENCE_TABLE[idleSequence][cat.id]
      const duration = sequenceDurationMs(steps)
      if (now - idleSequenceStartedAt >= duration) {
        idleSequence = null
        nextIdleLifeAt = now + nextIdleGap(watchingBird, ctx.random, activity === 'watch')
        changed = true
      }
    } else if (now >= nextIdleLifeAt) {
      if (watchingBird || activity === 'watch') {
        // Window life: back-view beats only — a front-view blink would
        // spin the cat around for a frame. Frames-30 wave 4: the head-
        // tracking chatter bout alternates with the tailflick so the
        // window cat visibly follows something outside every few
        // seconds (4-9s cadence, anti-repeat via lastIdleLifeWasSpecial).
        idleSequence = lastIdleLifeWasSpecial ? 'tailflick' : ('chatter_bout' as CatAnimSequenceName)
        lastIdleLifeWasSpecial = !lastIdleLifeWasSpecial
      } else if (lastIdleLifeWasSpecial) {
        idleSequence = cat.id === 'coco' ? null : 'blink'
        lastIdleLifeWasSpecial = false
      } else {
        idleSequence = pickSeatedIdle(cat.id)
        lastIdleLifeWasSpecial = idleSequence !== 'blink'
      }
      idleSequenceStartedAt = now
      nextIdleLifeAt = now + nextIdleGap(watchingBird, ctx.random, activity === 'watch')
      changed = true
    }
  } else if (activity === 'sleep' && !cat.climbing) {
    // Frames-30 wave-1 pickup: sleeping cats get their own rare idle —
    // the dream twitch — on an 8–20s cadence over the breathe loop.
    if (idleSequence === 'dream_twitch') {
      const duration = sequenceDurationMs(CAT_ANIM_SEQUENCES.dream_twitch[cat.id])
      if (now - idleSequenceStartedAt >= duration) {
        idleSequence = null
        nextIdleLifeAt = now + 8000 + ctx.random() * 12000
        changed = true
      }
    } else if (idleSequence) {
      idleSequence = null
      changed = true
    } else if (now >= nextIdleLifeAt) {
      idleSequence = 'dream_twitch'
      idleSequenceStartedAt = now
      nextIdleLifeAt = now + 8000 + ctx.random() * 12000
      changed = true
    }
  } else if (
    (idleSequence === 'look_back' || idleSequence === 'earflick') &&
    now < cat.moveRampAt
  ) {
    // Frames-30 wave-1/4 pickup: pre-departure regard-hold beats — the
    // look-back glance or the little ear flick armed by travelToward.
    // They self-expire (or moveRampAt passes) before the paws move.
    const duration = sequenceDurationMs(CAT_ANIM_SEQUENCES[idleSequence][cat.id])
    if (now - idleSequenceStartedAt >= duration) {
      idleSequence = null
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
  let phaseTime = timelineActive ? now : cat.phaseTime
  // Frames-30 wave-1 pickup: plain sleep runs the 1400ms breathe loop —
  // quantize its clock to 700ms buckets so a sleeping cat re-renders
  // twice per breath instead of 60×/s (the ref-stable bail-out stays
  // effective). Transitions, twitches and climbs stay unquantized.
  if (
    activity === 'sleep' &&
    timelineActive &&
    idleSequence === null &&
    now - cat.activityStartedAt >= transitionDuration
  ) {
    phaseTime =
      cat.activityStartedAt +
      Math.floor((now - cat.activityStartedAt) / 700) * 700
  }
  // The statue bug (FINDING 9): freezing phaseTime a tick BEFORE the
  // transition chain ends pins the plan on the LAST transition frame
  // (a perched cat held jump_post for seconds instead of its seated
  // hold). A frozen clock must always rest AT or past the chain's end.
  if (!timelineActive && phaseTime - cat.activityStartedAt < transitionDuration) {
    phaseTime = cat.activityStartedAt + transitionDuration
  }
  if (phaseTime !== cat.phaseTime) changed = true
  if (climbing !== cat.climbing) changed = true

  // --- Beat expiry -------------------------------------------------------------
  if (now > activityUntil && !gaitReady) {
    const base: PlayCat = {
      ...cat,
      x,
      y,
      laneBlend,
      direction,
      mood,
      moodSecondary,
      poop,
      climbing,
      climbDir,
      climbStartedAt,
      turn,
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
      ...cat, x, y, laneBlend, direction, mood, moodSecondary, poop, activityUntil, phaseTime,
      climbTravel: false, climbing: false, climbDir: null, climbStartedAt: 0, turn: null,
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
    laneBlend,
    direction,
    mood,
    moodSecondary,
    poop,
    climbing,
    climbDir,
    climbStartedAt,
    turn,
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
      x: anchorCatX(cat.targetAnchor, ctx.sceneW, ctx.compact),
      y: anchorCatY(cat.targetAnchor, ctx.sceneW, ctx.sceneH, ctx.compact),
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
    case 'drink':
    case 'sleep': // breathe loop (phaseTime quantized to 700ms buckets above)
      return true
    default:
      return false
  }
}

function nextIdleGap(watchingBird: boolean, random: () => number, watching = false): number {
  // Bird chatter runs the tail at ~2× cadence; the plain window dwell
  // paces its chatter/tailflick beats on a 4-9s rhythm (frames-30 w4).
  if (watchingBird) return 900 + random() * 1300
  if (watching) return 4000 + random() * 5000
  return 3000 + random() * 4000
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
  // RESIDUAL B (Panther glued to the tree): a continuous stay on an
  // elevated anchor past its jittered dwell deadline ends in a FORCED
  // dismount stroll — another roll could keep her in place (sit_spot /
  // re-perch apply in place), so the cap does not go through the pool.
  // Petting and toy commitments still preempt (checked further down
  // only for focus types this branch does not carry).
  if (
    isElevatedAnchor(cat.anchorId) &&
    now >= cat.perchDwellDeadline &&
    cat.focus?.type !== 'pet' &&
    cat.focus?.type !== 'toy'
  ) {
    return forceDismountStroll(cat, now, ctx)
  }
  // A completed squat pays off (2026-07-11): the poop lands ON THE
  // GROUND at the cat's trailing edge as the bout ends, and outlives
  // the activity — the next beat walks away from it. The litter-box
  // squat's product stays hidden inside the box (the front-lip z-trick
  // masks the cat's lower half there anyway), so only floor squats
  // spawn a visible poop.
  if (cat.activity === 'pooped' && cat.anchorId !== 'litter_box') {
    cat = {
      ...cat,
      poop: {
        ...spawnGroundPoop(cat.x, cat.direction, CAT_WIDTH_PX, now, ctx.random),
        y: cat.y,
        lane: cat.lane,
      },
    }
  }
  // Tunnel dive re-emerges: pop out of the FAR mouth with a stretch,
  // THEN the next beat rolls (discovery beat — the rustle pays off).
  // This is the ONLY sanctioned teleport in the playground: the cat is
  // hidden for the whole hop and the prop visually covers both mouths.
  if (cat.activity === 'tunnel') {
    const rect = packedSpotFor('tunnel', ctx.sceneW, ctx.compact)
    const exitFrac = cat.direction === 'R' ? 0.85 : 0.15
    const exitX = rect
      ? clampCatX(rect.left + rect.width * exitFrac - CAT_WIDTH_PX / 2, ctx.sceneW)
      : cat.x
    const emerged = setPlayActivity({ ...cat, x: exitX }, 'stretch', 1100, now, ctx.random)
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
  compact: boolean,
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
    // Visit length varies per bird (id-hashed jitter — no metronome).
    const visitMs = BIRD_VISIT_MS - 2500 + (((critter.id * 2654435761) >>> 0) % 5000)
    if (t > visitMs) {
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
    const perch = feederPerchPoint(sceneW, sceneH, compact)
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

function sameFocus(a: PlayCat['focus'], b: PlayCat['focus']): boolean {
  if (a === null || b === null) return a === b
  if (a.type === 'toy' && b.type === 'toy') return a.toy === b.toy
  if (a.type === 'treat' && b.type === 'treat') return a.treatId === b.treatId
  return a.type === b.type
}

function nearestOpenTreatFocus(
  toys: PlaygroundState['toys'],
  targetX: number,
  targetY: number,
): PlayCat['focus'] {
  let best: { id: number; d: number } | null = null
  for (const t of toys.treats) {
    if (t.state === 'claimed') continue
    const d = Math.hypot(t.x - targetX, t.y - targetY)
    if (best === null || d < best.d) best = { id: t.id, d }
  }
  return best ? { type: 'treat', treatId: best.id } : null
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
      // Toy targets arrive in toy space (center x / top-origin y);
      // ground the cat on the target lane's floor under the toy —
      // cats run along floors, never levitate to a mid-air dot.
      const targetX = clampCatX(req.targetX - CAT_WIDTH_PX / 2, ctx.sceneW)
      const targetY = laneFloorY(req.lane, ctx.sceneH)
      // CONTRACT FRICTION: the chase request carries no toy identity,
      // so infer it from the live toy state (laser wins, then wand,
      // then yarn, then the nearest open treat for treat pursuits).
      const focus: PlayCat['focus'] = toys.laser.on
        ? { type: 'toy', toy: 'laser' }
        : toys.wand.held
          ? { type: 'toy', toy: 'wand' }
          : toys.yarn !== null
            ? { type: 'toy', toy: 'yarn' }
            : nearestOpenTreatFocus(toys, req.targetX, req.targetY)
      // A RE-STEER of an ongoing chase (the dot moved) only updates the
      // target: re-running setPlayActivity every retarget would reset
      // the ease-in ramp each frame and freeze the cat at launch speed.
      const continuing =
        cat.activity === gaitActivity && sameFocus(cat.focus, focus)
      if (continuing) {
        const clockLow = cat.activityUntil - now < 3000
        if (!clockLow && cat.targetX === targetX && cat.targetY === targetY && cat.lane === req.lane) {
          return cat
        }
        return {
          ...cat,
          targetX,
          targetY,
          lane: req.lane,
          activityUntil: Math.max(cat.activityUntil, now + 6000),
        }
      }
      const next = setPlayActivity(cat, gaitActivity, 6000, now, ctx.random)
      return {
        ...next,
        targetAnchor: null,
        route: [],
        anchorId: null,
        // A perched cat answering a toy descends with the climb loop.
        climbTravel: isElevatedAnchor(cat.anchorId),
        targetX,
        targetY,
        lane: req.lane,
        arrival: null,
        focus,
        // Sticky sleep / anticipation: the wake-up + get-up chain plays
        // before the paws move (reaction delays are the brain's job).
        moveRampAt: now + playTransitionDurationMs(cat.id, cat.activity, gaitActivity),
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
        climbTravel: isElevatedAnchor(cat.anchorId),
        targetX: clampCatX(treat.x - CAT_WIDTH_PX / 2, ctx.sceneW),
        targetY: laneFloorY(treat.lane, ctx.sceneH),
        lane: treat.lane,
        arrival: { activity: 'eat', durationMs: EAT_BOUT_MS },
        focus: { type: 'treat', treatId: req.treatId },
        moveRampAt: now + playTransitionDurationMs(cat.id, cat.activity, 'walk'),
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
          moveRampAt: now + playTransitionDurationMs(cat.id, cat.activity, 'walk'),
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
