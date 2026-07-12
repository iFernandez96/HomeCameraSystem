import { rollWeighted, rollWithoutImmediateRepeat } from '../components/catEngineCore'
import { CAT_ANIM_SEQUENCES, sequenceDurationMs, type CatAnimSequenceName } from '../components/catAnimSequences'
import type { PlaygroundCatId } from './playgroundAssets'
import {
  PERCH_NO_REPEAT_MS,
  perchDwellDeadlineFor,
  playTransitionDurationMs,
  setPlayActivity,
  setPlayMood,
  type PlayActivity,
  type PlayCat,
} from './playgroundState'
import {
  anchorById,
  anchorsForLayout,
  clampCatX,
  isAnchorFree,
  isElevatedAnchor,
  laneFloorY,
  routeTo,
} from './sceneModel'
import type { AmbientEntity } from './playgroundTypes'

// Playground Slice B — the autonomous beat brain. Shimeji two-layer
// model (design doc research #1): the BEATS below are WHAT a cat can
// do; personality lives ONLY in the per-cat WEIGHTS. Weighted rolls
// go through catEngineCore's rollWeighted (one Math.random per roll —
// tests pin outcomes by stubbing Math.random) with the shared
// anti-immediate-repeat wrapper keyed on beat id.

export type BeatContext = {
  cats: readonly PlayCat[]
  ambient: readonly AmbientEntity[]
  sceneW: number
  sceneH: number
  compact: boolean
  /** Tick clock — availability gates (perch no-repeat window) need it. */
  now: number
  /** Injected random source for duration jitter / target scatter. */
  random: () => number
}

export type Beat = {
  id: string
  weights: Record<PlaygroundCatId, number>
  /** Extra availability gate on top of anchor occupancy. */
  available?: (cat: PlayCat, ctx: BeatContext) => boolean
  apply: (cat: PlayCat, now: number, ctx: BeatContext) => PlayCat
}

// === Beat application helpers ===============================================

/** Send a cat traveling to an anchor, arriving into `arrivalActivity`.
    Route comes from anchor metadata (floor → tree → shelf); waypoints
    the cat already occupies are skipped so a tree-top cat hops
    directly to a shelf. */
export function travelToAnchor(
  cat: PlayCat,
  now: number,
  ctx: BeatContext,
  anchorId: string,
  arrivalActivity: PlayActivity,
  arrivalDurationMs: number,
): PlayCat {
  const fullRoute = routeTo(anchorId)
  const atIndex = cat.anchorId ? fullRoute.indexOf(cat.anchorId) : -1
  const route = fullRoute.slice(atIndex + 1)
  if (route.length === 0) {
    // Already there — start the arrival beat in place. The continuous-
    // stay clock only restarts when the anchor actually changes.
    const sameAnchor = cat.anchorId === anchorId
    return {
      ...setPlayActivity(cat, arrivalActivity, arrivalDurationMs, now, ctx.random),
      anchorId,
      anchorSince: sameAnchor ? cat.anchorSince : now,
      perchDwellDeadline: sameAnchor
        ? cat.perchDwellDeadline
        : perchDwellDeadlineFor(now, ctx.random),
      focus: { type: 'anchor', anchorId },
    }
  }
  const next = setPlayActivity(cat, 'walk', 60000, now, ctx.random)
  // Frames-30 wave-1 pickup: 25% of departures glance back over the
  // shoulder during the regard hold (the look_back standing sequence)
  // before setting off — moveRampAt stretches to cover it.
  const transitionMs = playTransitionDurationMs(cat.id, cat.activity, 'walk')
  const glances = ctx.random() < LOOK_BACK_REGARD_PROB
  // Frames-30 wave 4: departures that DON'T glance sometimes flick an
  // ear instead — a cheaper alive-tick during the same regard hold.
  const flicks = !glances && ctx.random() < EAR_FLICK_REGARD_PROB
  const glanceMs = glances
    ? sequenceDurationMs(CAT_ANIM_SEQUENCES.look_back[cat.id])
    : flicks
      ? sequenceDurationMs(CAT_ANIM_SEQUENCES.earflick[cat.id])
      : 0
  return {
    ...next,
    // A mount or dismount leg plays the climb loop while it still has
    // vertical distance; pure floor-to-floor travel keeps the walk gait.
    climbTravel: isElevatedAnchor(anchorId) || isElevatedAnchor(cat.anchorId),
    // Travel cap, not a beat length — arrival restarts the clock.
    activityUntil: now + 60000,
    targetAnchor: route[0],
    route,
    anchorId: null,
    arrival: { activity: arrivalActivity, durationMs: arrivalDurationMs },
    focus: { type: 'anchor', anchorId },
    targetX: null,
    targetY: null,
    ...(glances || flicks
      ? {
          idleSequence: (glances ? 'look_back' : 'earflick') as CatAnimSequenceName,
          idleSequenceStartedAt: now + transitionMs,
        }
      : {}),
    // Look before you go: the stand-up transition plays out, then a
    // small jittered regard-the-destination hold (sometimes a full
    // look-back glance), THEN paws move.
    moveRampAt: now + transitionMs + glanceMs + 150 + ctx.random() * 250,
  }
}

