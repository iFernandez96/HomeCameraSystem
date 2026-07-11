import type { CatAnimId } from '../components/catAnimSequences'
import { CAT_IDS } from '../components/catAnimSequences'
import type {
  CatFocus,
  PlaygroundInput,
  PlaygroundLane,
  ToyState,
  VerbStimulus,
} from './playgroundTypes'
import { laneForY } from './toyPhysics'

// Playground Slice C — the verb brain. Pure decision logic: reads the
// toy state + a READONLY view of the cats each tick and proposes
// VerbStimulus requests for the yard engine (Slice B) to apply. It
// never mutates cats and never moves toys.
//
// ALL randomness comes through the injected `random` fn (design doc #5:
// charm-randomness lives ONLY in the cat's DECISION to engage) so every
// personality roll is seedable in tests.
//
// Focus commitment: a cat already committed to a focus is left alone —
// the brain only CONTINUES a matching engagement or proposes to a free
// (focus null) cat. The two sanctioned preempts are treats-for-Coco
// (her only high-energy trigger) and petting (direct touch always wins).

/** Readonly per-cat view the yard engine passes in each tick. */
export type VerbCatView = Readonly<{
  id: CatAnimId
  x: number
  y: number
  lane: PlaygroundLane
  focus: CatFocus
  /** Coco naps by default; treats (and only treats) wake her. */
  asleep?: boolean
}>

export type VerbBrainArgs = Readonly<{
  toys: ToyState
  cats: readonly VerbCatView[]
  input: Pick<PlaygroundInput, 'petTarget'>
  random: () => number
  now: number
  sceneH: number
}>

// ---------------------------------------------------------------------------
// Tuning (all times ms, distances px)

export const MUSHU_LASER_REACT_MS = 300
export const PANTHER_LASER_IGNORE_P = 0.4
export const PANTHER_LASER_DELAY_MIN_MS = 2000
export const PANTHER_LASER_DELAY_MAX_MS = 4000
export const PANTHER_SIT_RANGE_PX = 28
export const PANTHER_SIT_MS = 5000
export const COCO_LASER_NEAR_PX = 60
export const COCO_LASER_PASSES = 2
export const COCO_SLOW_BAT_GAP_MS = 1200

export const BAT_RANGE_PX = 36
export const MUSHU_BAT_GAP_MS = 700
export const MUSHU_YARN_BATS_PER_REST = 4
export const PANTHER_ZONE_PX = 120
export const PANTHER_BAT_GAP_MS = 900
export const COCO_YARN_NEAR_PX = 60
export const MUSHU_WAND_ZONE_PX = 140

export const EAT_RANGE_PX = 26
export const PANTHER_CROWD_PX = 80

export const PANTHER_PET_TOLERANCE_MS = 2000
export const PANTHER_PET_JITTER_MS = 800
export const PANTHER_PET_COOLDOWN_MS = 8000

// ---------------------------------------------------------------------------
// Per-cat verb memory (delays, rolls, cooldowns). Explicit state object
// so tests can construct/reset it; mutated in place by stepVerbBrain.

type LaserMemory = {
  decision: 'pending' | 'ignore' | 'engage' | 'done'
  reactAt: number
  judged: boolean
  sitSince: number | null
  nearCount: number
  wasNear: boolean
  batsLeft: number
  lastBatAt: number
}

type CatMemory = {
  laser: LaserMemory
  /** Yarn id last engaged; personality bat budgets reset on a new yarn. */
  yarnId: number | null
  yarnBatsLeft: number
  yarnLastBatAt: number
  yarnDone: boolean
  wandBatsLeft: number
  wandLastBatAt: number
  wandDone: boolean
  petHeldSince: number | null
  petGrumpAt: number
  petCooldownUntil: number
}

export type VerbBrain = {
  laserWasOn: boolean
  wandWasHeld: boolean
  lastPetTarget: CatAnimId | null
  perCat: Record<CatAnimId, CatMemory>
}

function freshLaserMemory(): LaserMemory {
  return {
    decision: 'pending',
    reactAt: 0,
    judged: false,
    sitSince: null,
    nearCount: 0,
    wasNear: false,
    batsLeft: COCO_LASER_PASSES,
    lastBatAt: 0,
  }
}

function freshCatMemory(): CatMemory {
  return {
    laser: freshLaserMemory(),
    yarnId: null,
    yarnBatsLeft: 0,
    yarnLastBatAt: 0,
    yarnDone: false,
    wandBatsLeft: 0,
    wandLastBatAt: 0,
    wandDone: false,
    petHeldSince: null,
    petGrumpAt: 0,
    petCooldownUntil: 0,
  }
}

