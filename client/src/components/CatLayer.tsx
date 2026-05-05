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
  // Interactions
  | 'groom' // Mushu grooming Coco
  | 'snuggle' // Mushu + Coco sit close
  | 'hiss' // Panther hissing
  | 'scared' // jumped back, ears down
  | 'chase' // running fast at someone
  | 'flee' // running fast away
  | 'play' // happy hopping in place

type CatState = {
  id: CatId
  x: number
  y: number
  direction: 'L' | 'R'
  activity: Activity
  activityUntil: number
  mood: string | null
  moodSecondary: string | null // optional second emoji (😻💕)
  moodUntil: number
  // Targeted movement (for chase/flee)
  targetX: number | null
  // Last cat I interacted with — avoid instant re-interaction
  lastInteractedWith: CatId | null
  lastInteractedAt: number
  // iter-356.7: per-cat sprite-frame phase. 0 or 1; toggles to drive
  // the walk/walk2 alternation (every 67ms while walking) and the
  // sit/sit2 tail flick (every 600ms while sitting). Computed in
  // stepCats so the CatRender stays pure (React 19 purity rule
  // forbids reading performance.now() during render). Bail-out
  // semantics preserved: phase only counted as change when it
  // actually flips, so static-activity cats still no-op.
  phase: number
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
function setActivity(c: CatState, activity: Activity, durationMs: number, now: number): CatState {
  return { ...c, activity, activityUntil: now + durationMs }
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
  const totalWeight = pool.reduce((s, o) => s + o.weight, 0)
  let roll = Math.random() * totalWeight
  for (const outcome of pool) {
    roll -= outcome.weight
    if (roll <= 0) {
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
  }
  return null
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
  ],
}

function rollSolo(c: CatState, now: number, w: number): CatState {
  const pool = SOLO_EVENTS[c.id]
  const totalWeight = pool.reduce((s, o) => s + o.weight, 0)
  let roll = Math.random() * totalWeight
  for (const e of pool) {
    roll -= e.weight
    if (roll <= 0) return e.apply(c, now, w)
  }
  return c
}

// === Personality knobs (movement only — emotional outcomes are above) ========

// iter-356.13 (user directive: less walking): per-cat base speeds
// dropped roughly 30-40%. The point of less walking is also less
// fast walking — cats meander when they DO walk, like real cats.
const SPEED: Record<CatId, number> = {
  panther: 0.25,
  mushu: 0.7,
  coco: 0.35,
}
const CHASE_SPEED = 1.5
const FLEE_SPEED = 1.8

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

function rand(min: number, max: number) {
  return Math.random() * (max - min) + min
}

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

export function CatLayer() {
  const [cats, setCats] = useState<CatState[]>(() => initialCats())
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
      setCats((prev) => stepCats(prev, now, dt, lastGlobalInteractionRef))
    }
    raf = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(raf)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [animationsPaused])

  return (
    <div
      aria-hidden="true"
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
      className="pointer-events-none fixed z-[5] overflow-hidden"
      style={{
        height: `${SPRITE_HEIGHT + 56}px`,
        bottom: `var(--cat-layer-bottom, ${LAYER_BOTTOM_OFFSET}px)`,
        // iter-356.28: respect SideNav rail on desktop so cats don't
        // walk across the "Sign out" button. SideNav is `w-56` (14rem)
        // and only mounted at lg:. Pre-iter-356.28 the layer was
        // inset-x-0 so the walking strip extended into the rail and
        // pixel cats sat on top of nav controls — confirmed visually
        // via browser-harness against the live tailnet PWA.
        left: 'var(--cat-layer-left, 0px)',
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
      <HabitatBackground />
      {cats.map((cat) => (
        <CatRender key={cat.id} cat={cat} />
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
function HabitatBackground() {
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

function CatRenderImpl({ cat }: { cat: CatState }) {
  const Sprite =
    cat.id === 'panther'
      ? BombaySprite
      : cat.id === 'mushu'
        ? TuxedoSprite
        : CalicoSprite
  // iter-356.7: phase comes from CatState (computed in stepCats),
  // not from a render-time performance.now() read. Frame swap rate
  // depends on activity — see stepCats for the cadence.
  const spriteState = activityToSprite(cat.activity, cat.phase)
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
        style={{
          width: '100%',
          height: '100%',
          // iter-356.39: curated sprite-sheet PNGs face LEFT by default
          // (Panther's head visible on the LEFT side of walk_a). Pre-iter
          // the SVG art faced RIGHT so direction='L' got the scaleX(-1)
          // flip; now direction='R' needs the flip instead.
          transform: cat.direction === 'R' ? 'scaleX(-1)' : undefined,
          transformOrigin: 'center',
          // iter-356.40: smooth scaleX flip when a cat changes direction
          // mid-walk OR when an activity transition sets a new direction.
          // SAFE here because this div has NO translateX (translate is
          // on the parent container — see iter-356.21 sharp edge). Was
          // an instant 180° pop that read as a teleport.
          transition: 'transform 220ms ease-in-out',
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
          <Sprite size={SPRITE_WIDTH} state={spriteState} />
        </div>
      </div>
      {cat.mood && (
        <span
          key={`${cat.id}-${cat.moodUntil}`}
          style={{
            position: 'absolute',
            left: '50%',
            top: -10,
            fontSize: 18,
            lineHeight: 1,
            whiteSpace: 'nowrap',
            animation: 'cat-mood-rise 2200ms ease-out forwards',
            pointerEvents: 'none',
            filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.6))',
          }}
        >
          {cat.mood}
          {cat.moodSecondary && (
            <span style={{ marginLeft: 1 }}>{cat.moodSecondary}</span>
          )}
        </span>
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

// iter-356.6: per-activity sprite animation. Returns CSS animation
// shorthand or undefined. Static SVG sprites are framed once per
// pose; this layer adds inter-frame motion (bob/breathe) so the
// cats look ALIVE rather than skating across the screen.
function spriteAnim(activity: Activity): string | undefined {
  switch (activity) {
    case 'walk':
      return 'cat-walk-bob 200ms steps(2) infinite'
    case 'chase':
    case 'flee':
      // Faster cadence for chase/flee — the urgency reads as a
      // sprint vs a normal walk. Same keyframe; tighter period.
      return 'cat-walk-bob 140ms steps(2) infinite'
    case 'sleep':
      return 'cat-breathe 2600ms ease-in-out infinite'
    default:
      return undefined
  }
}

// iter-356.4-cats-2: route Activity → BodyState. Activities without a
// dedicated pose collapse to the closest neighbour. Keep this in sync
// with CatIcons' BodyState union.
// iter-356.7: phase (0 or 1) drives walk frame alternation AND sit
// tail-flick. Cadence is set in stepCats based on activity (67ms for
// walk/chase/flee, 600ms for sit/judge/loaf).
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
      return 'stretch'
    case 'groom':
      return 'groom'
    case 'hiss':
      return 'hiss'
    case 'play':
      return 'play'
    case 'on_post':
      return 'on_post'
    case 'chase':
    case 'flee':
    case 'walk':
      return phase === 0 ? 'walk' : 'walk2'
    case 'sit':
    case 'judge':
    case 'loaf':
    case 'snuggle':
    case 'scared':
      return phase === 0 ? 'sit' : 'sit2'
  }
}

// iter-356.7: per-activity phase cadence. Walking cycles at 15fps
// (vscode-pets convention); sit/static at 600ms for a slow tail flick.
// Returns the phase (0 or 1) for the given activity at time `now`.
function phaseFor(activity: Activity, now: number): number {
  switch (activity) {
    case 'walk':
    case 'chase':
    case 'flee':
      return Math.floor(now / 67) % 2
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
      // Tiny sparkle puff for zoomies/play
      return { type: 'sparkles', x: SPRITE_WIDTH / 2, y: 20, count: 3 }
    default:
      return null
  }
}

// === STATE-MACHINE LOOP =====================================================

function initialCats(): CatState[] {
  const w = layerWidth()
  const ids: CatId[] = ['panther', 'mushu', 'coco']
  const now = performance.now()
  return ids.map((id, i) => ({
    id,
    x: (w / 4) * (i + 1) + rand(-30, 30),
    y: 0,
    direction: Math.random() < 0.5 ? 'L' : 'R',
    activity: 'walk',
    activityUntil: now + rand(2000, 5000),
    mood: null,
    moodSecondary: null,
    moodUntil: 0,
    targetX: null,
    lastInteractedWith: null,
    lastInteractedAt: 0,
    phase: 0,
  }))
}

function stepCats(
  cats: CatState[],
  now: number,
  dt: number,
  lastGlobalRef: { current: number },
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
    let { x, direction, mood, moodSecondary } = cat
    const { y, activity, activityUntil, moodUntil, targetX } = cat
    let catChanged = false
    if (mood && now > moodUntil) {
      mood = null
      moodSecondary = null
      catChanged = true
    }
    const oldX = x
    const oldDir = direction
    if (activity === 'walk') {
      x += direction === 'R' ? SPEED[cat.id] * dtNorm : -SPEED[cat.id] * dtNorm
    } else if (activity === 'chase') {
      const speed = CHASE_SPEED * dtNorm
      x += direction === 'R' ? speed : -speed
    } else if (activity === 'flee') {
      const speed = FLEE_SPEED * dtNorm
      x += direction === 'R' ? speed : -speed
    } else if (activity === 'play') {
      x += direction === 'R' ? 0.2 * dtNorm : -0.2 * dtNorm
    }
    if (x < 8) {
      x = 8
      if (direction === 'L') direction = 'R'
    } else if (x > w - SPRITE_WIDTH - 8) {
      x = w - SPRITE_WIDTH - 8
      if (direction === 'R') direction = 'L'
    }
    if (x !== oldX || direction !== oldDir) catChanged = true
    // iter-356.7: per-activity sprite-frame phase. Only counts as a
    // change when the value flips, so a sleeping cat (always phase=0)
    // stays ref-stable; a sitting cat updates every 600ms; a walking
    // cat updates every 67ms (which it would anyway because x moves).
    const newPhase = phaseFor(activity, now)
    if (newPhase !== cat.phase) catChanged = true
    // Activity expiry → roll a solo event for the next state. This
    // ALWAYS counts as a change because rollSolo returns a new state.
    if (now > activityUntil) {
      const next = rollSolo({ ...cat, x, y, direction, activity, activityUntil, mood, moodSecondary, moodUntil, targetX: null, phase: newPhase }, now, w)
      anyChanged = true
      return next
    }
    if (catChanged) {
      anyChanged = true
      return { ...cat, x, y, direction, activity, activityUntil, mood, moodSecondary, moodUntil, targetX, phase: newPhase }
    }
    // No change — return original ref so React.memo bails out.
    return cat
  })
  // Pass 2 — interaction proximity check
  if (now - lastGlobalRef.current > INTERACTION_COOLDOWN_MS) {
    outer: for (let i = 0; i < stepped.length; i++) {
      for (let j = i + 1; j < stepped.length; j++) {
        const a = stepped[i]
        const b = stepped[j]
        // Both cats must be in a "open to interaction" state
        if (
          (a.activity !== 'walk' && a.activity !== 'sit') ||
          (b.activity !== 'walk' && b.activity !== 'sit')
        ) {
          continue
        }
        // Don't re-interact with the same cat instantly
        if (
          (a.lastInteractedWith === b.id && now - a.lastInteractedAt < INTERACTION_COOLDOWN_MS * 2) ||
          (b.lastInteractedWith === a.id && now - b.lastInteractedAt < INTERACTION_COOLDOWN_MS * 2)
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

// === Reduced-motion preference hook =========================================

function usePrefersReducedMotion(): boolean {
  // iter-356.4-cats: lazy-init from matchMedia AT MOUNT (avoids the
  // react-hooks/set-state-in-effect lint trap — synchronous setReduced
  // inside useEffect is what the rule rejects).
  const [reduced, setReduced] = useState(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  })
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return reduced
}

// iter-356-E (Slice E): mirror of usePrefersReducedMotion for the
// `prefers-reduced-data: reduce` media query. Same lazy-init + change-
// listener pattern so the lint rule (no setState in useEffect body) is
// honored. Browsers without the query (most as of 2026) report `false`
// at construction — the user opts in via a known browser flag or OS-
// level data-saver, so missing support === "no preference set."
function usePrefersReducedData(): boolean {
  const [reduced, setReduced] = useState(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false
    return window.matchMedia('(prefers-reduced-data: reduce)').matches
  })
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const mq = window.matchMedia('(prefers-reduced-data: reduce)')
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return reduced
}

// iter-356-E (Slice E): best-effort Battery Status API gate. Returns
// `true` when battery level < 20% AND the device is not charging.
// Wrapped in try/catch + feature detect because the API is unevenly
// shipped (Chromium yes, Safari no, Firefox removed). React 19 lint
// rule (no setState in useEffect body) is honored via a `cancelled`
// flag in the .then() — same pattern as the AuthProvider /me fetch.
type BatteryManagerLike = {
  level: number
  charging: boolean
  addEventListener: (type: string, listener: () => void) => void
  removeEventListener: (type: string, listener: () => void) => void
}
function useBatteryLow(): boolean {
  const [low, setLow] = useState(false)
  useEffect(() => {
    if (typeof navigator === 'undefined') return
    const nav = navigator as Navigator & {
      getBattery?: () => Promise<BatteryManagerLike>
    }
    if (typeof nav.getBattery !== 'function') return
    let cancelled = false
    let battery: BatteryManagerLike | null = null
    const evaluate = (b: BatteryManagerLike) => {
      // < 20% AND not charging — plugging in cancels the gate even if
      // the cell is at 5%, which matches the "save what's left" intent.
      const isLow = b.level < 0.2 && !b.charging
      if (!cancelled) setLow(isLow)
    }
    try {
      nav
        .getBattery()
        .then((b) => {
          if (cancelled) return
          battery = b
          evaluate(b)
          const onChange = () => {
            if (battery) evaluate(battery)
          }
          b.addEventListener('levelchange', onChange)
          b.addEventListener('chargingchange', onChange)
          // Stash the listener on the battery object via a closure so
          // cleanup can reach it. Returning early-cleanup from a
          // .then() isn't possible — instead the outer useEffect
          // returns a cleanup that flips `cancelled` AND tears down
          // the listeners by re-binding via `battery` ref capture.
          ;(battery as BatteryManagerLike & { __homecamCleanup?: () => void }).__homecamCleanup = () => {
            b.removeEventListener('levelchange', onChange)
            b.removeEventListener('chargingchange', onChange)
          }
        })
        .catch(() => {
          // getBattery() can reject in privacy-restricted contexts
          // (some Chromium policies block it). Treat as "no signal."
          if (!cancelled) setLow(false)
        })
    } catch {
      // Synchronous throw from a non-conforming polyfill; default
      // initial state is already `false` so no setState is needed
      // (and the React 19 lint rule rejects sync setState here).
    }
    return () => {
      cancelled = true
      const b = battery as
        | (BatteryManagerLike & { __homecamCleanup?: () => void })
        | null
      if (b && typeof b.__homecamCleanup === 'function') {
        b.__homecamCleanup()
      }
    }
  }, [])
  return low
}