export const LOOK_BACK_REGARD_PROB = 0.25
export const EAR_FLICK_REGARD_PROB = 0.3

function inPlace(
  cat: PlayCat,
  now: number,
  ctx: BeatContext,
  activity: PlayActivity,
  durationMs: number,
): PlayCat {
  return {
    ...setPlayActivity(cat, activity, durationMs, now, ctx.random),
    targetAnchor: null,
    route: [],
    arrival: null,
    targetX: null,
    targetY: null,
  }
}

/** RESIDUAL B: a just-dismounted anchor stays off this cat's own menu
    for a short window, so she does something else before re-perching. */
const anchorCoolingDown = (cat: PlayCat, anchorId: string, now: number): boolean =>
  cat.anchorCooldownId === anchorId && now < cat.anchorCooldownUntil

const anchorFreeFor = (anchorId: string) => (cat: PlayCat, ctx: BeatContext) =>
  isAnchorFree(ctx.cats, anchorId, cat.id) &&
  !anchorCoolingDown(cat, anchorId, ctx.now) &&
  anchorsForLayout(ctx.sceneW, ctx.compact).some((a) => a.id === anchorId)

// === The beat pool ===========================================================
// Weights follow the design doc's dweller taxonomy: Panther = Tree
// (perch-dominant), Coco = Bush (hammock/nap-dominant, tunnel nook),
// Mushu = Beach (open floor, tunnel dives, first responder).