export function createVerbBrain(): VerbBrain {
  const perCat = {} as Record<CatAnimId, CatMemory>
  for (const id of CAT_IDS) perCat[id] = freshCatMemory()
  return { laserWasOn: false, wandWasHeld: false, lastPetTarget: null, perCat }
}

// ---------------------------------------------------------------------------

function dist(ax: number, ay: number, bx: number, by: number): number {
  return Math.hypot(bx - ax, by - ay)
}

function focusIsToy(focus: CatFocus, toy: 'laser' | 'yarn' | 'wand'): boolean {
  return focus !== null && focus.type === 'toy' && focus.toy === toy
}

/** May this cat take up (or continue) the given engagement? */
function mayEngage(cat: VerbCatView, matches: (focus: CatFocus) => boolean): boolean {
  return cat.focus === null || matches(cat.focus)
}

function chase(
  catId: CatAnimId,
  targetX: number,
  targetY: number,
  lane: PlaygroundLane,
  gait: 'walk' | 'run',
): VerbStimulus {
  return { catId, request: { type: 'chase', targetX, targetY, lane, gait } }
}

// ---------------------------------------------------------------------------
// Per-verb deciders. Each returns a stimulus or null; stepVerbBrain
// takes the first non-null per cat in priority order (pet > treat >
// laser > yarn > wand).

function decidePet(
  brain: VerbBrain,
  cat: VerbCatView,
  petTarget: CatAnimId | null,
  random: () => number,
  now: number,
): VerbStimulus | null {
  const mem = brain.perCat[cat.id]

  if (petTarget !== cat.id) {
    // hold ended: release the pet focus once
    if (mem.petHeldSince !== null) {
      mem.petHeldSince = null
      return { catId: cat.id, request: { type: 'release' } }
    }
    return null
  }

  // Panther's 8s per-cat pet cooldown: quiet refusal, no purr
  if (now < mem.petCooldownUntil) return null

  if (mem.petHeldSince === null) {
    mem.petHeldSince = now
    if (cat.id === 'panther') {
      // tolerates ~2s, jittered per hold (DECISION randomness — injected fn)
      mem.petGrumpAt =
        now + PANTHER_PET_TOLERANCE_MS + (random() - 0.5) * PANTHER_PET_JITTER_MS
    }
    // purr immediately on touch (design doc: pet is high-affection, low-cost)
    return { catId: cat.id, request: { type: 'purr' } }
  }

  if (cat.id === 'panther' && now >= mem.petGrumpAt) {
    mem.petHeldSince = null
    mem.petCooldownUntil = now + PANTHER_PET_COOLDOWN_MS
    return { catId: cat.id, request: { type: 'grump' } }
  }

  return null // held and content — the purr focus persists in Slice B
}

function decideTreat(
  brain: VerbBrain,
  cat: VerbCatView,
  toys: ToyState,
  cats: readonly VerbCatView[],
  now: number,
): VerbStimulus | null {
  void brain
  void now
  const open = toys.treats.filter((t) => t.state !== 'claimed' && t.claimedBy === null)
  if (open.length === 0) return null

  // nearest open treat
  let treat = open[0]
  let best = dist(cat.x, cat.y, treat.x, treat.y)
  for (const t of open.slice(1)) {
    const d = dist(cat.x, cat.y, t.x, t.y)
    if (d < best) {
      best = d
      treat = t
    }
  }

  // focus rule: continue a matching treat focus, start when free — and
  // Coco ALWAYS preempts for treats (her only high-energy trigger),
  // even mid-nap.
  const continuing =
    cat.focus !== null && cat.focus.type === 'treat' && cat.focus.treatId === treat.id
  if (cat.id !== 'coco' && !continuing && cat.focus !== null) return null
  if (cat.id !== 'coco' && cat.asleep) return null

  // Panther waits her turn if the treat is crowded
  if (cat.id === 'panther') {
    const crowded = cats.some(
      (other) => other.id !== cat.id && dist(other.x, other.y, treat.x, treat.y) < PANTHER_CROWD_PX,
    )
    if (crowded) return null
  }

  if (best <= EAT_RANGE_PX && treat.state === 'landed') {
    return { catId: cat.id, request: { type: 'eat', treatId: treat.id } }
  }

  // Mushu runs, Panther walks, Coco wakes and trots
  const gait: 'walk' | 'run' = cat.id === 'panther' ? 'walk' : 'run'
  return chase(cat.id, treat.x, treat.y, treat.lane, gait)
}

