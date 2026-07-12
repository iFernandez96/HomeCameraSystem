import { memo, useEffect, useRef, useState } from 'react'
import {
  BombaySprite,
  CalicoSprite,
  CardboardBox,
  CatTree,
  FloatingBed,
  ToyMouse,
  TuxedoSprite,
  WallLedge,
  YarnBall,
} from './CatIcons'
import { CatParticles, type CatParticleType } from './CatParticles'
import { moodBadgeParts } from './catMoodBadges'
import {
  CAT_ANIM_SEQUENCES,
  CYCLE_DURATION_MS,
  catAnimFrameUrl,
  gaitVelocityPxPerMs,
  sequenceDurationMs,
  type CatAnimFrame,
  type CatAnimSequenceName,
} from './catAnimSequences'
// Playground Slice A: the pure sprite-engine machinery (pose
// transitions, plan builder, weighted rolls), the perf-gate hooks,
// and the image preload cache were EXTRACTED into shared modules so
// the Playground page can reuse them. CatLayer keeps thin wrappers
// bound to its own Activity maps; CatLayer.test.tsx pins that the
// extraction changed nothing.
import {
  POSE_TRANSITIONS,
  animationPlanFor as buildAnimationPlan,
  rand,
  rollWeighted,
  rollWithoutImmediateRepeat,
  turnPivotView,
  type AnimActivityMaps,
  type AnimationPlan,
  type PoseGroup,
  type TurnPivot,
} from './catEngineCore'
import {
  _resetImageCacheForTests,
  isImageSetReady,
  preloadImageUrls,
} from './catImageCache'
import {
  useBatteryLow,
  usePrefersReducedData,
  usePrefersReducedMotion,
} from './catPerfGates'
import {
  GroundPoop,
  POOP_SIZE_FRAC,
  groundPoopExpired,
  spawnGroundPoop,
  type GroundPoopSpawn,
} from './GroundPoop'

/**
 * iter-356.4-cats — ambient cat layer with full Animal-Crossing-style
 * personality. Three cats with distinct archetypes, ~20 mood emojis
 * each, scripted interactions including grooming / hissing / chasing /
 * scaring / playing, plus solo personality moments (zoomies, judging,
 * loafing, stretching).
 *
 * The cats:
 *
 *   PANTHER (Bombay, ♀) — aloof judge of the household. Slow walker.
 *     - Solo: sits + watches 👀, occasional grump 😾, judges 😼,
 *       startles other cats 🙀⚡ (she likes to stare from a distance)
 *     - vs Mushu: HISSES 😾💢 when he gets close. Sometimes chases
 *       him off → Mushu flees 😱💨
 *     - vs Coco: tolerates 😼, occasionally rubs cheek 😻 (rare)
 *
 *   MUSHU (Tuxedo, ♂) — playful instigator. Fast walker. Loves Coco.
 *     - Solo: zoomies 🐾⚡, happy dance 😹✨, plays with shadows 😺
 *     - vs Coco: HEAD-RUB → both 😻💕, sometimes grooms her 😻✨
 *     - vs Panther: tries to bump → gets hissed at → 😨 then either
 *       scampers off OR doubles down 😹 and gets chased
 *
 *   COCO (Calico, ♀) — sleepy + cuddly. Naps a lot. Loves Mushu.
 *     - Solo: long sleeps 😴💤, loafs ✨, stretches awake 🥱✨,
 *       sometimes purrs to herself 😻
 *     - vs Mushu: purrs back 😻💕, snuggles, very content
 *     - vs Panther: yawns 🥱 (zero drama), occasionally cries when
 *       Panther is mean 😿
 *
 * Interaction outcomes are weighted random — same pair can play out
 * different ways across sessions, giving the household real life.
 *
 * Constraints (unchanged from earlier draft):
 *   - Fixed-position bottom layer, pointer-events: none
 *   - z-index below modals + toasts
 *   - prefers-reduced-motion: cats freeze in place
 *   - Pauses when tab is hidden (battery)
 */

type CatId = 'panther' | 'mushu' | 'coco'

type Activity =
  // Calm states
  | 'walk'
  | 'sit'
  | 'sleep'
  | 'stretch'
  | 'loaf'
  | 'judge' // sit + stare aggressively (Panther)
  | 'on_post' // iter-356.41: sitting on the cat-tree habitat object
  | 'pooped' // silly rare bathroom break — squat + strain + kawaii poop prop
  | 'kick_dirt' // frames-30 wave 2: post-poop dirt-kick exit beat
  // Interactions
  | 'groom' // Mushu grooming Coco
  | 'snuggle' // Mushu + Coco sit close
  | 'hiss' // Panther hissing
  | 'scared' // jumped back, ears down
  | 'chase' // running fast at someone
  | 'flee' // running fast away
  | 'play' // happy hopping in place
  | 'pounce' // login: spring toward a toy
  | 'in_box' // login: peek from the cardboard box

type CatState = {
  id: CatId
  x: number
  y: number
  direction: 'L' | 'R'
  activity: Activity
  previousActivity: Activity
  activityStartedAt: number
  activityUntil: number
  mood: string | null
  moodSecondary: string | null // optional second emoji (😻💕)
  moodUntil: number
  // Targeted movement (for chase/flee)
  targetX: number | null
  // Last cat I interacted with — avoid instant re-interaction
  lastInteractedWith: CatId | null
  lastInteractedAt: number
  // Per-cat sprite-frame phase. Walking uses 0..11 for the raster walk
  // cycle (100ms normally, 67ms while chasing/fleeing); the built-in
  // fallback reads the same value modulo 2. Sitting still uses 0/1 for
  // its 600ms tail flick. Computed in stepCats so CatRender stays pure
  // (React 19 forbids reading performance.now() during render).
  phase: number
  phaseTime: number
  idleSequence: CatAnimSequenceName | null
  idleSequenceStartedAt: number
  nextIdleLifeAt: number
  lastIdleLifeWasSpecial: boolean
  // Ground poop lifecycle (2026-07-11): spawned when a 'pooped' bout
  // COMPLETES, anchored in scene coordinates (the cat walks away, the
  // poop stays), fades after 6–8 s. One per cat — the anti-repeat roll
  // means a cat can never squat twice inside one lifecycle window.
  poop: (GroundPoopSpawn & { y: number }) | null
  // Turn-around pivot (2026-07-11 "cats turn around soo slowly"): set
  // when a gaited cat reverses direction (wall bounce, walk→walk
  // re-roll). While active the cat plants (no x movement) and the
  // render layer plays the turn_around sequence, mirror-flipping at
  // the frontal midpoint instead of the old 220ms scaleX morph.
  turn: TurnPivot | null
  // Frames-30 bout variant: which sequence THIS bout plays when the
  // activity owns a variant pool — gallops for chase/flee (no immediate
  // repeat, velocity identical), groom targets (face/chest/hind-leg),
  // plain-vs-strained poop squat (50/50), hit-vs-tumble pounce (~20%
  // miss). Null for activities without a pool. Rolled once at
  // setActivity; cleared on every activity change.
  boutVariant: CatAnimSequenceName | null
}

const WALK_FRAME_COUNT = 12
const WALK_ENHANCEMENT_IDLE_MS = 60_000
const WALK_PRELOAD_STAGGER_MS: Record<CatId, number> = {
  panther: 0,
  mushu: 6_000,
  coco: 12_000,
}

// Preload cache generalized into catImageCache.ts (Playground Slice
// A). This wrapper keeps CatLayer's per-cat key + frame→URL mapping
// and the original log tag; ready/failed/in-flight semantics are
// unchanged (whole set or nothing; first error fails permanently).
function animationCacheKey(catId: CatId, frames: readonly CatAnimFrame[]): string {
  return `${catId}:${frames.join(',')}`
}

function preloadAnimationFrames(
  catId: CatId,
  frames: readonly CatAnimFrame[],
): Promise<boolean> {
  return preloadImageUrls(
    animationCacheKey(catId, frames),
    frames.map((frame) => catAnimFrameUrl(catId, frame)),
    'catLayer:walk-frames-failed',
  )
}

// Narrow test seam: module-scope image caches otherwise outlive each
// CatLayer render in Vitest. Production never calls this.
export function _resetCatWalkAnimationCacheForTests(): void {
  _resetImageCacheForTests()
}