export const PLAY_BEATS: readonly Beat[] = [
  {
    id: 'hammock_nap',
    weights: { panther: 1, mushu: 1, coco: 8 },
    available: anchorFreeFor('hammock'),
    apply: (cat, now, ctx) => {
      const next = travelToAnchor(cat, now, ctx, 'hammock', 'hammock', 26000)
      return setPlayMood(next, '😴', 2200, now, '💤')
    },
  },
  {
    id: 'floor_nap',
    weights: { panther: 2, mushu: 2, coco: 6 },
    apply: (cat, now, ctx) => {
      const next = inPlace(cat, now, ctx, 'sleep', 22000)
      return setPlayMood(next, '💤', 2200, now)
    },
  },
  {
    id: 'tree_perch',
    weights: { panther: 7, mushu: 2, coco: 1 },
    available: anchorFreeFor('tree_top'),
    apply: (cat, now, ctx) => {
      const next = travelToAnchor(cat, now, ctx, 'tree_top', 'perch', 16000)
      // Moods punctuate, they don't persist: the judging look is an
      // occasional commentary, not a HUD element.
      return cat.id === 'panther' && ctx.random() < 0.55
        ? setPlayMood(next, '😼', 2200, now)
        : next
    },
  },
  {
    id: 'shelf_perch',
    weights: { panther: 4, mushu: 1, coco: 1 },
    available: (cat, ctx) =>
      pickFreeShelf(cat, ctx) !== null,
    apply: (cat, now, ctx) => {
      const shelf = pickFreeShelf(cat, ctx)
      if (!shelf) return cat
      return travelToAnchor(cat, now, ctx, shelf, 'perch', 14000)
    },
  },
  {
    id: 'tunnel_dive',
    weights: { panther: 1, mushu: 5, coco: 3 },
    available: anchorFreeFor('tunnel_inside'),
    apply: (cat, now, ctx) => {
      // HIDDEN beat: 3–8 s inside; the tunnel rustles, then re-emerge.
      const hiddenMs = 3000 + ctx.random() * 5000
      return travelToAnchor(cat, now, ctx, 'tunnel_inside', 'tunnel', hiddenMs)
    },
  },
  {
    id: 'scratch_bout',
    weights: { panther: 2, mushu: 3, coco: 1 },
    available: anchorFreeFor('scratch_post'),
    apply: (cat, now, ctx) =>
      travelToAnchor(cat, now, ctx, 'scratch_post', 'scratch', 3200),
  },
  {
    id: 'window_watch',
    weights: { panther: 2, mushu: 2, coco: 1 },
    available: anchorFreeFor('window_perch'),
    apply: (cat, now, ctx) => {
      const next = travelToAnchor(cat, now, ctx, 'window_perch', 'watch', 9000)
      const birdLive = ctx.ambient.some((a) => a.kind === 'bird')
      return birdLive ? setPlayMood(next, '👀', 2600, now) : next
    },
  },
  {
    id: 'litter_visit',
    weights: { panther: 1, mushu: 1, coco: 1 },
    available: anchorFreeFor('litter_box'),
    // Reuses the existing 'pooped' squat + poop_squat sequence. No
    // mood bubble (2026-07-11 "poop shouldn't be an emoji that flys
    // upward") — and no ground poop either: a litter squat's product
    // stays hidden inside the box (stepPlayground skips the spawn when
    // the cat is anchored at litter_box).
    apply: (cat, now, ctx) =>
      travelToAnchor(cat, now, ctx, 'litter_box', 'pooped', 4500),
  },
  {
    // The rare floor accident — a squat wherever the cat happens to
    // stand. When it completes, stepPlayground drops a visible ground
    // poop with stink fumes at the trailing edge (the litter beat's
    // product stays masked by the box; this one is the payoff the user
    // asked for: "what happened to having the cats poop?").
    id: 'floor_poop',
    weights: { panther: 1, mushu: 1, coco: 1 },
    // Grounded cats only — a squat on a perch would leave a poop
    // floating on a platform.
    available: (cat) => cat.anchorId === null || anchorById(cat.anchorId).tier === 'floor',
    apply: (cat, now, ctx) => inPlace(cat, now, ctx, 'pooped', 4500),
  },
  {
    id: 'bowl_snack',
    weights: { panther: 2, mushu: 2, coco: 2 },
    available: (cat, ctx) =>
      isAnchorFree(ctx.cats, 'food_bowl', cat.id) ||
      isAnchorFree(ctx.cats, 'water_bowl', cat.id),
    apply: (cat, now, ctx) => {
      // The two bowls read differently: chewing at the food bowl,
      // lapping at the water bowl (drink_bout).
      const bowl = isAnchorFree(ctx.cats, 'food_bowl', cat.id)
        ? 'food_bowl'
        : 'water_bowl'
      return travelToAnchor(cat, now, ctx, bowl, bowl === 'water_bowl' ? 'drink' : 'eat', 3600)
    },
  },
  {
    id: 'ambient_pursuit',
    weights: { panther: 1, mushu: 6, coco: 1 },
    available: (_cat, ctx) => ctx.ambient.length > 0,
    apply: (cat, now, ctx) => {
      const target = ctx.ambient[0]
      const next = setPlayActivity(cat, 'run', 60000, now, ctx.random)
      return {
        ...next,
        activityUntil: now + 60000,
        targetAnchor: null,
        route: [],
        anchorId: null,
        // A perched pursuer descends with the climb loop first.
        climbTravel: isElevatedAnchor(cat.anchorId),
        // Track it on the floor under the critter; the pounce on
        // arrival ALWAYS misses (design doc emotional contract).
        targetX: clampCatX(target.x, ctx.sceneW),
        targetY: laneFloorY('front', ctx.sceneH),
        arrival: { activity: 'pounce', durationMs: 900 },
        focus: { type: 'ambient', ambientId: target.id },
        // Crouched anticipation: the get-up chain plays before the sprint.
        moveRampAt: now + playTransitionDurationMs(cat.id, cat.activity, 'run') + 100 + ctx.random() * 200,
      }
    },
  },
  {
    id: 'sit_spot',
    weights: { panther: 5, mushu: 3, coco: 2 },
    apply: (cat, now, ctx) => {
      // Personality-flavored sit: Panther judges, Coco loafs.
      const activity: PlayActivity =
        cat.id === 'panther' ? 'judge' : cat.id === 'coco' ? 'loaf' : 'sit'
      return inPlace(cat, now, ctx, activity, 7000)
    },
  },
  {
    id: 'wander',
    weights: { panther: 2, mushu: 3, coco: 1 },
    apply: (cat, now, ctx) => {
      // An aimless moment: stroll a SHORT random distance from here,
      // pause briefly as if sniffing something, then re-roll. Bounded
      // strolls (not scene-wide marches) read as purposeless life.
      const next = setPlayActivity(cat, 'walk', 60000, now, ctx.random)
      const stride = 60 + ctx.random() * 180
      const sign = ctx.random() < 0.5 ? -1 : 1
      const x = clampCatX(cat.x + sign * stride, ctx.sceneW)
      return {
        ...next,
        activityUntil: now + 60000,
        targetAnchor: null,
        route: [],
        anchorId: null,
        climbTravel: isElevatedAnchor(cat.anchorId),
        targetX: x,
        targetY: laneFloorY('front', ctx.sceneH),
        arrival: { activity: 'sit', durationMs: 1400 },
        focus: null,
        moveRampAt:
          now + playTransitionDurationMs(cat.id, cat.activity, 'walk') + 150 + ctx.random() * 250,
      }
    },
  },
]