function decideLaser(
  brain: VerbBrain,
  cat: VerbCatView,
  toys: ToyState,
  random: () => number,
  now: number,
  sceneH: number,
): VerbStimulus | null {
  const laser = toys.laser
  const mem = brain.perCat[cat.id].laser

  if (!laser.on) {
    // dot vanished: release a committed chaser
    if (focusIsToy(cat.focus, 'laser')) {
      return { catId: cat.id, request: { type: 'release' } }
    }
    return null
  }

  // per-activation decision roll (once, on the first tick the cat sees
  // this activation)
  if (mem.decision === 'pending') {
    if (cat.id === 'mushu') {
      mem.decision = 'engage'
      mem.reactAt = now + MUSHU_LASER_REACT_MS
    } else if (cat.id === 'panther') {
      if (random() < PANTHER_LASER_IGNORE_P) {
        mem.decision = 'ignore'
      } else {
        mem.decision = 'engage'
        mem.reactAt =
          now +
          PANTHER_LASER_DELAY_MIN_MS +
          random() * (PANTHER_LASER_DELAY_MAX_MS - PANTHER_LASER_DELAY_MIN_MS)
      }
    } else {
      // Coco: no roll — she sleeps through unless the dot teases her
      mem.decision = 'engage'
      mem.reactAt = now
    }
  }

  if (!mayEngage(cat, (f) => focusIsToy(f, 'laser'))) return null

  const d = dist(cat.x, cat.y, laser.x, laser.y)
  const lane = laneForY(laser.y, sceneH)

  if (cat.id === 'mushu') {
    if (now < mem.reactAt) return null
    return chase(cat.id, laser.x, laser.y, lane, 'run')
  }

  if (cat.id === 'panther') {
    if (mem.decision === 'ignore') {
      if (!mem.judged) {
        mem.judged = true
        return { catId: cat.id, request: { type: 'grump' } } // the judging look
      }
      return null
    }
    if (mem.decision === 'done' || now < mem.reactAt) return null
    if (mem.sitSince !== null || d <= PANTHER_SIT_RANGE_PX) {
      // she caught it: SITS ON the dot for 5s, then is done with lasers
      if (mem.sitSince === null) mem.sitSince = now
      if (now - mem.sitSince >= PANTHER_SIT_MS) {
        mem.decision = 'done'
        mem.sitSince = null
        return { catId: cat.id, request: { type: 'release' } }
      }
      return null // holding her sit — Slice B keeps the focus parked
    }
    return chase(cat.id, laser.x, laser.y, lane, 'run')
  }

  // Coco: asleep to it unless the dot passes within 60px twice, then a
  // slow bat or two, then she gives up for this activation
  if (mem.decision === 'done') return null
  const near = d < COCO_LASER_NEAR_PX
  if (near && !mem.wasNear) mem.nearCount += 1
  mem.wasNear = near
  if (mem.nearCount < COCO_LASER_PASSES) return null
  if (!near) return null
  if (now - mem.lastBatAt < COCO_SLOW_BAT_GAP_MS) return null
  mem.lastBatAt = now
  mem.batsLeft -= 1
  if (mem.batsLeft <= 0) mem.decision = 'done'
  return { catId: cat.id, request: { type: 'bat' } }
}

/** Shared yarn/wand personality logic — target is the yarn ball or the
    held wand tip. */