function useAnimationFramesReady(
  catId: CatId,
  frames: readonly CatAnimFrame[],
  shouldPreload: boolean,
): boolean {
  const cacheKey = animationCacheKey(catId, frames)
  const [loadedKey, setLoadedKey] = useState<string | null>(
    () => isImageSetReady(cacheKey) ? cacheKey : null,
  )

  useEffect(() => {
    if (!shouldPreload || frames.length === 0) return
    let cancelled = false
    const requestedFrames = cacheKey.slice(cacheKey.indexOf(':') + 1).split(',') as CatAnimFrame[]
    const timer = window.setTimeout(() => {
      void preloadAnimationFrames(catId, requestedFrames).then((loaded) => {
        if (!cancelled && loaded) setLoadedKey(cacheKey)
      })
    }, WALK_PRELOAD_STAGGER_MS[catId])
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [cacheKey, catId, frames.length, shouldPreload])

  return frames.length > 0 && shouldPreload && (
    loadedKey === cacheKey || isImageSetReady(cacheKey)
  )
}

/**
 * Keep the optional 36-frame raster enhancement out of the critical load.
 * The original two-pose sprites remain animated immediately; the richer walk
 * cycles progressively warm after the first real interaction, or after one
 * quiet minute for a passive wall display. This avoids spending hundreds of
 * kilobytes before the security controls and live scene are usable.
 */
function useWalkEnhancementAllowed(enabled: boolean): boolean {
  const [allowed, setAllowed] = useState(false)

  useEffect(() => {
    if (!enabled) return
    let settled = false
    const allow = () => {
      if (settled) return
      settled = true
      setAllowed(true)
    }
    const timer = window.setTimeout(allow, WALK_ENHANCEMENT_IDLE_MS)
    window.addEventListener('pointerdown', allow, { passive: true })
    window.addEventListener('keydown', allow)
    return () => {
      settled = true
      window.clearTimeout(timer)
      window.removeEventListener('pointerdown', allow)
      window.removeEventListener('keydown', allow)
    }
  }, [enabled])

  return enabled && allowed
}

// === MOOD POOLS — wide vocabulary per personality ============================

const MOOD = {
  // Panther (Bombay, aloof)
  panther: {
    default: ['😼', '👀', '😾'],
    happy: ['😺', '😼'],
    angry: ['😾', '💢', '😡'],
    hissing: ['😾💢'],
    scared: ['🙀'],
    sleepy: ['😴', '💤'],
    bored: ['🥱', '😼'],
    proud: ['😼✨'],
  },
  // Mushu (Tuxedo, playful)
  mushu: {
    default: ['😺', '🐾', '😼'],
    happy: ['😺', '😸', '😹', '🥰'],
    loving: ['😻', '😻💕', '🥰'],
    angry: ['😾'],
    scared: ['😨', '😱'],
    fleeing: ['😱💨'],
    sleepy: ['😴', '🥱'],
    laughing: ['😹', '🤣'],
    excited: ['🐾⚡', '✨', '😸'],
    sad: ['😿'],
  },
  // Coco (Calico, sleepy + sweet)
  coco: {
    default: ['😴', '✨', '😻'],
    happy: ['😻', '😸', '🥰'],
    loving: ['😻💕', '🥰', '😻✨'],
    sleepy: ['😴', '💤', '🥱'],
    sad: ['😿', '😢'],
    scared: ['🙀'],
    cozy: ['✨', '😻', '😻💕'],
    bored: ['🥱'],
  },
} as const

// iter-356.11 (code-scalability T): generic constraint replaces the
// pre-iter-356.11 union+cast that lied about per-cat mood key sets.
// Pre-iter-356.11 `pickMood('panther', 'loving')` compiled clean even
// though Panther has no 'loving' pool — fell through to default at
// runtime, no type error. With `<C extends CatId, K extends keyof typeof MOOD[C]>`
// the call site is constrained to keys that ACTUALLY exist for that
// cat; a typo or wrong-cat pairing fails at compile time. The runtime
// fallback to MOOD[id].default stays as belt-and-braces in case a
// dynamic key sneaks in (none today; preserved for safety).
function pickMood<C extends CatId, K extends keyof (typeof MOOD)[C]>(
  id: C,
  kind: K,
): string {
  const pool = (MOOD[id] as Record<string, readonly string[]>)[kind as string] ?? MOOD[id].default
  return pool[Math.floor(Math.random() * pool.length)]
}

// === INTERACTION OUTCOMES (weighted random per ordered pair) =================

type InteractionOutcome = {
  weight: number
  apply: (a: CatState, b: CatState, now: number, w: number) => [CatState, CatState]
}

// Helpers
function setMood(c: CatState, mood: string, durationMs: number, now: number, secondary?: string): CatState {
  return { ...c, mood, moodSecondary: secondary ?? null, moodUntil: now + durationMs }
}
// Frames-30 variant gaits: the gallop pool a chase/flee bout rolls from.
// run_lope is empty for mushu (dropped frames) so his pool is [run,
// run_bound] — availability is read off the sequence table, not hardcoded.
function rollGaitVariant(catId: CatId, previous: CatAnimSequenceName | null): CatAnimSequenceName {
  const pool: CatAnimSequenceName[] = ['run', 'run_bound']
  if (CAT_ANIM_SEQUENCES.run_lope[catId].length > 0) pool.push('run_lope')
  // No immediate repeat: a cat never opens two consecutive sprints on
  // the same gallop. One Math.random() call (tests script the roll).
  const choices = previous ? pool.filter((name) => name !== previous) : pool
  return choices[Math.floor(Math.random() * choices.length)] ?? 'run'
}

// Frames-30 wave 2: the bout-variant roll, one Math.random() per entry.
// Gallops and groom targets rotate with no immediate repeat (3-pools);
// the 2-pools (squat strain, pounce tumble) roll independently so the
// odds stay a true 50% / 20% instead of forced alternation.
function rollBoutVariant(c: CatState, activity: Activity): CatAnimSequenceName | null {
  if (activity === 'chase' || activity === 'flee') return rollGaitVariant(c.id, c.boutVariant)
  if (activity === 'groom') {
    const pool: CatAnimSequenceName[] = ['groom_bout', 'groom_chest_bout', 'groom_leg_bout']
    const choices = c.boutVariant ? pool.filter((n) => n !== c.boutVariant) : pool
    return choices[Math.floor(Math.random() * choices.length)] ?? 'groom_bout'
  }
  if (activity === 'pooped') return Math.random() < 0.5 ? 'poop_squat_strained' : 'poop_squat'
  if (activity === 'pounce' || activity === 'play') return Math.random() < 0.2 ? 'pounce_tumble' : 'pounce'
  return null
}

function setActivity(c: CatState, activity: Activity, durationMs: number, now: number): CatState {
  return {
    ...c,
    previousActivity: c.activity,
    activity,
    activityStartedAt: now,
    // Duration jitter (user feedback 2026-07-11 "contrived and repeating"):
    // no bout ever lasts exactly its nominal length twice. ±~25% keeps
    // repeated states from reading as a metronome — the standard idle-
    // variation trick in game/mascot animation.
    activityUntil: now + durationMs * rand(0.78, 1.32),
    phaseTime: now,
    idleSequence: null,
    // Sleep idles (dream twitches) run on a slower 8–20s cadence than the
    // seated blink/groom pool.
    nextIdleLifeAt: now + (activity === 'sleep' ? rand(8000, 20000) : rand(3000, 7000)),
    lastIdleLifeWasSpecial: false,
    // A new activity owns its own entry choreography — an in-flight
    // turn pivot from the previous beat must not overlay it.
    turn: null,
    boutVariant: rollBoutVariant(c, activity),
  }
}

// === Mushu + Coco — the love story ===
const interactionsMushuCoco: InteractionOutcome[] = [
  {
    weight: 5, // most likely
    apply: (mushu, coco, now) => {
      // Grooming session — Mushu licks Coco' face. Both 😻
      let m = setActivity(mushu, 'groom', 3500, now)
      m = setMood(m, '😻', 3000, now, '💕')
      m.direction = mushu.x < coco.x ? 'R' : 'L'
      let p = setActivity(coco, 'sit', 3500, now)
      p = setMood(p, pickMood('coco', 'loving'), 3000, now)
      p.direction = coco.x < mushu.x ? 'R' : 'L'
      return [m, p]
    },
  },
  {
    weight: 3,
    apply: (mushu, coco, now) => {
      // Snuggle — sit next to each other purring
      let m = setActivity(mushu, 'snuggle', 4500, now)
      m = setMood(m, '😻', 3500, now, '✨')
      let p = setActivity(coco, 'snuggle', 4500, now)
      p = setMood(p, '😻', 3500, now, '✨')
      return [m, p]
    },
  },
  {
    weight: 2,
    apply: (mushu, coco, now) => {
      // Mushu wakes Coco up playfully
      let m = setActivity(mushu, 'play', 1500, now)
      m = setMood(m, '😹', 1500, now)
      let p = setActivity(coco, 'stretch', 2000, now)
      p = setMood(p, pickMood('coco', 'sleepy'), 2000, now, '🥱')
      return [m, p]
    },
  },
]

// === Mushu + Panther — the rivalry ===
const interactionsMushuPanther: InteractionOutcome[] = [
  {
    weight: 4,
    apply: (mushu, panther, now) => {
      // Panther hisses; Mushu scared
      let v = setActivity(panther, 'hiss', 1800, now)
      v = setMood(v, '😾', 1800, now, '💢')
      v.direction = panther.x < mushu.x ? 'R' : 'L'
      let m = setActivity(mushu, 'scared', 1500, now)
      m = setMood(m, '😨', 1500, now)
      m.direction = mushu.x < panther.x ? 'L' : 'R' // back away
      return [m, v]
    },
  },
  {
    weight: 2,
    apply: (mushu, panther, now, w) => {
      // Panther CHASES Mushu
      let v = setActivity(panther, 'chase', 2500, now)
      v = setMood(v, '😡', 2000, now, '💢')
      v.targetX = mushu.x // chase toward Mushu
      v.direction = panther.x < mushu.x ? 'R' : 'L'
      let m = setActivity(mushu, 'flee', 2500, now)
      m = setMood(m, '😱', 2000, now, '💨')
      m.direction = panther.x < mushu.x ? 'R' : 'L' // run away from panther
      m.targetX = m.direction === 'R' ? w - 40 : 8
      return [m, v]
    },
  },
  {
    weight: 1,
    apply: (mushu, panther, now) => {
      // Mushu teases successfully — laughs while Panther fumes
      let m = setActivity(mushu, 'play', 2000, now)
      m = setMood(m, '😹', 2000, now)
      let v = setActivity(panther, 'sit', 2500, now)
      v = setMood(v, '😾', 2500, now, '😡')
      return [m, v]
    },
  },
]

// === Panther + Coco — peaceful coexistence ===
const interactionsPantherCoco: InteractionOutcome[] = [
  {
    weight: 5,
    apply: (panther, coco, now) => {
      // Panther judges, Coco yawns
      let v = setActivity(panther, 'judge', 2000, now)
      v = setMood(v, '😼', 2000, now, '👀')
      let p = setActivity(coco, 'sit', 2000, now)
      p = setMood(p, '🥱', 2000, now)
      return [v, p]
    },
  },
  {
    weight: 1,
    apply: (panther, coco, now) => {
      // Panther surprises Coco — Coco cries
      let v = setActivity(panther, 'judge', 1800, now)
      v = setMood(v, '😼', 1800, now)
      let p = setActivity(coco, 'scared', 1800, now)
      p = setMood(p, '🙀', 1800, now)
      return [v, p]
    },
  },
  {
    weight: 1,
    apply: (panther, coco, now) => {
      // Rare cheek-rub
      let v = setActivity(panther, 'snuggle', 3000, now)
      v = setMood(v, '😻', 2500, now)
      let p = setActivity(coco, 'snuggle', 3000, now)
      p = setMood(p, '😻', 2500, now, '✨')
      return [v, p]
    },
  },
]

function rollInteraction(
  a: CatState,
  b: CatState,
  now: number,
  viewportWidth: number,
): [CatState, CatState] | null {
  const ids = [a.id, b.id].sort().join(':')
  let pool: InteractionOutcome[] | null = null
  let asMushu: CatState | null = null
  let asPartner: CatState | null = null
  if (ids === 'mushu:coco') {
    pool = interactionsMushuCoco
    asMushu = a.id === 'mushu' ? a : b
    asPartner = a.id === 'coco' ? a : b
  } else if (ids === 'mushu:panther') {
    pool = interactionsMushuPanther
    asMushu = a.id === 'mushu' ? a : b
    asPartner = a.id === 'panther' ? a : b
  } else if (ids === 'coco:panther') {
    pool = interactionsPantherCoco
    asMushu = a.id === 'panther' ? a : b
    asPartner = a.id === 'coco' ? a : b
  }
  if (!pool || !asMushu || !asPartner) return null
  const outcome = rollWeighted(pool, (o) => o.weight)
  if (!outcome) return null
  const [na, nb] = outcome.apply(asMushu, asPartner, now, viewportWidth)
  // Re-stamp last-interacted so cats don't loop
  const naFinal: CatState = {
    ...na,
    lastInteractedWith: asPartner.id,
    lastInteractedAt: now,
  }
  const nbFinal: CatState = {
    ...nb,
    lastInteractedWith: asMushu.id,
    lastInteractedAt: now,
  }
  // Map back to a/b ordering
  if (a.id === naFinal.id) return [naFinal, nbFinal]
  return [nbFinal, naFinal]
}

// === SOLO EVENTS — random personality moments ===============================

type SoloEvent = {
  weight: number
  apply: (c: CatState, now: number, w: number) => CatState
}

// iter-356.13 (user directive: "maybe not have them walk so much"):
// rebalanced weights heavily toward static activities. Pre-iter-356.13
// the SOLO_EVENTS averaged ~50% walking time; now ~20%. Cats are
// mascots that occasionally move, à la GitHub Octocat — present but
// not buzzing across the screen. Sleep + sit + judge + loaf are the
// dominant states; walking is a flavor occasionally.
const SOLO_EVENTS: Record<CatId, SoloEvent[]> = {
  panther: [
    {
      // Sit + watch silently — was 5, bumped to 8 (Panther's whole
      // personality is judging from a perch).
      weight: 8,
      apply: (c, now) => {
        let n = setActivity(c, 'judge', 8000, now)
        n = setMood(n, pickMood('panther', 'default'), 2200, now)
        return n
      },
    },
    {
      // iter-356.41: CLIMB THE CAT TREE. Panther's "judge from a perch"
      // personality fits: she literally climbs to a vantage point to
      // stare down at everyone. Snap to the tree x; cat-on-post PNG
      // includes the post so the empty habitat tree visually merges.
      weight: 5,
      apply: (c, now, w) => {
        let n = setActivity(c, 'on_post', 14000, now)
        n = setMood(n, pickMood('panther', 'default'), 2500, now)
        n.x = catTreeX(w)
        n.direction = 'L' // PNGs face L by default; matches the tree's
        // visible content (cat draped looking left over the post edge).
        return n
      },
    },
    {
      // Sleep — was 4 / 18s, bumped to 7 / 28s.
      weight: 7,
      apply: (c, now) => {
        let n = setActivity(c, 'sleep', 28000, now)
        n = setMood(n, '💤', 2200, now)
        return n
      },
    },
    {
      // Random grump
      weight: 3,
      apply: (c, now) => {
        let n = setActivity(c, 'sit', 4000, now)
        n = setMood(n, pickMood('panther', 'angry'), 2200, now)
        return n
      },
    },
    {
      // Walk on — was 6, dropped to 2. Still possible, just rare.
      weight: 2,
      apply: (c, now) => {
        let n = setActivity(c, 'walk', 5000, now)
        n.direction = Math.random() < 0.5 ? 'L' : 'R'
        if (Math.random() < 0.3) n = setMood(n, '😼', 2000, now)
        return n
      },
    },
    {
      // Bathroom break — rare, silly, and even the dignified judge
      // isn't above it. Weight 1 keeps it a surprise, not a habit.
      weight: 1,
      apply: (c, now) => setActivity(c, 'pooped', 4500, now),
    },
  ],
  mushu: [
    {
      // ZOOMIES — Mushu is the playful one but even he settles.
      // Was 4, dropped to 2.
      weight: 2,
      apply: (c, now, w) => {
        let n = setActivity(c, 'play', 2500, now)
        n = setMood(n, '😹', 2500, now, '🐾')
        n.direction = c.x < w / 2 ? 'R' : 'L'
        return n
      },
    },
    {
      // iter-356.41: Mushu also occasionally climbs (less than Panther
      // since his personality is "playful instigator," not "lurking
      // judge"). Lower weight so the tree mostly belongs to Panther.
      weight: 2,
      apply: (c, now, w) => {
        let n = setActivity(c, 'on_post', 8000, now)
        n = setMood(n, pickMood('mushu', 'happy'), 2200, now)
        n.x = catTreeX(w)
        n.direction = 'L'
        return n
      },
    },
    {
      // Happy walk — was 6, dropped to 2.
      weight: 2,
      apply: (c, now) => {
        let n = setActivity(c, 'walk', 5000, now)
        n.direction = Math.random() < 0.5 ? 'L' : 'R'
        if (Math.random() < 0.5) n = setMood(n, pickMood('mushu', 'happy'), 1800, now)
        return n
      },
    },
    {
      // Brief sit + chirp — bumped to 5, longer 4s sit.
      weight: 5,
      apply: (c, now) => {
        let n = setActivity(c, 'sit', 4000, now)
        n = setMood(n, pickMood('mushu', 'excited'), 1800, now)
        return n
      },
    },
    {
      // Short nap (Mushu doesn't sleep much) — bumped to 4 / 12s.
      weight: 4,
      apply: (c, now) => {
        let n = setActivity(c, 'sleep', 12000, now)
        n = setMood(n, '💤', 2200, now)
        return n
      },
    },
    {
      // Bathroom break — zoomies fuel has to come out somewhere.
      weight: 1,
      apply: (c, now) => setActivity(c, 'pooped', 4500, now),
    },
  ],
  coco: [
    {
      // LONG nap — already dominant; bump weight to 9 + length to 35s.
      weight: 9,
      apply: (c, now) => {
        let n = setActivity(c, 'sleep', 35000, now)
        n = setMood(n, '😴', 2200, now, '💤')
        return n
      },
    },
    {
      // Loaf — bumped to 5 / 12s.
      weight: 5,
      apply: (c, now) => {
        let n = setActivity(c, 'loaf', 12000, now)
        n = setMood(n, '✨', 2200, now)
        return n
      },
    },
    {
      // Stretch (no walk after — was stretch+walk, dropped the walk)
      weight: 2,
      apply: (c, now) => {
        let n = setActivity(c, 'stretch', 1500, now)
        n = setMood(n, '🥱', 1500, now, '✨')
        return n
      },
    },
    {
      // Happy little walk — was 4, dropped to 1. Coco rarely moves.
      weight: 1,
      apply: (c, now) => {
        let n = setActivity(c, 'walk', 4500, now)
        n.direction = Math.random() < 0.5 ? 'L' : 'R'
        if (Math.random() < 0.3) n = setMood(n, '😻', 1800, now)
        return n
      },
    },
    {
      // iter-356.41: Coco occasionally claims the tree. She's mostly
      // a sleeper but when she does climb she stays up there a while.
      weight: 1,
      apply: (c, now, w) => {
        let n = setActivity(c, 'on_post', 18000, now)
        n = setMood(n, pickMood('coco', 'sleepy'), 2500, now, '💤')
        n.x = catTreeX(w)
        n.direction = 'L'
        return n
      },
    },
    {
      // Bathroom break — she does everything sleepily, even this.
      weight: 1,
      apply: (c, now) => setActivity(c, 'pooped', 4500, now),
    },
  ],
}

function rollSolo(c: CatState, now: number, w: number): CatState {
  const event = rollWeighted(SOLO_EVENTS[c.id], (e) => e.weight)
  return event ? event.apply(c, now, w) : c
}

// Anti-repeat wrapper (user feedback 2026-07-11 "contrived and
// repeating") — moved to catEngineCore.ts (Playground Slice A) with
// its full rationale comment; re-exported under the original test-seam
// name so CatLayer.test.tsx stays unchanged.
export const _rollWithoutImmediateRepeatForTests = rollWithoutImmediateRepeat
// Frames-30 variant wiring: unit surfaces for the gait-variant roll, the
// bout-entry state writer, and the plan builder (rotation and the sleep
// breathe/dream loops are engine behavior, not render behavior, so the
// tests pin them here instead of driving a full interaction scene).
export const _rollGaitVariantForTests = rollGaitVariant
export const _rollBoutVariantForTests = rollBoutVariant
export const _setActivityForTests = setActivity
export const _stepCatsForTests = stepCats
export const _animationPlanForForTests = (cat: CatState, now: number) =>
  animationPlanFor(cat, now)
export type _CatStateForTests = CatState

// Login is a tiny household vignette, not the app's quiet ambient mascot.
// Events are intentionally short and toy/prop-led so a new beat begins every
// few seconds without changing the calm app pool above.
function rollLoginSolo(c: CatState, now: number, w: number): CatState {
  const roll = Math.random()
  if (c.id === 'panther' && roll < 0.28) {
    let next = setActivity(c, 'on_post', 3200, now)
    next = setMood(next, '😾', 1900, now, '💢')
    next.x = catTreeX(w)
    next.direction = 'L'
    return next
  }
  if (c.id === 'coco' && roll < 0.24) {
    let next = setActivity(c, 'in_box', 2600, now)
    next = setMood(next, '😻', 1800, now, '✨')
    next.x = Math.max(8, w * 0.91 - SPRITE_WIDTH / 2)
    next.direction = 'L'
    return next
  }
  if (c.id !== 'panther' && roll < 0.56) {
    let next = setActivity(c, 'pounce', 1900, now)
    next = setMood(next, c.id === 'mushu' ? '😹' : '😻', 1700, now, c.id === 'mushu' ? '✨' : '💕')
    next.targetX = Math.max(8, w * 0.12 - SPRITE_WIDTH / 2)
    next.direction = c.x < next.targetX ? 'R' : 'L'
    return next
  }
  if (c.id === 'mushu' && roll < 0.82) {
    let next = setActivity(c, 'play', 1700, now)
    next = setMood(next, '🐾', 1600, now, '⚡')
    next.direction = c.x < w / 2 ? 'R' : 'L'
    return next
  }
  let next = setActivity(c, 'walk', rand(1700, 2900), now)
  next.direction = Math.random() < 0.5 ? 'L' : 'R'
  if (Math.random() < 0.7) {
    next = setMood(next, c.id === 'panther' ? '😼' : c.id === 'mushu' ? '😹' : '✨', 1500, now)
  }
  return next
}

// === Personality knobs (movement only — emotional outcomes are above) ========

// iter-356.41: cat tree x position (% of layer width). Matches
// HabitatBackground's <CatTree> CSS `left: {CAT_TREE_X_PCT * 100}%`.
// When a cat enters 'on_post' activity, its container snaps to this
// pixel x so the cat-on-tree PNG aligns with the empty tree below.
// iter-356.42: shifted from 0.75 → 0.70 to even out floor-object
// spacing. Pre-iter-356.42 the gap from bed (50%) to tree (75%) was
// ~25% while tree (75%) to box (right-6% ≈ 94%) was only ~19% — the
// row read as cluttered-right + empty-left-of-tree. Now the run is
// 50→70→93 (20% / 23%) which sits closer to even.
const CAT_TREE_X_PCT = 0.70
function catTreeX(w: number): number {
  // Account for the cat tree's render width (~SPRITE_WIDTH * 2.0) so
  // the cat sprite center aligns with the tree's center, not its left
  // edge. Cat tree is anchored by its left edge; we want the cat to
  // land roughly centered on the post.
  const treeRenderWidth = Math.max(60, Math.round(SPRITE_WIDTH * 2.0))
  return Math.round(w * CAT_TREE_X_PCT - (treeRenderWidth - SPRITE_WIDTH) / 2)
}

// iter-356.8 (mobile-desktop C1): pre-iter-356.8 SPRITE_WIDTH was a
// flat 36px — calibrated for a 375px mobile viewport (~9.6% width)
// but on a 4K monitor it shrinks to 0.9% of viewport — three
// pixel-dust specks crawling along a vast dark expanse. Now scaled
// against viewport width (~1.4%) and clamped [36, 72] so:
//  - mobile (375px): 36px (5px taller than 1.4% would give)
//  - 1440px laptop: 36px (same as floor)
//  - 2560px desktop: 36px (still floor)
//  - 3840px 4K:      54px (proportional)
//  - 5120px 5K:      72px (clamped)
// Recomputed at module-load only. Resize requires a page reload to
// pick up new SPRITE_WIDTH; acceptable since portrait↔landscape
// rotations on mobile are within the floor band.
const SPRITE_WIDTH = (() => {
  if (typeof window === 'undefined') return 36
  const w = window.innerWidth
  return Math.max(36, Math.min(72, Math.round(w * 0.014)))
})()
// iter-356.39: was `SPRITE_WIDTH * 24 / 36` (height = 0.667 × width,
// derived from the legacy SVG art's 3:2 viewBox). Curated PNG cats
// stand tail-up (~1.2 × width); a height-shorter-than-width container
// clipped them. Now: SPRITE_HEIGHT = 1.2 × SPRITE_WIDTH so the cat
// fills its container with no clipping.
const SPRITE_HEIGHT = Math.round(SPRITE_WIDTH * 1.2)
// Login reserves exactly this much layout space below its form. Keep this
// exported value as the single source of truth for the ambient floor height.
export const CAT_LAYER_HEIGHT = SPRITE_HEIGHT + 56
// iter-356.56 (Maya CRITICAL #2): bumped from 70 → 80 so the cats
// have an extra 10 px clearance above the BottomNav top edge. Maya
// flagged the cat-tail clipping into the BottomNav border on mobile
// as the single most "amateur" detail in the iter-356 polish thread:
// "the whole 'ambient cat' branding pillar collapses when cats overlap
// nav chrome." 80 px = BottomNav (~64 px) + 16 px breathing.
const LAYER_BOTTOM_OFFSET = 80 // mobile (above BottomNav)
const LAYER_BOTTOM_OFFSET_LG = 8 // desktop
const INTERACTION_DISTANCE = 50
const INTERACTION_COOLDOWN_MS = 5000
const LOGIN_INTERACTION_COOLDOWN_MS = 2800

// `rand` moved to catEngineCore.ts (Playground Slice A) — imported above.

// iter-356.28: layer width excludes the desktop SideNav rail (224px =
// w-56). Cats' x is local to the layer, so spawn + clamp + flee
// targets must use this not window.innerWidth — otherwise a cat
// spawned at viewport-x=1200 on a 1280px screen lands 200px past the
// 1056px-wide layer's right edge and the wall-bounce yanks it back.
function layerWidth(): number {
  if (typeof window === 'undefined') return 1024
  const isDesktop = window.matchMedia && window.matchMedia('(min-width: 1024px)').matches
  return window.innerWidth - (isDesktop ? 224 : 0)
}

// === COMPONENT ==============================================================

export interface CatLayerProps {
  placement?: 'app' | 'login'
}

export function CatLayer({ placement = 'app' }: CatLayerProps) {
  const [cats, setCats] = useState<CatState[]>(() => initialCats(placement))
  const lastGlobalInteractionRef = useRef<number>(0)
  const reducedMotion = usePrefersReducedMotion()
  // iter-356-E (Slice E): two more perf gates besides reduced-motion.
  // - reducedData: `prefers-reduced-data: reduce` — operator on a metered
  //   connection asked the OS to throttle bandwidth/CPU. Same code path
  //   as reduced-motion: short-circuit the rAF loop, render cats statically
  //   (brand stays visible).
  // - batteryLow: best-effort Battery Status API. < 20% AND not charging
  //   = pause the loop. listens for 'levelchange' + 'chargingchange' so
  //   plugging in resumes the cats. API is non-universal (Safari ships
  //   nothing) so the whole thing is wrapped in try + feature-detected.
  const reducedData = usePrefersReducedData()
  const batteryLow = useBatteryLow()
  const animationsPaused = reducedMotion || reducedData || batteryLow
  const walkEnhancementAllowed = useWalkEnhancementAllowed(!animationsPaused)

  useEffect(() => {
    if (animationsPaused) return
    let raf = 0
    let lastTs = performance.now()
    let visible = !document.hidden
    const onVis = () => {
      visible = !document.hidden
      lastTs = performance.now()
    }
    document.addEventListener('visibilitychange', onVis)

    const tick = (now: number) => {
      raf = requestAnimationFrame(tick)
      // iter-356.5 (mobile C2) → iter-356.21 (user "cats teleport"):
      // tightened from 100ms to 33ms (~2 missed frames). At 100ms a
      // chase tick was 1.5 * (100/16.6) ≈ 9 px in one frame which read
      // as a teleport when the tab regained focus or rAF stuttered.
      // 33ms caps a chase frame at ~3 px (still visible motion, never
      // a hop). iOS Low Power slow-motion is preserved — frames just
      // play out at half-speed instead of leaping.
      const dt = Math.min(now - lastTs, 33)
      lastTs = now
      if (!visible) return
      setCats((prev) => stepCats(prev, now, dt, lastGlobalInteractionRef, placement))
    }
    raf = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(raf)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [animationsPaused, placement])

  return (
    <div
      aria-hidden="true"
      data-testid="ambient-cat-layer"
      data-scene-tempo={placement === 'login' ? 'playful' : 'calm'}
      data-motion={animationsPaused ? 'static' : 'animated'}
      // iter-356.66 (round 2 — user "where are my little kitten
      // animations? why are they all gone?"): the previous -z-10 fix
      // hid the cats entirely behind <main>'s stacking context (the
      // overflow-y-auto on <main> creates a context that paints all
      // its descendants above any negative-z sibling). Restored to
      // z-[5] — visible above the page background, above the
      // transparent <main>'s own paint, but BELOW any content card
      // that opts into z-10 (e.g. LiveStats). That preserves the
      // ambient walking cats on every page while letting load-bearing
      // text panels block cats from sitting on top of them. Modals
      // (z-40+), BottomNav (z-10), ConnectionBanner (z-30), and the
      // WatchRibbon (z-15) all still sit above. */}
      className={`pointer-events-none overflow-hidden ${
        placement === 'login'
          ? 'absolute bottom-0 translate-y-[calc(-1*env(safe-area-inset-bottom,0px))]'
          : 'fixed'
      } ${
        placement === 'login' ? 'z-0 animate-cat-layer-enter' : 'z-[5]'
      }`}
      style={{
        height: `${CAT_LAYER_HEIGHT}px`,
        bottom:
          placement === 'login'
            ? undefined
            : `var(--cat-layer-bottom, ${LAYER_BOTTOM_OFFSET}px)`,
        // iter-356.28: respect SideNav rail on desktop so cats don't
        // walk across the "Sign out" button. SideNav is `w-56` (14rem)
        // and only mounted at lg:. Pre-iter-356.28 the layer was
        // inset-x-0 so the walking strip extended into the rail and
        // pixel cats sat on top of nav controls — confirmed visually
        // via browser-harness against the live tailnet PWA.
        left: placement === 'login' ? 0 : 'var(--cat-layer-left, 0px)',
        right: 0,
      }}
    >
      <style>{`
        /* iter-356.5 (mobile C1): include safe-area-inset-bottom so
           cats clear the iOS home indicator on standalone-installed
           PWA sessions. BottomNav uses pb-[env(safe-area-inset-bottom)]
           so its rendered height grows by ~34px on iPhone X+. Without
           this, cats walk behind the nav strip on every iPhone with
           a home indicator. */
        :root {
          --cat-layer-bottom: calc(${LAYER_BOTTOM_OFFSET}px + env(safe-area-inset-bottom, 0px));
          --cat-layer-left: 0px;
        }
        @media (min-width: 1024px) {
          :root {
            --cat-layer-bottom: ${LAYER_BOTTOM_OFFSET_LG}px;
            /* SideNav width = w-56 = 14rem. Cats walk in the content
               column only; rail stays clean. */
            --cat-layer-left: 14rem;
          }
        }
        @keyframes cat-mood-rise {
          0% { transform: translateX(-50%) translateY(2px) scale(0.6); opacity: 0; }
          12% { transform: translateX(-50%) translateY(-6px) scale(1.05); opacity: 1; }
          18% { transform: translateX(-50%) translateY(-8px) scale(1); opacity: 1; }
          78% { transform: translateX(-50%) translateY(-26px) scale(1); opacity: 1; }
          100% { transform: translateX(-50%) translateY(-42px) scale(0.85); opacity: 0; }
        }
        @keyframes cat-bounce {
          0%, 100% { transform: translateY(0); }
          25% { transform: translateY(-3px); }
          50% { transform: translateY(0); }
          75% { transform: translateY(-2px); }
        }
        @keyframes cat-shake {
          0%, 100% { transform: translateX(0) rotate(0); }
          25% { transform: translateX(-1px) rotate(-2deg); }
          75% { transform: translateX(1px) rotate(2deg); }
        }
        /* iter-356.6 — actual animation (user directive). Pre-iter-356.6
           cats translated horizontally but never moved vertically; they
           glided like skating Roombas. cat-walk-bob bobs the body 2 px
           every step (steps(2) for the 8-bit jerk). cat-breathe is a
           slow scaleY puff for sleeping cats — they look like they're
           actually breathing. Applied to a third nested wrapper inside
           the direction-flip wrapper so neither transform overrides
           the other. prefers-reduced-motion global at index.css:211
           collapses both to 0.01ms — covered for free. */
        /* iter-356.7: bumped from 2px / 240ms to 3px / 200ms for a
           more visible step. The steps(2) timing function still
           produces hard 8-bit jumps (no smooth interpolation),
           giving roughly 6 visible steps/sec which reads as walking
           rather than vibrating. The +1° / -1° rotate adds a subtle
           weight-shift lean alternating each frame — applied after
           the parent's scaleX flip so it looks correct in both
           directions. */
        @keyframes cat-walk-bob {
          0%   { transform: translateY(0)    rotate(-1deg); }
          50%  { transform: translateY(-3px) rotate(1deg);  }
          100% { transform: translateY(0)    rotate(-1deg); }
        }
        @keyframes cat-breathe {
          0%, 100% { transform: scale(1, 1); }
          50%      { transform: scale(1.04, 0.92); }
        }
      `}</style>
      {/* iter-356.30 (Pet Habitat slice 1): static habitat objects
          rendered BEHIND the cats so the cats walk on/over them.
          z-stack order is DOM-order within this fixed layer (no
          explicit z-index on the cats), so listing habitat first =
          rendered first = lower stacking. Pure decoration; no
          animation, no interaction (slice 4 adds bed-bob + toy-jiggle;
          slice 2 adds movement zones that target the bed / ledge /
          box positions). All objects are aria-hidden via the parent
          `<div aria-hidden="true">` so SR users never hear them. */}
      <HabitatBackground
        playful={placement === 'login' && !animationsPaused}
        yarnActive={cats.some((cat) => cat.activity === 'pounce')}
        boxActive={cats.some((cat) => cat.activity === 'in_box')}
      />
      {/* Ground poops (2026-07-11): spawned by stepCats when a squat
          bout COMPLETES, anchored in scene coordinates so they stay
          put while the cat walks away, then fade. Rendered before the
          cats (DOM order = z-order in this layer) so a cat can walk
          over its own handiwork. */}
      {cats.map(
        (cat) =>
          cat.poop && (
            <GroundPoop
              key={`${cat.id}-poop-${cat.poop.spawnedAt}`}
              x={cat.poop.x}
              bottom={cat.poop.y}
              size={Math.round(SPRITE_WIDTH * POOP_SIZE_FRAC)}
              visibleMs={cat.poop.fadeAt - cat.poop.spawnedAt}
            />
          ),
      )}
      {cats.map((cat) => (
        <CatRender
          key={cat.id}
          cat={cat}
          playful={placement === 'login' && !animationsPaused}
          walkAnimationEnabled={walkEnhancementAllowed}
        />
      ))}
    </div>
  )
}

// === HABITAT BACKGROUND =====================================================
//
// iter-356.30 (Pet Habitat Phase 1, slice 1): six decorative objects
// pinned to fixed % positions across the layer width. Positions are
// chosen so:
//   - Yarn ball, toy mouse, feather wand, cardboard box, floating bed
//     sit on the FLOOR (bottom-aligned) so cats walking past visually
//     read as on the same ground plane.
//   - Wall ledge sits at the TOP of the layer — cats can later perch
//     up there in slice 2's movement zones.
//   - Two of the six (yarn / mouse) sit at <20% and <30% so a cat
//     mid-walk can investigate them in slice 2; the cardboard box
//     anchors the right edge so it's a natural endpoint for "go nap
//     in the box."
//
// All positions are PERCENTAGES of layer width — auto-recompute on
// layout via CSS, no JS resize hook needed.
function HabitatBackground({
  playful,
  yarnActive,
  boxActive,
}: {
  playful: boolean
  yarnActive: boolean
  boxActive: boolean
}) {
  // Tuck the ledge near the top of the layer rather than the bottom.
  // Layer is `SPRITE_HEIGHT + 56` tall; ledge needs ~14 px and a
  // visual gap from the cats below it.
  const ledgeBottom = SPRITE_HEIGHT + 30
  return (
    <>
      {/* iter-356.34: shared opacity for habitat set-dressing. Mascots
          are the focal point at full opacity; habitat reads as backdrop
          decoration so the app still feels like a security tool. Per
          Maya's "yellow flower + blue paw cluster" critique + the
          user's "subtle enough that HomeCam still feels like a security
          app, not a toy app" mandate. */}
      {/* Wall ledge (top-of-layer, decorative) */}
      <div
        data-testid="habitat-ledge"
        style={{
          position: 'absolute',
          left: '6%',
          bottom: ledgeBottom,
          opacity: 0.7,
        }}
      >
        <WallLedge size={Math.max(56, Math.round(SPRITE_WIDTH * 2.2))} />
      </div>
      {/* iter-356.42: floor-object x-percent rebalance. Pre-iter-356.42
          the row was 14 / 30 / 50 / 75 / right-6% — left-clustered with
          a sparse mid-right band. Now: 12 / 28 / 48 / 70 / right-6% so
          adjacent objects sit at ~16-18% intervals across the layer
          width. Mobile (390px) reads as a balanced ground-line; desktop
          (1280-1920px) preserves the ledge → yarn → mouse → bed → tree
          → box composition without the dead-zone before the cat tree. */}
      {/* Yarn ball — left third of floor */}
      <div
        data-testid="habitat-yarn"
        data-active={yarnActive ? 'true' : 'false'}
        className={playful && yarnActive ? 'cat-yarn-swat' : undefined}
        style={{ position: 'absolute', left: '12%', bottom: 0, opacity: 0.78 }}
      >
        <YarnBall size={Math.max(20, Math.round(SPRITE_WIDTH * 0.6))} />
      </div>
      {/* Toy mouse — slightly right of yarn ball */}
      <div
        data-testid="habitat-mouse"
        style={{ position: 'absolute', left: '28%', bottom: 0, opacity: 0.78 }}
      >
        <ToyMouse size={Math.max(18, Math.round(SPRITE_WIDTH * 0.55))} />
      </div>
      {/* Floating bed — center, low oval so cats can be drawn on top later */}
      <div
        data-testid="habitat-bed"
        style={{ position: 'absolute', left: '48%', bottom: 0, opacity: 0.78 }}
      >
        <FloatingBed size={Math.max(34, Math.round(SPRITE_WIDTH * 1.05))} />
      </div>
      {/* Cardboard box — right edge anchor */}
      <div
        data-testid="habitat-box"
        data-active={boxActive ? 'true' : 'false'}
        className={playful && boxActive ? 'cat-box-rustle' : undefined}
        style={{ position: 'absolute', right: '6%', bottom: 0, opacity: 0.78 }}
      >
        <CardboardBox size={Math.max(28, Math.round(SPRITE_WIDTH * 0.85))} />
      </div>
      {/* iter-356.41: cat tree / scratching post. Positioned at ~75% of
          the layer width — to the right of the floating bed, before the
          cardboard box. Sized larger than other habitat objects (it's
          tall) so the climbing cats land on a believable perch. The
          on_post BodyState renders the cat-on-tree PNG OVER this
          empty-tree image at the same x; the empty tree is drawn at
          full opacity so it reads as a fixed feature in the layer. */}
      <div
        data-testid="habitat-cat-tree"
        style={{
          position: 'absolute',
          left: `${CAT_TREE_X_PCT * 100}%`,
          bottom: 0,
          opacity: 0.92,
        }}
      >
        <CatTree size={Math.max(60, Math.round(SPRITE_WIDTH * 2.0))} />
      </div>
    </>
  )
}

// iter-356.6 (perf A3): React.memo around the per-cat render. Combined
// with the perf A2 bail-out in stepCats, when no cat actually moves
// the parent's setCats early-returns prev → 3 CatRender calls also
// short-circuit (memo shallow-compares by `cat` object reference).
// Net: 0 evaluations/sec instead of 180/sec during long sleep states.
const CatRender = memo(CatRenderImpl)

// PoseGroup + POSE_TRANSITIONS moved to catEngineCore.ts (Playground
// Slice A). The Activity→PoseGroup binding below stays CatLayer's own.
const POSE_GROUP_BY_ACTIVITY: Record<Activity, PoseGroup> = {
  walk: 'walking',
  chase: 'walking',
  flee: 'walking',
  sit: 'seated',
  judge: 'seated',
  loaf: 'seated',
  snuggle: 'seated',
  groom: 'seated',
  in_box: 'seated',
  sleep: 'sleeping',
  stretch: 'crouched',
  play: 'crouched',
  pounce: 'crouched',
  on_post: 'crouched',
  // 'crouched' so the existing crouch_down/crouch_up chains do the
  // squat entry/exit for free — no bespoke transition sequences.
  pooped: 'crouched',
  hiss: 'standing',
  scared: 'standing',
  // standing so the rise chains (crouch_up + seated_to_stand) play on the
  // way out of the squat before the kicks.
  kick_dirt: 'standing',
}

const ACTIVITY_ENTRY_SEQUENCES: Partial<Record<Activity, readonly CatAnimSequenceName[]>> = {
  on_post: ['jump_post'],
  // Frames-30: loafing now EARNS its shape — the slump chain slides from
  // seated into the bread pose instead of faking loaf with the seated
  // hold. Exit plays the seated-group chains from their usual start; the
  // slump_b→sit_m5 step reads as the cat pushing up out of the loaf.
  loaf: ['slump_to_loaf'],
  // Frames-30 wave 2: the post-poop dirt-kick beat — the kicks are the
  // entry choreography, then the cat holds side_stand until expiry.
  kick_dirt: ['kick_dirt'],
}

export function _catSequenceNamesForTransitionForTests(
  from: Activity,
  to: Activity,
): readonly CatAnimSequenceName[] {
  const fromGroup = POSE_GROUP_BY_ACTIVITY[from]
  const toGroup = POSE_GROUP_BY_ACTIVITY[to]
  if (to === 'scared') return []
  if (to === 'hiss') {
    return fromGroup === 'walking'
      ? ['walk_to_front', 'hiss_windup']
      : ['hiss_windup']
  }
  return [
    ...POSE_TRANSITIONS[fromGroup][toGroup],
    ...(ACTIVITY_ENTRY_SEQUENCES[to] ?? []),
  ]
}

// frameFromSteps / transitionFrame / uniqueFrames / AnimationPlan
// moved to catEngineCore.ts (Playground Slice A).

const ONGOING_SEQUENCE_BY_ACTIVITY: Partial<Record<Activity, CatAnimSequenceName>> = {
  walk: 'walk',
  // chase/flee resolve through CatState.boutVariant (rolled per bout);
  // 'run' here is the fallback and the timelineActive signal.
  chase: 'run',
  flee: 'run',
  groom: 'groom_bout',
  play: 'pounce',
  pounce: 'pounce',
  pooped: 'poop_squat', // loops while active — comedic quickening strain
  // Frames-30: sleeping cats breathe (1.4s in / 1.4s out) instead of
  // freezing on the static curl. stepCats quantizes phaseTime to 700ms
  // buckets during sleep so the loop doesn't undo the perf-A2 bail-out.
  sleep: 'sleep_breathe',
}

// Which pivot plays when a gaited activity reverses direction. Only
// these three route through the turn-around; everything else (pounce
// targeting, seated re-facing) keeps the soft 220ms flip — front-facing
// poses are near-symmetric so a pivot would be invisible work.
const TURN_SEQUENCE_BY_ACTIVITY: Partial<Record<Activity, CatAnimSequenceName>> = {
  walk: 'turn_around',
  chase: 'turn_around_fast',
  flee: 'turn_around_fast',
}

const HOLD_FRAME_BY_ACTIVITY: Partial<Record<Activity, CatAnimFrame>> = {
  sit: 'seated',
  judge: 'seated',
  // Frames-30: the loaf finally holds an actual loaf pose (slump chain's
  // end frame) instead of borrowing `seated`.
  loaf: 'slump_b',
  snuggle: 'seated',
  in_box: 'seated',
  sleep: 'sleep',
  stretch: 'crouch',
  kick_dirt: 'side_stand',
}

// Playground Slice A: the plan builder is now the shared, activity-
// agnostic catEngineCore.animationPlanFor. This binding supplies
// CatLayer's own Activity maps (including the hiss/scared special
// cases inside _catSequenceNamesForTransitionForTests).
const CAT_LAYER_ANIM_MAPS: AnimActivityMaps<Activity> = {
  transitionNamesFor: _catSequenceNamesForTransitionForTests,
  ongoingSequenceByActivity: ONGOING_SEQUENCE_BY_ACTIVITY,
  holdFrameByActivity: HOLD_FRAME_BY_ACTIVITY,
  sequences: CAT_ANIM_SEQUENCES,
}

function animationPlanFor(cat: CatState, now: number): AnimationPlan {
  // Frames-30: a rolled bout variant replaces the activity's base ongoing
  // sequence for this bout (gallop pick, groom target, strained squat,
  // tumbling pounce). The override object is tiny and only allocated for
  // cats whose activity carries a variant.
  if (cat.boutVariant && cat.boutVariant !== ONGOING_SEQUENCE_BY_ACTIVITY[cat.activity]) {
    return buildAnimationPlan(cat, now, {
      ...CAT_LAYER_ANIM_MAPS,
      ongoingSequenceByActivity: {
        ...ONGOING_SEQUENCE_BY_ACTIVITY,
        [cat.activity]: cat.boutVariant,
      },
    })
  }
  return buildAnimationPlan(cat, now, CAT_LAYER_ANIM_MAPS)
}

function CatRenderImpl({
  cat,
  playful,
  walkAnimationEnabled,
}: {
  cat: CatState
  playful: boolean
  walkAnimationEnabled: boolean
}) {
  const Sprite =
    cat.id === 'panther'
      ? BombaySprite
      : cat.id === 'mushu'
        ? TuxedoSprite
        : CalicoSprite
  const plan = animationPlanFor(cat, cat.phaseTime)
  // Turn-around pivot: while stepCats holds a live pivot, its frame
  // overrides the gait loop and its facing (old heading first half,
  // new heading second half) overrides cat.direction. Gaited cats also
  // preload the pivot frames up front — for the common sit→walk entry
  // they're already in the bridge set, so the set (and its cache key)
  // is unchanged; only a gait→gait re-roll grows it.
  const turnName = TURN_SEQUENCE_BY_ACTIVITY[cat.activity]
  const turnSteps = turnName ? CAT_ANIM_SEQUENCES[turnName][cat.id] : null
  const turnView =
    cat.turn && turnSteps ? turnPivotView(turnSteps, cat.turn, cat.phaseTime) : null
  const pivotActive = turnView !== null && !turnView.done
  const framesToPreload = turnSteps
    ? Array.from(new Set([...plan.framesToPreload, ...turnSteps.map((step) => step.frame)]))
    : plan.framesToPreload
  const animationReady = useAnimationFramesReady(
    cat.id,
    framesToPreload,
    walkAnimationEnabled,
  )
  // Phase comes from CatState (computed in stepCats), not from a
  // render-time performance.now() read. Before all 12 frames load—or
  // after any frame errors—activityToSprite keeps the old two-pose
  // alternation visible, so the cat never disappears.
  const spriteState = activityToSprite(cat.activity, cat.phase)
  const richFrame = animationReady ? (pivotActive ? turnView.frame : plan.frame) : null
  const walkFrame =
    animationReady && !pivotActive ? plan.walkFrame : undefined
  const facing = pivotActive ? turnView.facing : cat.direction
  // Per-activity micro-animation
  const microAnim =
    cat.activity === 'play'
      ? 'cat-bounce 360ms ease-in-out infinite'
      : cat.activity === 'hiss' || cat.activity === 'scared'
        ? 'cat-shake 240ms ease-in-out infinite'
        : undefined
  // iter-356.4-cats-2: particle overlays. Keyed by activityUntil so
  // each activity transition starts a fresh ~2.4s burst (CatParticles
  // self-hides after that). Activities without a particle map render
  // nothing.
  const particleSpec = activityToParticles(cat.activity)
  return (
    <div
      style={{
        position: 'absolute',
        // iter-356.6 (perf B1): GPU-compositor path for horizontal
        // motion. Pre-iter-356.6 we animated `left: cat.x` which
        // triggers main-thread layout recalculation on every 80ms
        // transition tick. `transform: translateX(...)` is composited
        // off-thread — on Frank's mid-range Android the difference
        // is roughly 16ms vs 20+ms frames during a chase / multi-cat
        // walk. Vertical (`bottom: cat.y`) stays static (cats never
        // change y) so leaving it on the layout system is fine.
        left: 0,
        bottom: cat.y,
        width: SPRITE_WIDTH,
        height: SPRITE_HEIGHT,
        transform: `translateX(${cat.x}px)`,
        // iter-356.21: dropped `transition: transform 80ms linear`.
        // The CSS transition was QUEUEING an 80ms ease between every
        // ~16ms React state update, which the browser collapsed into
        // jittery catch-up jumps the user reported as "teleport." With
        // the rAF loop driving translateX directly per frame, no CSS
        // interpolation is needed — the animation IS the per-frame
        // updates. willChange stays so the compositor still promotes
        // the layer.
        willChange: 'transform',
        animation: microAnim,
      }}
    >
      <div
        data-testid="cat-ground-shadow"
        style={{
          position: 'absolute',
          left: '12%',
          bottom: 1,
          width: '76%',
          height: 7,
          borderRadius: '50%',
          background: 'rgba(43,34,19,0.16)',
          filter: 'blur(1.5px)',
          transform: cat.activity === 'pounce' ? 'scaleX(0.72)' : 'scaleX(1)',
          transformOrigin: 'center',
        }}
      />
      {/* The poop prop no longer renders here (2026-07-11): it became
          a GROUND OBJECT with its own lifecycle — spawned by stepCats
          when the squat COMPLETES and rendered by CatLayer itself in
          scene coordinates (components/GroundPoop.tsx), so it stays
          put after the cat walks away. */}
      {/* Entrance wrapper — MUST stay a separate element from the
          direction-flip div below. `cat-arrive-*` animations use
          `fill: both`, and a filled CSS animation overrides inline
          `transform` on its own element FOREVER after it finishes.
          When this class lived on the flip div, Panther's arrive-left
          fill pinned her at its final keyframe permanently, so
          `cat.direction` was ignored and she faced RIGHT while
          walking left (user-reported 2026-07-11). */}
      <div
        className={playful ? `cat-micro-life cat-entrance-${cat.id}` : undefined}
        data-testid="cat-entrance-wrapper"
        style={{ width: '100%', height: '100%' }}
      >
      <div
        data-testid="cat-direction-flip"
        style={{
          width: '100%',
          height: '100%',
          // iter-356.39: curated sprite-sheet PNGs face LEFT by default
          // (Panther's head visible on the LEFT side of walk_a). Pre-iter
          // the SVG art faced RIGHT so direction='L' got the scaleX(-1)
          // flip; now direction='R' needs the flip instead. `facing`
          // is cat.direction except mid-pivot, where the turn-around
          // choreography owns which way the art points.
          transform: facing === 'R' ? 'scaleX(-1)' : undefined,
          transformOrigin: 'center',
          // iter-356.40: smooth scaleX flip when a cat changes direction
          // mid-walk OR when an activity transition sets a new direction.
          // SAFE here because this div has NO translateX (translate is
          // on the parent container — see iter-356.21 sharp edge). Was
          // an instant 180° pop that read as a teleport.
          // 2026-07-11: during a turn-around pivot the flip must be
          // INSTANT — it lands exactly on the symmetric frontal `stand`
          // frame, so the mirror seam is invisible; easing it would
          // paint the very morph the pivot replaces.
          transition: pivotActive ? 'none' : 'transform 220ms ease-in-out',
        }}
      >
        {/* iter-356.6: third nested wrapper — animation goes here so
            it doesn't fight the parent's scaleX flip. walk/chase/flee
            bob; sleep breathes; everything else stays still. */}
        <div
          style={{
            width: '100%',
            height: '100%',
            transformOrigin: 'center',
            animation: spriteAnim(cat.activity),
          }}
        >
          {/* iter-356.39: pass `size = SPRITE_WIDTH` (was SPRITE_HEIGHT).
              RasterSprite now renders IMG at `width=size, height=size*1.2`,
              matching the container's SPRITE_WIDTH × SPRITE_HEIGHT
              dimensions exactly. */}
          {richFrame ? (
            <img
              src={catAnimFrameUrl(cat.id, richFrame)}
              alt=""
              width={SPRITE_WIDTH}
              height={SPRITE_HEIGHT}
              data-testid="cat-sprite"
              data-cat-id={cat.id}
              data-cat-state={spriteState}
              data-anim-frame={richFrame}
              data-walk-frame={walkFrame === undefined ? undefined : walkFrame + 1}
              decoding="async"
              loading="lazy"
              className="cat-sprite-img"
              style={{ objectFit: 'contain', objectPosition: 'center bottom', display: 'block' }}
            />
          ) : (
            <Sprite
              size={SPRITE_WIDTH}
              state={spriteState}
              walkFrame={walkFrame}
            />
          )}
        </div>
      </div>
      </div>
      {cat.mood && (
        <CatMoodBubble
          key={`${cat.id}-${cat.moodUntil}`}
          catId={cat.id}
          mood={cat.mood}
          moodSecondary={cat.moodSecondary}
        />
      )}
      {particleSpec && (
        <CatParticles
          key={`${cat.id}-${cat.activity}-${cat.activityUntil}`}
          type={particleSpec.type}
          x={particleSpec.x}
          y={particleSpec.y}
          count={particleSpec.count}
        />
      )}
    </div>
  )
}

// Cat-personalized mood bubble (user directive 2026-07-11): renders
// THIS cat's face wearing the emotion instead of a generic emoji.
// moodBadgeParts picks the first face glyph with an exported badge;
// symbols (💤 ✨ 💢 …) stay text. Fallback chain: no badge mapped →
// original emoji string; badge img fails to load → original emoji.
function CatMoodBubble({
  catId,
  mood,
  moodSecondary,
}: {
  catId: CatId
  mood: string
  moodSecondary: string | null
}) {
  const [imgFailed, setImgFailed] = useState(false)
  const parts = moodBadgeParts(catId, mood)
  const useBadge = parts.src !== null && !imgFailed
  return (
    <span
      style={{
        position: 'absolute',
        left: '50%',
        top: -10,
        fontSize: 18,
        lineHeight: 1,
        whiteSpace: 'nowrap',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 1,
        animation: 'cat-mood-rise 2200ms ease-out forwards',
        pointerEvents: 'none',
        // Sunroom redesign (2026-07-01): warm ink shadow at low
        // alpha — the old rgba(0,0,0,0.6) was tuned for the dark
        // theme and read as a hard black smudge on the linen bg.
        filter: 'drop-shadow(0 1px 2px rgba(43,34,19,0.35))',
      }}
    >
      {useBadge ? (
        <>
          <img
            src={parts.src ?? undefined}
            alt={parts.face ?? ''}
            width={20}
            height={20}
            decoding="async"
            data-testid="cat-mood-badge"
            style={{ display: 'block' }}
            onError={() => setImgFailed(true)}
          />
          {parts.rest}
        </>
      ) : (
        mood
      )}
      {moodSecondary && <span style={{ marginLeft: 1 }}>{moodSecondary}</span>}
    </span>
  )
}

// iter-356.6: per-activity sprite animation. Returns CSS animation
// shorthand or undefined. Static SVG sprites are framed once per
// pose; this layer adds inter-frame motion (bob/breathe) so the
// cats look ALIVE rather than skating across the screen.
function spriteAnim(activity: Activity): string | undefined {
  switch (activity) {
    case 'walk':
      return 'cat-walk-bob 570ms steps(2) infinite'
    case 'chase':
    case 'flee':
      // Faster cadence for chase/flee — the urgency reads as a
      // sprint vs a normal walk. Same keyframe; tighter period.
      return 'cat-walk-bob 150ms steps(2) infinite'
    case 'sleep':
      return 'cat-breathe 2600ms ease-in-out infinite'
    default:
      return undefined
  }
}

// iter-356.4-cats-2: route Activity → BodyState. Activities without a
// dedicated pose collapse to the closest neighbour. Keep this in sync
// with CatIcons' BodyState union.
// Phase drives the 12-frame walk cycle and the built-in two-pose
// fallback. Sitting activities continue to use it for the tail flick.
function activityToSprite(
  activity: Activity,
  phase: number,
):
  | 'walk'
  | 'walk2'
  | 'sit'
  | 'sit2'
  | 'sleep'
  | 'hiss'
  | 'groom'
  | 'stretch'
  | 'play'
  | 'on_post' {
  switch (activity) {
    case 'sleep':
      return 'sleep'
    case 'stretch':
    case 'pooped': // closest built-in fallback pose to the squat
      return 'stretch'
    case 'groom':
      return 'groom'
    case 'hiss':
      return 'hiss'
    case 'play':
    case 'pounce':
      return 'play'
    case 'in_box':
      return phase === 0 ? 'sit' : 'sit2'
    case 'on_post':
      return 'on_post'
    case 'chase':
    case 'flee':
    case 'walk':
    case 'kick_dirt': // standing-side fallback until frames preload
      return phase % 2 === 0 ? 'walk' : 'walk2'
    case 'sit':
    case 'judge':
    case 'loaf':
    case 'snuggle':
    case 'scared':
      return phase === 0 ? 'sit' : 'sit2'
  }
}

// Per-activity phase cadence, driven exclusively by the existing rAF
// timestamp. Normal walks use ~10fps; chase/flee run at ~27fps. Static
// poses stay at zero and sitting keeps its 600ms two-frame tail flick.
function phaseFor(activity: Activity, now: number): number {
  switch (activity) {
    case 'walk':
      return Math.floor(now / (CYCLE_DURATION_MS.walk / WALK_FRAME_COUNT)) % WALK_FRAME_COUNT
    case 'chase':
    case 'flee':
      // Tween wave 2: the gallop is 4 frames per 150ms cycle now.
      return Math.floor(now / (CYCLE_DURATION_MS.run / 4)) % 4
    case 'sit':
    case 'judge':
    case 'loaf':
    case 'snuggle':
    case 'scared':
      return Math.floor(now / 600) % 2
    default:
      return 0
  }
}

// iter-356.4-cats-2: per-activity particle specs. Origin is the cat's
// own bottom-left; +x = rightward across the sprite, +y = upward
// above the ground (cat is SPRITE_HEIGHT tall).
function activityToParticles(
  activity: Activity,
): { type: CatParticleType; x: number; y: number; count: number } | null {
  switch (activity) {
    case 'groom':
      // Hearts above head (sit pose head sits ~y=22)
      return { type: 'hearts', x: SPRITE_WIDTH / 2, y: 22, count: 6 }
    case 'snuggle':
      // iter-356.12 (Maya 8th sweep MAJOR): dropped from 5 → 2 per
      // cat. Two snuggling cats × 5 sparkles = 10 nodes for 4.5s,
      // combined with the rising 😻💕 mood emoji = ~14 animated
      // nodes in a 100×30px area. Visual noise. The mood emoji
      // carries the affection signal; particles are background flair.
      return { type: 'sparkles', x: SPRITE_WIDTH / 2, y: 18, count: 2 }
    case 'hiss':
      // Anger pulses near head
      return { type: 'anger', x: SPRITE_WIDTH / 2, y: 24, count: 3 }
    case 'chase':
    case 'flee':
      // Dust puffs near feet, behind direction of motion
      return { type: 'dust', x: SPRITE_WIDTH / 2 - 4, y: 4, count: 4 }
    case 'sleep':
      // Z's drifting up from the head (sleep pose head is to one side)
      return { type: 'zzz', x: SPRITE_WIDTH / 2 + 2, y: 12, count: 3 }
    case 'play':
    case 'pounce':
      // Tiny sparkle puff for zoomies/play
      return { type: 'sparkles', x: SPRITE_WIDTH / 2, y: 20, count: 3 }
    default:
      return null
  }
}

// === STATE-MACHINE LOOP =====================================================

function initialCats(placement: 'app' | 'login'): CatState[] {
  const w = layerWidth()
  const ids: CatId[] = ['panther', 'mushu', 'coco']
  const now = performance.now()
  return ids.map((id, i) => ({
    id,
    x: placement === 'login'
      ? [18, w - SPRITE_WIDTH - 18, w * 0.88][i]
      : (w / 4) * (i + 1) + rand(-30, 30),
    y: 0,
    direction: placement === 'login' ? (i === 0 ? 'R' : 'L') : (Math.random() < 0.5 ? 'L' : 'R'),
    // Enter already in-frame and at rest. After this short settling
    // beat the existing personality state machine lets each cat wander.
    // The nested CSS entrance supplies the opening trot/box pop without
    // spending React work during first-paint and form submission. The
    // high-energy scheduler takes over after this gentle two-second beat.
    activity: placement === 'login' ? (id === 'coco' ? 'in_box' : 'sit') : (id === 'coco' ? 'loaf' : 'sit'),
    previousActivity: placement === 'login' ? (id === 'coco' ? 'in_box' : 'sit') : (id === 'coco' ? 'loaf' : 'sit'),
    activityStartedAt: now,
    activityUntil: now + (placement === 'login' ? rand(1900, 2400) : rand(1400, 2600)),
    mood: placement === 'login' ? (id === 'panther' ? '👀' : id === 'mushu' ? '🐾' : '✨') : null,
    moodSecondary: null,
    moodUntil: placement === 'login' ? now + 1800 : 0,
    targetX: null,
    lastInteractedWith: null,
    lastInteractedAt: 0,
    phase: 0,
    phaseTime: now,
    idleSequence: null,
    idleSequenceStartedAt: 0,
    nextIdleLifeAt: now + rand(3000, 7000),
    lastIdleLifeWasSpecial: false,
    poop: null,
    turn: null,
    boutVariant: null,
  }))
}

const SEATED_IDLE_ACTIVITIES = new Set<Activity>([
  'sit',
  'judge',
  'loaf',
  'snuggle',
])

const SEATED_IDLE_CHOICES: Record<CatId, readonly { name: CatAnimSequenceName; weight: number }[]> = {
  // Frames-30: tailwrap_settle joins every pool — the tail sweeping in to
  // wrap the paws is the classic settled-cat beat.
  panther: [
    { name: 'blink', weight: 12 },
    { name: 'tailflick', weight: 4 },
    { name: 'tailwrap_settle', weight: 2 },
    { name: 'groom_bout', weight: 2 },
    { name: 'yawn', weight: 1 },
  ],
  mushu: [
    { name: 'blink', weight: 12 },
    { name: 'tailflick', weight: 4 },
    { name: 'tailwrap_settle', weight: 2 },
    { name: 'groom_bout', weight: 3 },
    { name: 'yawn', weight: 1 },
  ],
  coco: [
    { name: 'tailflick', weight: 8 },
    { name: 'tailwrap_settle', weight: 2 },
    { name: 'groom_bout', weight: 3 },
    { name: 'yawn', weight: 1 },
  ],
}

function pickSeatedIdleSequence(catId: CatId): CatAnimSequenceName {
  const choices = SEATED_IDLE_CHOICES[catId]
  return rollWeighted(choices, (choice) => choice.weight)?.name
    ?? choices[choices.length - 1].name
}

function isSpecialIdleSequence(name: CatAnimSequenceName): boolean {
  return name !== 'blink'
}

function stepCats(
  cats: CatState[],
  now: number,
  dt: number,
  lastGlobalRef: { current: number },
  placement: 'app' | 'login',
): CatState[] {
  const w = layerWidth()
  const dtNorm = dt / 16.6 // per 60fps frame
  // iter-356.6 (perf A2): bail-out tracking. The pre-iter-356.6 map
  // unconditionally allocated a new object per cat per frame, so
  // setCats fired 60×/sec even when all 3 cats were in long sleep
  // states (Coco can sleep for 22 s, Panther for 18 s) — React
  // reconciled the 3-element list 60×/sec for nothing. Now: we
  // track per-cat whether ANYTHING changed (mood expired, x moved,
  // direction bounced, activity transitioned). If no cat changed,
  // we return the original `cats` array reference and React's state
  // updater bails out of re-render entirely. Combined with
  // React.memo(CatRender), this drops static-state evaluation cost
  // from 180/sec to 0/sec.
  let anyChanged = false
  const stepped = cats.map((cat) => {
    let {
      x,
      direction,
      mood,
      moodSecondary,
      idleSequence,
      idleSequenceStartedAt,
      nextIdleLifeAt,
      lastIdleLifeWasSpecial,
    } = cat
    const { y, activity, activityUntil, moodUntil, targetX } = cat
    const transitionNames = _catSequenceNamesForTransitionForTests(
      cat.previousActivity,
      activity,
    )
    const transitionDuration = transitionNames.reduce(
      (total, name) => total + sequenceDurationMs(CAT_ANIM_SEQUENCES[name][cat.id]),
      0,
    )
    const locomotionReady = now - cat.activityStartedAt >= transitionDuration
    let catChanged = false
    if (mood && now > moodUntil) {
      mood = null
      moodSecondary = null
      catChanged = true
    }
    // Ground poop lifecycle: leaves state once visible window + fade
    // have fully played out (the fade itself is CSS — no re-renders
    // between spawn and removal).
    let poop = cat.poop
    if (poop && groundPoopExpired(poop, now)) {
      poop = null
      catChanged = true
    }
    // Turn-around pivot: expire a finished one before movement so the
    // cat resumes on the same tick the pivot completes.
    let turn = cat.turn
    const turnName = TURN_SEQUENCE_BY_ACTIVITY[activity]
    if (turn && turnName) {
      if (turnPivotView(CAT_ANIM_SEQUENCES[turnName][cat.id], turn, now).done) turn = null
    } else if (turn) {
      // Activity changed without setActivity clearing it (defensive).
      turn = null
    }
    const oldX = x
    const oldDir = direction
    // A pivoting cat PLANTS — paws stop while it whips around, then the
    // gait resumes on the new heading. `!turn` gates only the gaited
    // movers; pounce/play keep their soft flip.
    if (activity === 'walk' && locomotionReady && !turn) {
      const distance = gaitVelocityPxPerMs('walk', SPRITE_WIDTH) * dt
      x += direction === 'R' ? distance : -distance
    } else if (activity === 'chase' && locomotionReady && !turn) {
      const distance = gaitVelocityPxPerMs('run', SPRITE_WIDTH) * dt
      x += direction === 'R' ? distance : -distance
    } else if (activity === 'flee' && locomotionReady && !turn) {
      const distance = gaitVelocityPxPerMs('run', SPRITE_WIDTH) * dt
      x += direction === 'R' ? distance : -distance
    } else if (activity === 'pounce' && targetX !== null && locomotionReady) {
      const distance = targetX - x
      if (Math.abs(distance) > 2) {
        direction = distance > 0 ? 'R' : 'L'
        x += Math.sign(distance) * Math.min(Math.abs(distance), 1.35 * dtNorm)
      }
    } else if (activity === 'play') {
      x += direction === 'R' ? 0.2 * dtNorm : -0.2 * dtNorm
    }
    if (x < 8) {
      x = 8
      if (direction === 'L') {
        direction = 'R'
        if (turnName && locomotionReady && !turn) turn = { startedAt: now, from: 'L', to: 'R' }
      }
    } else if (x > w - SPRITE_WIDTH - 8) {
      x = w - SPRITE_WIDTH - 8
      if (direction === 'R') {
        direction = 'L'
        if (turnName && locomotionReady && !turn) turn = { startedAt: now, from: 'R', to: 'L' }
      }
    }
    if (x !== oldX || direction !== oldDir || turn !== cat.turn) catChanged = true
    // Per-activity sprite-frame phase. Only counts as a change when the
    // value flips, so a sleeping cat (always phase=0) stays ref-stable;
    // sitting updates every 600ms, walking every 100ms, and a chase or
    // flee every ~38ms (moving cats already update because x changes).
    const newPhase = phaseFor(activity, now)
    if (newPhase !== cat.phase) catChanged = true
    const timelineActive =
      now - cat.activityStartedAt < transitionDuration ||
      ONGOING_SEQUENCE_BY_ACTIVITY[activity] !== undefined ||
      idleSequence !== null ||
      turn !== null
    let phaseTime = timelineActive ? now : cat.phaseTime

    if (SEATED_IDLE_ACTIVITIES.has(activity)) {
      if (idleSequence) {
        const duration = sequenceDurationMs(CAT_ANIM_SEQUENCES[idleSequence][cat.id])
        if (now - idleSequenceStartedAt >= duration) {
          idleSequence = null
          nextIdleLifeAt = now + rand(3000, 7000)
          catChanged = true
        }
      } else if (now >= nextIdleLifeAt) {
        if (lastIdleLifeWasSpecial) {
          idleSequence = cat.id === 'coco' ? null : 'blink'
          lastIdleLifeWasSpecial = false
        } else {
          idleSequence = pickSeatedIdleSequence(cat.id)
          // Frames-30 wave 2: ~25% of yawns end in a blep. Separate roll
          // (picker keeps its one-Math.random contract).
          if (idleSequence === 'yawn' && Math.random() < 0.25) idleSequence = 'yawn_blep'
          lastIdleLifeWasSpecial = isSpecialIdleSequence(idleSequence)
        }
        idleSequenceStartedAt = now
        nextIdleLifeAt = now + rand(3000, 7000)
        catChanged = true
      }
    } else if (activity === 'sleep') {
      // Frames-30: rare mid-sleep idle — a dream twitch every 8–20s rides
      // on top of the breathing loop, reusing the seated scheduler's
      // fields (sleep entry seeds nextIdleLifeAt into the 8–20s band).
      if (idleSequence) {
        const duration = sequenceDurationMs(CAT_ANIM_SEQUENCES[idleSequence][cat.id])
        if (now - idleSequenceStartedAt >= duration) {
          idleSequence = null
          nextIdleLifeAt = now + rand(8000, 20000)
          catChanged = true
        }
      } else if (now >= nextIdleLifeAt) {
        idleSequence = 'dream_twitch'
        idleSequenceStartedAt = now
        nextIdleLifeAt = now + rand(8000, 20000)
        catChanged = true
      }
    } else if (idleSequence) {
      idleSequence = null
      catChanged = true
    }
    // Frames-30 sleep_breathe perf guard: the breathing loop's frames are
    // 1400ms each, so a sleeping cat's timeline only needs ~1.4 updates/s
    // — quantize phaseTime to 700ms buckets (2 samples per breath frame,
    // boundaries land exactly) so the perf-A2 bail-out keeps skipping
    // 60fps re-renders through long sleeps. Dream twitches and the
    // curl-down transition play un-quantized.
    if (
      activity === 'sleep' &&
      idleSequence === null &&
      turn === null &&
      now - cat.activityStartedAt >= transitionDuration
    ) {
      phaseTime =
        cat.activityStartedAt +
        Math.floor((now - cat.activityStartedAt) / 700) * 700
    }
    if (phaseTime !== cat.phaseTime) catChanged = true
    // Activity expiry → roll a solo event for the next state. This
    // ALWAYS counts as a change because rollSolo returns a new state.
    if (now > activityUntil) {
      // A completed squat pays off: the poop lands ON THE GROUND at the
      // cat's trailing edge as the bout ends (NOT at bout start), and
      // outlives the activity — the next beat walks away from it.
      const poopAfter =
        activity === 'pooped'
          ? { ...spawnGroundPoop(x, direction, SPRITE_WIDTH, now), y }
          : poop
      const base = { ...cat, x, y, direction, activity, activityUntil, mood, moodSecondary, moodUntil, targetX: null, phase: newPhase, phaseTime, idleSequence, idleSequenceStartedAt, nextIdleLifeAt, lastIdleLifeWasSpecial, poop: poopAfter, turn }
      // Frames-30 wave 2: a finished squat exits through the dirt-kick
      // beat — the poop has ALREADY spawned above (same tick as before,
      // GroundPoop timing untouched); the cat rises and kicks over the
      // spot, and the NEXT expiry rolls a normal solo. 2600ms nominal
      // covers rise chains (983ms) + kicks (721ms) even at the -22%
      // duration-jitter floor.
      if (activity === 'pooped') {
        anyChanged = true
        return setActivity(base, 'kick_dirt', 2600, now)
      }
      const next = _rollWithoutImmediateRepeatForTests(
        placement === 'login' ? rollLoginSolo : rollSolo,
        base,
        now,
        w,
      )
      anyChanged = true
      // A gait→gait re-roll that reverses heading (walk→walk with a
      // fresh random direction) is the other way a cat "turns around"
      // — give it the same pivot the wall bounce gets. setActivity
      // cleared next.turn, so this is the only writer.
      if (
        TURN_SEQUENCE_BY_ACTIVITY[next.activity] &&
        turnName &&
        next.direction !== direction
      ) {
        return { ...next, turn: { startedAt: now, from: direction, to: next.direction } }
      }
      return next
    }
    if (catChanged) {
      anyChanged = true
      return { ...cat, x, y, direction, activity, activityUntil, mood, moodSecondary, moodUntil, targetX, phase: newPhase, phaseTime, idleSequence, idleSequenceStartedAt, nextIdleLifeAt, lastIdleLifeWasSpecial, poop, turn }
    }
    // No change — return original ref so React.memo bails out.
    return cat
  })
  // Pass 2 — interaction proximity check
  const interactionCooldown = placement === 'login' ? LOGIN_INTERACTION_COOLDOWN_MS : INTERACTION_COOLDOWN_MS
  if (now - lastGlobalRef.current > interactionCooldown) {
    outer: for (let i = 0; i < stepped.length; i++) {
      for (let j = i + 1; j < stepped.length; j++) {
        const a = stepped[i]
        const b = stepped[j]
        // Both cats must be in a "open to interaction" state
        if (
          (a.activity !== 'walk' && a.activity !== 'sit' && a.activity !== 'pounce') ||
          (b.activity !== 'walk' && b.activity !== 'sit' && b.activity !== 'pounce')
        ) {
          continue
        }
        // Don't re-interact with the same cat instantly
        if (
          (a.lastInteractedWith === b.id && now - a.lastInteractedAt < interactionCooldown * 2) ||
          (b.lastInteractedWith === a.id && now - b.lastInteractedAt < interactionCooldown * 2)
        ) {
          continue
        }
        const dist = Math.abs(a.x - b.x)
        if (dist < INTERACTION_DISTANCE) {
          const result = rollInteraction(a, b, now, w)
          if (result) {
            stepped[i] = result[0]
            stepped[j] = result[1]
            lastGlobalRef.current = now
            anyChanged = true
            break outer
          }
        }
      }
    }
  }
  // iter-356.6 (perf A2): return original ref when nothing changed,
  // so React's setCats updater bails out (no reconciliation, no
  // CatRender memo invalidation, zero work). Only kicks in when
  // ALL three cats are in a static activity (sit/sleep/loaf/etc.)
  // AND no mood is expiring AND no activity is transitioning AND
  // no interaction fires — i.e. exactly the long-quiet stretches
  // where the wall-clock cost was previously most wasteful.
  return anyChanged ? stepped : cats
}

// usePrefersReducedMotion / usePrefersReducedData / useBatteryLow moved
// VERBATIM to catPerfGates.ts (Playground Slice A) — imported at the top.