function pickFreeShelf(cat: PlayCat, ctx: BeatContext): string | null {
  const shelves = anchorsForLayout(ctx.sceneW, ctx.compact).filter((a) =>
    a.id.startsWith('shelf_'),
  )
  const free = shelves.filter(
    (a) => isAnchorFree(ctx.cats, a.id, cat.id) && !anchorCoolingDown(cat, a.id, ctx.now),
  )
  return free.length > 0 ? free[Math.floor(ctx.random() * free.length)].id : null
}

// === Forced dismount (RESIDUAL B: Panther glued to the tree) =================

/** A perch stay past its dwell deadline ends HERE, not with another
    roll that might keep the cat in place: stroll to a nearby floor
    spot (guaranteed movement), and put the vacated anchor behind a
    no-repeat window so the next rolls pick something else. */
export function forceDismountStroll(cat: PlayCat, now: number, ctx: BeatContext): PlayCat {
  const vacated = cat.anchorId
  const next = setPlayActivity(cat, 'walk', 60000, now, ctx.random)
  const stride = 80 + ctx.random() * 200
  const sign = ctx.random() < 0.5 ? -1 : 1
  return {
    ...next,
    activityUntil: now + 60000,
    targetAnchor: null,
    route: [],
    anchorId: null,
    anchorCooldownId: vacated,
    anchorCooldownUntil: now + PERCH_NO_REPEAT_MS,
    // Descending off the mount: the climb loop covers the vertical leg.
    climbTravel: isElevatedAnchor(vacated),
    targetX: clampCatX(cat.x + sign * stride, ctx.sceneW),
    targetY: laneFloorY('front', ctx.sceneH),
    lane: 'front',
    arrival: { activity: 'sit', durationMs: 1400 },
    focus: null,
    moveRampAt:
      now + playTransitionDurationMs(cat.id, cat.activity, 'walk') + 150 + ctx.random() * 250,
  }
}

// === Rolling =================================================================

/** Bird at the feeder boosts window-watching hard — Cat TV is ON. */
function beatWeightFor(beat: Beat, cat: PlayCat, ctx: BeatContext): number {
  let weight = beat.weights[cat.id]
  if (beat.id === 'window_watch' && ctx.ambient.some((a) => a.kind === 'bird')) {
    weight += cat.id === 'coco' ? 4 : 6
  }
  return weight
}