function decideBatToy(
  brain: VerbBrain,
  cat: VerbCatView,
  toy: 'yarn' | 'wand',
  target: { x: number; y: number; lane: PlaygroundLane; resting: boolean },
  random: () => number,
  now: number,
): VerbStimulus | null {
  const mem = brain.perCat[cat.id]
  if (!mayEngage(cat, (f) => focusIsToy(f, toy))) return null

  const d = dist(cat.x, cat.y, target.x, target.y)
  const done = toy === 'yarn' ? mem.yarnDone : mem.wandDone
  const lastBatAt = toy === 'yarn' ? mem.yarnLastBatAt : mem.wandLastBatAt

  const emitBat = (batsLeft: number, gapMs: number): VerbStimulus | null => {
    if (now - lastBatAt < gapMs) return null
    if (toy === 'yarn') {
      mem.yarnLastBatAt = now
      mem.yarnBatsLeft = batsLeft - 1
      if (mem.yarnBatsLeft <= 0) mem.yarnDone = true
    } else {
      mem.wandLastBatAt = now
      mem.wandBatsLeft = batsLeft - 1
      if (mem.wandBatsLeft <= 0) mem.wandDone = true
    }
    return { catId: cat.id, request: { type: 'bat' } }
  }

  if (cat.id === 'mushu') {
    // first responder: chases anywhere for yarn, within a wide zone for
    // the wand tip; bat bouts on proximity
    if (toy === 'wand' && d > MUSHU_WAND_ZONE_PX) return null
    if (done && target.resting) return null // batted it still — bored now
    if (!target.resting && done) {
      // it moved again — bouts re-arm
      if (toy === 'yarn') {
        mem.yarnDone = false
        mem.yarnBatsLeft = MUSHU_YARN_BATS_PER_REST
      } else {
        mem.wandDone = false
        mem.wandBatsLeft = MUSHU_YARN_BATS_PER_REST
      }
    }
    if (d > BAT_RANGE_PX) return chase(cat.id, target.x, target.y, target.lane, 'run')
    const left = toy === 'yarn' ? mem.yarnBatsLeft : mem.wandBatsLeft
    return emitBat(left > 0 ? left : MUSHU_YARN_BATS_PER_REST, MUSHU_BAT_GAP_MS)
  }

  if (cat.id === 'panther') {
    // joins only inside her 120px zone; 1-2 dignified bats, then done
    if (done || d > PANTHER_ZONE_PX) return null
    let left = toy === 'yarn' ? mem.yarnBatsLeft : mem.wandBatsLeft
    if (left <= 0) {
      // per-toy roll: 1 or 2 bats (DECISION randomness — injected fn)
      left = random() < 0.5 ? 1 : 2
      if (toy === 'yarn') mem.yarnBatsLeft = left
      else mem.wandBatsLeft = left
    }
    if (d > BAT_RANGE_PX) return chase(cat.id, target.x, target.y, target.lane, 'walk')
    return emitBat(left, PANTHER_BAT_GAP_MS)
  }

  // Coco: bats only when it comes to rest right beside her (yarn) or
  // lingers within reach (wand); a single unhurried bat, then gives up
  if (done) return null
  if (toy === 'yarn' && !target.resting) return null
  if (d > COCO_YARN_NEAR_PX) return null
  if (cat.asleep && toy === 'yarn') return null // a resting yarn won't wake her
  return emitBat(1, COCO_SLOW_BAT_GAP_MS)
}

// ---------------------------------------------------------------------------

/** One tick of verb decisions. Mutates `brain` memory; never mutates
    cats or toys. At most one stimulus per cat per tick. */
export function stepVerbBrain(brain: VerbBrain, args: VerbBrainArgs): VerbStimulus[] {
  const { toys, cats, input, random, now, sceneH } = args
  const stimuli: VerbStimulus[] = []

  // edge resets — a fresh activation gets fresh decisions
  if (toys.laser.on && !brain.laserWasOn) {
    for (const id of CAT_IDS) brain.perCat[id].laser = freshLaserMemory()
  }
  brain.laserWasOn = toys.laser.on
  if (toys.wand.held && !brain.wandWasHeld) {
    for (const id of CAT_IDS) {
      brain.perCat[id].wandBatsLeft = 0
      brain.perCat[id].wandLastBatAt = 0
      brain.perCat[id].wandDone = false
    }
  }
  brain.wandWasHeld = toys.wand.held
  brain.lastPetTarget = input.petTarget

  for (const cat of cats) {
    const mem = brain.perCat[cat.id]

    // new yarn -> fresh bat budgets
    if (toys.yarn !== null && mem.yarnId !== toys.yarn.id) {
      mem.yarnId = toys.yarn.id
      mem.yarnBatsLeft = 0
      mem.yarnLastBatAt = 0
      mem.yarnDone = false
    }

    // stale-focus releases: committed to a toy that no longer exists
    if (
      (focusIsToy(cat.focus, 'yarn') && toys.yarn === null) ||
      (focusIsToy(cat.focus, 'wand') && !toys.wand.held)
    ) {
      stimuli.push({ catId: cat.id, request: { type: 'release' } })
      continue
    }

    const pet = decidePet(brain, cat, input.petTarget, random, now)
    if (pet) {
      stimuli.push(pet)
      continue
    }
    if (input.petTarget === cat.id) continue // being petted — no other verbs

    const treat = decideTreat(brain, cat, toys, cats, now)
    if (treat) {
      stimuli.push(treat)
      continue
    }

    const laser = decideLaser(brain, cat, toys, random, now, sceneH)
    if (laser) {
      stimuli.push(laser)
      continue
    }

    if (toys.yarn !== null) {
      const yarn = decideBatToy(
        brain,
        cat,
        'yarn',
        {
          x: toys.yarn.x,
          y: toys.yarn.y,
          lane: toys.yarn.lane,
          resting: toys.yarn.restingSince !== null,
        },
        random,
        now,
      )
      if (yarn) {
        stimuli.push(yarn)
        continue
      }
    }

    if (toys.wand.held) {
      const wand = decideBatToy(
        brain,
        cat,
        'wand',
        {
          x: toys.wand.tipX,
          y: toys.wand.tipY,
          lane: laneForY(toys.wand.tipY, sceneH),
          resting: false,
        },
        random,
        now,
      )
      if (wand) stimuli.push(wand)
    }
  }

  return stimuli
}
