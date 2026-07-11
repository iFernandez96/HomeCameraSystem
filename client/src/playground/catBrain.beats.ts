import { rollWeighted, rollWithoutImmediateRepeat } from '../components/catEngineCore'
import type { PlaygroundCatId } from './playgroundAssets'
import {
  playTransitionDurationMs,
  setPlayActivity,
  setPlayMood,
  type PlayActivity,
  type PlayCat,
} from './playgroundState'
import {
  anchorsForLayout,
  clampCatX,
  isAnchorFree,
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
    // Already there — start the arrival beat in place.
    return {
      ...setPlayActivity(cat, arrivalActivity, arrivalDurationMs, now, ctx.random),
      anchorId,
      focus: { type: 'anchor', anchorId },
    }
  }
  const next = setPlayActivity(cat, 'walk', 60000, now, ctx.random)
  return {
    ...next,
    // Travel cap, not a beat length — arrival restarts the clock.
    activityUntil: now + 60000,
    targetAnchor: route[0],
    route,
    anchorId: null,
    arrival: { activity: arrivalActivity, durationMs: arrivalDurationMs },
    focus: { type: 'anchor', anchorId },
    targetX: null,
    targetY: null,
    // Look before you go: the stand-up transition plays out, then a
    // small jittered regard-the-destination hold, THEN paws move.
    moveRampAt:
      now + playTransitionDurationMs(cat.id, cat.activity, 'walk') + 150 + ctx.random() * 250,
  }
}

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

const anchorFreeFor = (anchorId: string) => (cat: PlayCat, ctx: BeatContext) =>
  isAnchorFree(ctx.cats, anchorId, cat.id) &&
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
    apply: (cat, now, ctx) => {
      // Reuses the existing 'pooped' beat + poop_squat sequence.
      const next = travelToAnchor(cat, now, ctx, 'litter_box', 'pooped', 4500)
      return setPlayMood(next, '💩', 2600, now)
    },
  },
  {
    id: 'bowl_snack',
    weights: { panther: 2, mushu: 2, coco: 2 },
    available: (cat, ctx) =>
      isAnchorFree(ctx.cats, 'food_bowl', cat.id) ||
      isAnchorFree(ctx.cats, 'water_bowl', cat.id),
    apply: (cat, now, ctx) => {
      const bowl = isAnchorFree(ctx.cats, 'food_bowl', cat.id)
        ? 'food_bowl'
        : 'water_bowl'
      return travelToAnchor(cat, now, ctx, bowl, 'eat', 3600)
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
  const free = shelves.filter((a) => isAnchorFree(ctx.cats, a.id, cat.id))
  return free.length > 0 ? free[Math.floor(ctx.random() * free.length)].id : null
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
  return next === cat ? cat : { ...next, lastBeatId: rolled.beat.id }
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