function rollBeatOnce(cat: PlayCat, ctx: BeatContext): Beat | null {
  const pool = PLAY_BEATS.filter(
    (beat) => beat.weights[cat.id] > 0 && (beat.available?.(cat, ctx) ?? true),
  )
  return rollWeighted(pool, (beat) => beatWeightFor(beat, cat, ctx))
}

/** Roll the cat's next autonomous beat. Anti-immediate-repeat rides
    catEngineCore's shared wrapper, keyed on beat id via a probe whose
    `activity` field carries the id (the wrapper is generic over
    `{ activity: string }`). */
export function rollNextBeat(cat: PlayCat, now: number, ctx: BeatContext): PlayCat {
  type Probe = { activity: string; beat: Beat | null }
  const probe: Probe = { activity: cat.lastBeatId ?? '', beat: null }
  const rolled = rollWithoutImmediateRepeat(
    (p: Probe) => {
      const beat = rollBeatOnce(cat, ctx)
      return beat ? { activity: beat.id, beat } : p
    },
    probe,
    now,
    ctx.sceneW,
  )
  if (!rolled.beat) return cat
  const next = rolled.beat.apply(cat, now, ctx)
  if (next === cat) return cat
  // Natural dismount off an elevated anchor (the new beat leaves it):
  // arm the same no-repeat window the forced dismount uses, so the cat
  // does something else before re-perching there (RESIDUAL B).
  const dismounted = isElevatedAnchor(cat.anchorId) && next.anchorId !== cat.anchorId
  return {
    ...next,
    lastBeatId: rolled.beat.id,
    ...(dismounted
      ? { anchorCooldownId: cat.anchorId, anchorCooldownUntil: now + PERCH_NO_REPEAT_MS }
      : {}),
  }
}

// === Cat-cat interaction pools (ported from CatLayer — same outcomes) ========

type InteractionOutcome = {
  weight: number
  apply: (a: PlayCat, b: PlayCat, now: number, w: number, random: () => number) => [PlayCat, PlayCat]
}

const face = (self: PlayCat, other: PlayCat): 'L' | 'R' =>
  self.x < other.x ? 'R' : 'L'

const grounded = (cat: PlayCat, now: number, ctx: { random: () => number }, activity: PlayActivity, durationMs: number): PlayCat => ({
  ...setPlayActivity(cat, activity, durationMs, now, ctx.random),
  targetAnchor: null,
  route: [],
  arrival: null,
  targetX: null,
  targetY: null,
  // Chase/flee outcomes sprint — but only after the get-up chain.
  moveRampAt: now + playTransitionDurationMs(cat.id, cat.activity, activity),
})

// Mushu + Coco — the love story
const interactionsMushuCoco: InteractionOutcome[] = [
  {
    weight: 5,
    apply: (mushu, coco, now, _w, random) => {
      let m = grounded(mushu, now, { random }, 'groom', 3500)
      m = setPlayMood(m, '😻', 3000, now, '💕')
      m.direction = face(mushu, coco)
      let c = grounded(coco, now, { random }, 'sit', 3500)
      c = setPlayMood(c, '😻💕', 3000, now)
      c.direction = face(coco, mushu)
      return [m, c]
    },
  },
  {
    weight: 3,
    apply: (mushu, coco, now, _w, random) => {
      let m = grounded(mushu, now, { random }, 'snuggle', 4500)
      m = setPlayMood(m, '😻', 3500, now, '✨')
      let c = grounded(coco, now, { random }, 'snuggle', 4500)
      c = setPlayMood(c, '😻', 3500, now, '✨')
      return [m, c]
    },
  },
  {
    weight: 2,
    apply: (mushu, coco, now, _w, random) => {
      let m = grounded(mushu, now, { random }, 'play', 1500)
      m = setPlayMood(m, '😹', 1500, now)
      let c = grounded(coco, now, { random }, 'stretch', 2000)
      c = setPlayMood(c, '😴', 2000, now, '🥱')
      return [m, c]
    },
  },
]

