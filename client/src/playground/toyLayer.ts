import type {
  PlaygroundInput,
  ToyState,
  TreatToy,
  VerbStimulus,
  YarnToy,
} from './playgroundTypes'
import type { VerbCatView } from './catBrain.verbs'
import { createVerbBrain, stepVerbBrain } from './catBrain.verbs'
import {
  laneForY,
  stepLaser,
  stepTreat,
  stepWand,
  stepYarn,
  yarnExpired,
} from './toyPhysics'

// INTEGRATION SEAM — Slice C's real toy/verb layer (toyPhysics +
// catBrain.verbs). Slice B's stepPlayground calls this once per tick
// AFTER stepping cats. Contract:
// - MUST return the SAME ToyState reference when nothing changed
//   (CatLayer bail-out discipline — a changed ref re-renders the layer).
// - Consumes one-shot input fields (flick, treatTap) by mutating the
//   input ref object's fields to null after spawning.
// - Returns stimuli for the yard engine to apply to cats; it must not
//   mutate cats itself.
//
// Toy motion is INSTANT and DETERMINISTIC (Swink rule); stimuli only
// flow when the caller passes the optional ctx (cats view + injected
// random fn) — without it the toys still run, silently, so Slice B can
// integrate incrementally against the original 6-arg call shape.

export const INITIAL_TOY_STATE: ToyState = {
  yarn: null,
  treats: [],
  laser: { kind: 'laser', on: false, x: 0, y: 0, tx: 0, ty: 0 },
  wand: {
    kind: 'wand',
    held: false,
    hx: 0,
    hy: 0,
    tipX: 0,
    tipY: 0,
    tipVx: 0,
    tipVy: 0,
  },
}

export type ToyStepResult = {
  toys: ToyState
  stimuli: VerbStimulus[]
}

/** Optional per-tick context for the verb brain. Slice B passes the
    readonly cat views + an injectable random fn (seedable in tests). */
export type ToyStepCtx = {
  cats?: readonly VerbCatView[]
  random?: () => number
}

/** Yarn flick velocity cap, px per 60fps frame. */
export const YARN_MAX_SPEED = 28
/** At most this many uneaten treats on the floor at once. */
export const MAX_TREATS = 3
/** A claimed treat lingers this long (the eat bout), then despawns. */
export const TREAT_EAT_DESPAWN_MS = 2600

const NO_STIMULI: VerbStimulus[] = []

// Module-level session state: id counters, the verb brain's memory
// (personality rolls/cooldowns span ticks), and claim timestamps for
// treat despawn. One playground scene exists at a time (route-level
// page); tests reset via resetToyLayer().
let nextToyId = 1
let brain = createVerbBrain()
let treatClaimedAt = new Map<number, number>()

/** Test/unmount hook: forget cross-tick verb memory + id counters. */
export function resetToyLayer(): void {
  nextToyId = 1
  brain = createVerbBrain()
  treatClaimedAt = new Map()
}

