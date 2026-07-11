import { beforeEach, describe, expect, it } from 'vitest'
import { gaitVelocityPxPerMs } from '../components/catAnimSequences'
import {
  initialPlaygroundState,
  playTransitionDurationMs,
  playgroundAnimationPlanFor,
  type PlayCat,
  type PlaygroundState,
} from './playgroundState'
import { CAT_WIDTH_PX, packedSpotFor } from './sceneModel'
import { applyVerbStimuli, stepPlayground } from './stepPlayground'
import { resetToyLayer } from './toyLayer'
import type { PlaygroundInput } from './playgroundTypes'
import type { BeatContext } from './catBrain.beats'

// Slice D — motion-quality pins: the anti-teleport property, the
// tunnel's sanctioned re-emergence, pose-transition chains, gait
// ease-in / look-before-you-go, the depth cross-fade, and the trio's
// decision desync. All simulations are seeded (deterministic).

const W = 800
const H = 400
const START = 10_000
const DT = 1000 / 60

function lcg(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

function makeInput(over: Partial<PlaygroundInput> = {}): PlaygroundInput {
  return { pointer: null, activeVerb: null, petTarget: null, flick: null, treatTap: null, ...over }
}

function ctxFor(cats: readonly PlayCat[], random: () => number = () => 0.5): BeatContext {
  return { cats, ambient: [], sceneW: W, sceneH: H, compact: false, random }
}

beforeEach(() => {
  resetToyLayer()
})

describe('stepPlayground anti-teleport property (USER REPORT: no instant position changes)', () => {
  // A visible cat's per-frame |dx| may never exceed one dt-clamped run
  // stride (plus float slack). The ONLY exemption is the tunnel-hidden
  // re-emergence, where the prop visually covers the hop.
  const MAX_STEP_PX = gaitVelocityPxPerMs('run', CAT_WIDTH_PX) * 33 + 0.25

  function runSim(seed: number, withLaser: boolean) {
    const random = lcg(seed)
    let now = START
    let state = initialPlaygroundState(now, W, H, random)
    const input = makeInput()
    let maxDx = 0
    let offender = ''
    for (let i = 0; i < 7200; i++) {
      // 2 simulated minutes at 60fps
      now += DT
      if (withLaser) {
        // wave the dot around; toggle the press every ~4s
        const pressed = Math.floor((now - START) / 4000) % 2 === 0
        input.activeVerb = 'laser'
        input.pointer = pressed
          ? { x: 400 + Math.sin(now / 700) * 320, y: 340, down: true }
          : null
      }
      const prevCats = new Map(state.cats.map((c) => [c.id, c]))
      state = stepPlayground(state, input, DT, now, W, H, { random })
      for (const cat of state.cats) {
        const prev = prevCats.get(cat.id)
        if (!prev) continue
        // the sanctioned teleport: hidden inside the tunnel
        if (prev.activity === 'tunnel' || cat.activity === 'tunnel') continue
        const dx = Math.abs(cat.x - prev.x)
        if (dx > maxDx) {
          maxDx = dx
          offender = `${cat.id} ${prev.activity}->${cat.activity} @${((now - START) / 1000).toFixed(1)}s dx=${dx.toFixed(2)}`
        }
      }
    }
    return { maxDx, offender }
  }

  it('Given a 2-minute seeded autonomous run, When every frame is diffed, Then no visible cat ever moves more than one run stride per frame', () => {
    // act
    const { maxDx, offender } = runSim(42, false)

    // assert
    expect(maxDx, offender).toBeLessThanOrEqual(MAX_STEP_PX)
  })

  it('Given a 2-minute seeded run with a waving laser, When every frame is diffed, Then chases and releases still never teleport a cat', () => {
    // act
    const { maxDx, offender } = runSim(7, true)

    // assert
    expect(maxDx, offender).toBeLessThanOrEqual(MAX_STEP_PX)
  })
})

describe('stepPlayground tunnel re-emergence (the one sanctioned teleport)', () => {
  it('Given a cat hidden in the tunnel, When the hidden beat expires, Then it pops out at the FAR mouth, inside the tunnel footprint, and was hidden for the whole hop', () => {
    // arrange — a cat mid-tunnel-dive, walked in facing right
    const random = lcg(3)
    const state = initialPlaygroundState(START, W, H, random)
    const rect = packedSpotFor('tunnel', W, false)
    if (!rect) throw new Error('missing tunnel rect')
    const centerX = rect.left + rect.width / 2 - CAT_WIDTH_PX / 2
    const hidden: PlaygroundState = {
      ...state,
      cats: state.cats.map((c): PlayCat =>
        c.id === 'mushu'
          ? {
              ...c,
              activity: 'tunnel',
              previousActivity: 'walk',
              direction: 'R',
              x: centerX,
              anchorId: 'tunnel_inside',
              targetAnchor: null,
              route: [],
              arrival: null,
              activityStartedAt: START,
              activityUntil: START + 3000,
            }
          : c,
      ),
    }

    // act — step past the expiry
    const next = stepPlayground(hidden, makeInput(), DT, START + 3100, W, H, { random })

    // assert — emerged at the right (far) mouth, still under the prop
    const mushu = next.cats.find((c) => c.id === 'mushu')
    if (!mushu) throw new Error('missing mushu')
    expect(mushu.activity).toBe('stretch')
    const catCenter = mushu.x + CAT_WIDTH_PX / 2
    expect(catCenter).toBeGreaterThan(rect.left + rect.width / 2)
    expect(catCenter).toBeLessThanOrEqual(rect.left + rect.width)
    expect(mushu.x).toBeCloseTo(rect.left + rect.width * 0.85 - CAT_WIDTH_PX / 2, 0)
  })
})

describe('stepPlayground pose-transition chains (no straight jumps between poses)', () => {
  it('Given a sleeping cat hit by a bat stimulus, When the frames play, Then the wake-up transition frames appear BEFORE any bat frame', () => {
    // arrange — Coco asleep on the floor
    const state = initialPlaygroundState(START, W, H, () => 0.5)
    const sleeping = state.cats.map((c): PlayCat =>
      c.id === 'coco'
        ? { ...c, activity: 'sleep', previousActivity: 'sleep', activityStartedAt: START - 5000, phaseTime: START }
        : c,
    )

    // act — the verb brain proposes a bat; the engine applies it
    const batted = applyVerbStimuli(
      sleeping,
      [{ catId: 'coco', request: { type: 'bat' } }],
      state.toys,
      START,
      ctxFor(sleeping),
    )
    const coco = batted.find((c) => c.id === 'coco')
    if (!coco) throw new Error('missing coco')

    // assert — the chain (wake_up + crouch_down) plays first…
    const transitionMs = playTransitionDurationMs('coco', 'sleep', 'bat')
    expect(transitionMs).toBeGreaterThan(300)
    const seen: string[] = []
    for (let t = 10; t < transitionMs + 400; t += 50) {
      const frame = playgroundAnimationPlanFor(coco, START + t).frame
      if (frame) seen.push(frame)
    }
    const firstBat = seen.findIndex((f) => f.startsWith('bat_'))
    expect(firstBat, `frames: ${seen.join(',')}`).toBeGreaterThan(0)
    const beforeBat = seen.slice(0, firstBat)
    expect(beforeBat.some((f) => !f.startsWith('bat_'))).toBe(true)
    // …and the bout does arrive
    expect(seen.some((f) => f.startsWith('bat_'))).toBe(true)
  })
})

describe('stepPlayground gait ease + look-before-you-go', () => {
  function walker(state: PlaygroundState, moveRampAt: number): PlaygroundState {
    return {
      ...state,
      cats: state.cats.map((c): PlayCat =>
        c.id === 'mushu'
          ? {
              ...c,
              activity: 'walk',
              previousActivity: 'sit',
              activityStartedAt: START,
              activityUntil: START + 60000,
              direction: 'L',
              anchorId: null,
              focus: null,
              targetX: c.x + 300,
              targetY: c.y,
              moveRampAt,
            }
          : c,
      ),
    }
  }

  it('Given a fresh travel with a regard hold, When steps run before moveRampAt, Then the cat faces its destination but its paws do not move yet', () => {
    // arrange — hold for 400ms
    const random = lcg(9)
    const state = walker(initialPlaygroundState(START, W, H, random), START + 400)
    const startX = state.cats.find((c) => c.id === 'mushu')?.x ?? 0

    // act — one step inside the hold window
    const held = stepPlayground(state, makeInput(), DT, START + 100, W, H, { random })

    // assert
    const mushu = held.cats.find((c) => c.id === 'mushu')
    expect(mushu?.x).toBe(startX)
    expect(mushu?.direction).toBe('R') // turned toward the target
  })

  it('Given the ramp opens, When the first strides run, Then per-frame dx ramps up monotonically to full stride (never 0-to-full in one frame)', () => {
    // arrange
    const random = lcg(11)
    let state = walker(initialPlaygroundState(START, W, H, random), START)
    let now = START
    let prevX = state.cats.find((c) => c.id === 'mushu')?.x ?? 0

    // act — collect per-frame dx over the ramp window
    const steps: number[] = []
    for (let i = 0; i < 18; i++) {
      now += DT
      state = stepPlayground(state, makeInput(), DT, now, W, H, { random })
      const x = state.cats.find((c) => c.id === 'mushu')?.x ?? 0
      steps.push(x - prevX)
      prevX = x
    }

    // assert — monotone non-decreasing ramp, launching well below full stride
    const fullStride = gaitVelocityPxPerMs('walk', CAT_WIDTH_PX) * DT
    expect(steps[0]).toBeGreaterThan(0)
    expect(steps[0]).toBeLessThan(fullStride * 0.5)
    for (let i = 1; i < steps.length; i++) {
      expect(steps[i], `frame ${i}`).toBeGreaterThanOrEqual(steps[i - 1] - 1e-6)
    }
    expect(steps[steps.length - 1]).toBeCloseTo(fullStride, 1)
  })
})

describe('stepPlayground depth cross-fade (lane switches never pop)', () => {
  it('Given a cat whose logical lane flips to back, When frames step, Then laneBlend eases toward 1 in bounded increments instead of jumping', () => {
    // arrange
    const random = lcg(5)
    const state = initialPlaygroundState(START, W, H, random)
    let flipped: PlaygroundState = {
      ...state,
      cats: state.cats.map((c): PlayCat =>
        c.id === 'mushu' ? { ...c, lane: 'back' } : c,
      ),
    }

    // act + assert — blend climbs by at most dt/450 per frame
    let now = START
    let prevBlend = 0
    for (let i = 0; i < 40; i++) {
      now += DT
      flipped = stepPlayground(flipped, makeInput(), DT, now, W, H, { random })
      const blend = flipped.cats.find((c) => c.id === 'mushu')?.laneBlend ?? 0
      expect(blend - prevBlend).toBeLessThanOrEqual(DT / 450 + 1e-6)
      prevBlend = blend
    }
    expect(prevBlend).toBe(1) // converged after ~450ms
  })
})

describe('stepPlayground trio desync (no lockstep)', () => {
  it('Given a 2-minute seeded autonomous run, When activity-change stamps are collected, Then the three cats never all switch within the same 500ms window', () => {
    // arrange
    const random = lcg(23)
    let now = START
    let state = initialPlaygroundState(now, W, H, random)
    const changes: Record<string, number[]> = { panther: [], mushu: [], coco: [] }
    const prevActivity: Record<string, string> = {}
    for (const c of state.cats) prevActivity[c.id] = c.activity

    // act
    for (let i = 0; i < 7200; i++) {
      now += DT
      state = stepPlayground(state, makeInput(), DT, now, W, H, { random })
      for (const c of state.cats) {
        if (c.activity !== prevActivity[c.id]) {
          changes[c.id].push(now)
          prevActivity[c.id] = c.activity
        }
      }
    }

    // assert — no 500ms window contains a switch from ALL THREE cats
    for (const tp of changes.panther) {
      const mushuNear = changes.mushu.some((t) => Math.abs(t - tp) <= 250)
      const cocoNear = changes.coco.some((t) => Math.abs(t - tp) <= 250)
      expect(
        mushuNear && cocoNear,
        `lockstep at t=${((tp - START) / 1000).toFixed(1)}s`,
      ).toBe(false)
    }
    // sanity: everyone actually lived a life
    expect(changes.panther.length).toBeGreaterThan(3)
    expect(changes.mushu.length).toBeGreaterThan(3)
    expect(changes.coco.length).toBeGreaterThan(3)
  })
})

describe('stepPlayground perch micro-life (FINDING 9: the frozen Panther)', () => {
  it('Given a long perch bout, When 30 seconds pass, Then idle sequences fire and the hold frame between them is seated — never a stuck jump_post', () => {
    // arrange — Panther freshly mounted on the tree top
    const random = lcg(31)
    let state = initialPlaygroundState(START, W, H, random)
    let panther = state.cats.find((c) => c.id === 'panther')
    if (!panther) throw new Error('missing panther')
    state = {
      ...state,
      cats: state.cats.map((c): PlayCat =>
        c.id === 'panther'
          ? { ...c, activityUntil: START + 60_000 } // pin the bout long
          : c,
      ),
    }

    // act — 30 simulated seconds; track idle life and post-transition frames
    let now = START
    let idleSeen = 0
    let stuckJumpPostMs = 0
    for (let i = 0; i < 1800; i++) {
      now += DT
      state = stepPlayground(state, makeInput(), DT, now, W, H, { random })
      panther = state.cats.find((c) => c.id === 'panther')
      if (!panther || panther.activity !== 'perch') break
      if (panther.idleSequence !== null) idleSeen++
      const frame = playgroundAnimationPlanFor(panther, panther.phaseTime).frame
      // after the mount chain has finished, jump_post must never linger
      if (now - panther.activityStartedAt > 4000 && frame === 'jump_post') {
        stuckJumpPostMs += DT
      }
    }

    // assert
    expect(idleSeen).toBeGreaterThan(0)
    expect(stuckJumpPostMs).toBe(0)
  })
})