// Mushu + Panther — the rivalry
const interactionsMushuPanther: InteractionOutcome[] = [
  {
    weight: 4,
    apply: (mushu, panther, now, _w, random) => {
      let v = grounded(panther, now, { random }, 'hiss', 1800)
      v = setPlayMood(v, '😾', 1800, now, '💢')
      v.direction = face(panther, mushu)
      let m = grounded(mushu, now, { random }, 'scared', 1500)
      m = setPlayMood(m, '😨', 1500, now)
      m.direction = mushu.x < panther.x ? 'L' : 'R' // back away
      return [m, v]
    },
  },
  {
    weight: 2,
    apply: (mushu, panther, now, w, random) => {
      let v = grounded(panther, now, { random }, 'chase', 2500)
      v = setPlayMood(v, '😡', 2000, now, '💢')
      v.direction = face(panther, mushu)
      let m = grounded(mushu, now, { random }, 'flee', 2500)
      m = setPlayMood(m, '😱', 2000, now, '💨')
      m.direction = panther.x < mushu.x ? 'R' : 'L'
      m.targetX = m.direction === 'R' ? w - 48 : 8
      return [m, v]
    },
  },
  {
    weight: 1,
    apply: (mushu, panther, now, _w, random) => {
      let m = grounded(mushu, now, { random }, 'play', 2000)
      m = setPlayMood(m, '😹', 2000, now)
      let v = grounded(panther, now, { random }, 'sit', 2500)
      v = setPlayMood(v, '😾', 2500, now, '😡')
      return [m, v]
    },
  },
]

// Panther + Coco — peaceful coexistence
const interactionsPantherCoco: InteractionOutcome[] = [
  {
    weight: 5,
    apply: (panther, coco, now, _w, random) => {
      let v = grounded(panther, now, { random }, 'judge', 2000)
      v = setPlayMood(v, '😼', 2000, now, '👀')
      let c = grounded(coco, now, { random }, 'sit', 2000)
      c = setPlayMood(c, '🥱', 2000, now)
      return [v, c]
    },
  },
  {
    weight: 1,
    apply: (panther, coco, now, _w, random) => {
      let v = grounded(panther, now, { random }, 'judge', 1800)
      v = setPlayMood(v, '😼', 1800, now)
      let c = grounded(coco, now, { random }, 'scared', 1800)
      c = setPlayMood(c, '🙀', 1800, now)
      return [v, c]
    },
  },
  {
    weight: 1,
    apply: (panther, coco, now, _w, random) => {
      let v = grounded(panther, now, { random }, 'snuggle', 3000)
      v = setPlayMood(v, '😻', 2500, now)
      let c = grounded(coco, now, { random }, 'snuggle', 3000)
      c = setPlayMood(c, '😻', 2500, now, '✨')
      return [v, c]
    },
  },
]

export function rollPairInteraction(
  a: PlayCat,
  b: PlayCat,
  now: number,
  sceneW: number,
  random: () => number = Math.random,
): [PlayCat, PlayCat] | null {
  const ids = [a.id, b.id].sort().join(':')
  let pool: InteractionOutcome[] | null = null
  let first: PlayCat | null = null
  let second: PlayCat | null = null
  if (ids === 'coco:mushu') {
    pool = interactionsMushuCoco
    first = a.id === 'mushu' ? a : b
    second = a.id === 'coco' ? a : b
  } else if (ids === 'mushu:panther') {
    pool = interactionsMushuPanther
    first = a.id === 'mushu' ? a : b
    second = a.id === 'panther' ? a : b
  } else if (ids === 'coco:panther') {
    pool = interactionsPantherCoco
    first = a.id === 'panther' ? a : b
    second = a.id === 'coco' ? a : b
  }
  if (!pool || !first || !second) return null
  const outcome = rollWeighted(pool, (o) => o.weight)
  if (!outcome) return null
  const [na, nb] = outcome.apply(first, second, now, sceneW, random)
  const naFinal: PlayCat = { ...na, lastInteractedWith: second.id, lastInteractedAt: now }
  const nbFinal: PlayCat = { ...nb, lastInteractedWith: first.id, lastInteractedAt: now }
  return a.id === naFinal.id ? [naFinal, nbFinal] : [nbFinal, naFinal]
}