export function stepToyLayer(
  toys: ToyState,
  input: PlaygroundInput,
  dt: number,
  now: number,
  sceneW: number,
  sceneH: number,
  ctx?: ToyStepCtx,
): ToyStepResult {
  let yarn = toys.yarn
  let treats = toys.treats
  let laser = toys.laser
  let wand = toys.wand

  // -- consume one-shot inputs (null the field so a gesture spawns once)

  if (input.flick !== null) {
    const f = input.flick
    input.flick = null
    // px/ms -> px/frame, capped so a violent flick stays in-scene
    let vx = f.vx * (1000 / 60)
    let vy = f.vy * (1000 / 60)
    const speed = Math.hypot(vx, vy)
    if (speed > YARN_MAX_SPEED) {
      vx = (vx / speed) * YARN_MAX_SPEED
      vy = (vy / speed) * YARN_MAX_SPEED
    }
    // THE single yarn: a new throw replaces the old ball
    const thrown: YarnToy = {
      kind: 'yarn',
      id: nextToyId++,
      x: f.x,
      y: f.y,
      vx,
      vy,
      lane: laneForY(f.y, sceneH),
      spinPhase: 0,
      restingSince: null,
    }
    yarn = thrown
  }

  if (input.treatTap !== null) {
    const tap = input.treatTap
    input.treatTap = null // consumed even when capped — no retry loop
    const outstanding = treats.filter((t) => t.state !== 'claimed').length
    if (outstanding < MAX_TREATS) {
      const dropped: TreatToy = {
        kind: 'treat',
        id: nextToyId++,
        x: tap.x,
        y: tap.y,
        vy: 0,
        lane: tap.lane,
        state: 'falling',
        claimedBy: null,
      }
      treats = [...treats, dropped]
    }
  }

  // -- drive the pointer-held toys from live input (instant, no easing
  //    on the TARGET — the dot/tip easing happens in the physics step)

  if (input.activeVerb === 'laser') {
    const p = input.pointer
    const on = p !== null && p.down
    if (on) {
      if (!laser.on) {
        // fresh press: dot appears AT the pointer (no fly-in from stale coords)
        laser = { ...laser, on: true, x: p.x, y: p.y, tx: p.x, ty: p.y }
      } else if (laser.tx !== p.x || laser.ty !== p.y) {
        laser = { ...laser, tx: p.x, ty: p.y }
      }
    } else if (laser.on) {
      laser = { ...laser, on: false }
    }
  } else if (laser.on) {
    laser = { ...laser, on: false } // verb switched away mid-press
  }

  if (input.activeVerb === 'wand') {
    const p = input.pointer
    const held = p !== null && p.down
    if (held) {
      if (!wand.held) {
        // pick up: tip starts at the handle, springs from there
        wand = { ...wand, held: true, hx: p.x, hy: p.y, tipX: p.x, tipY: p.y, tipVx: 0, tipVy: 0 }
      } else if (wand.hx !== p.x || wand.hy !== p.y) {
        wand = { ...wand, hx: p.x, hy: p.y }
      }
    } else if (wand.held) {
      wand = { ...wand, held: false }
    }
  } else if (wand.held) {
    wand = { ...wand, held: false }
  }

  // -- physics (each stepper is ref-stable when its toy is at rest)

  if (yarn !== null) {
    yarn = stepYarn(yarn, dt, now, sceneW, sceneH)
    if (yarnExpired(yarn, now)) yarn = null
  }

  let treatsMoved = false
  let stepped: TreatToy[] | null = null
  for (let i = 0; i < treats.length; i++) {
    const next = stepTreat(treats[i], dt, sceneH)
    if (next !== treats[i]) {
      if (stepped === null) stepped = treats.slice()
      stepped[i] = next
      treatsMoved = true
    }
  }
  if (treatsMoved && stepped !== null) treats = stepped

  // eaten treats despawn once the eat bout has played out
  if (treatClaimedAt.size > 0) {
    const keep = treats.filter((t) => {
      const claimed = treatClaimedAt.get(t.id)
      return claimed === undefined || now - claimed < TREAT_EAT_DESPAWN_MS
    })
    if (keep.length !== treats.length) {
      for (const t of treats) {
        if (!keep.includes(t)) treatClaimedAt.delete(t.id)
      }
      treats = keep
    }
  }

  laser = stepLaser(laser, dt)
  wand = stepWand(wand, dt)

  // -- verb brain (decision randomness ONLY here, via the injected fn)

  let stimuli: VerbStimulus[] = NO_STIMULI
  if (ctx?.cats !== undefined && ctx.cats.length > 0) {
    const preBrainToys: ToyState = { yarn, treats, laser, wand }
    stimuli = stepVerbBrain(brain, {
      toys: preBrainToys,
      cats: ctx.cats,
      input,
      random: ctx.random ?? Math.random,
      now,
      sceneH,
    })
    // an accepted eat claims the treat: mark it so it despawns after
    // the bout (the brain proposes; the toy layer owns toy lifecycle)
    for (const s of stimuli) {
      if (s.request.type === 'eat') {
        const treatId = s.request.treatId
        const idx = treats.findIndex((t) => t.id === treatId)
        if (idx !== -1 && treats[idx].state !== 'claimed') {
          const claimed = treats.slice()
          claimed[idx] = { ...claimed[idx], state: 'claimed', claimedBy: s.catId }
          treats = claimed
          treatClaimedAt.set(treatId, now)
        }
      }
    }
  }

  // -- ref-stable bail-out: literally nothing moved

  if (
    yarn === toys.yarn &&
    treats === toys.treats &&
    laser === toys.laser &&
    wand === toys.wand
  ) {
    return { toys, stimuli }
  }

  return { toys: { yarn, treats, laser, wand }, stimuli }
}
