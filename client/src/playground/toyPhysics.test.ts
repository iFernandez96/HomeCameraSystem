import { describe, expect, it } from 'vitest'
import type { LaserToy, WandToy, YarnToy, TreatToy } from './playgroundTypes'
import { FRONT_LANE_FLOOR_PCT, SCENE_MARGIN_PX } from './playgroundTypes'
import {
  FLOOR_RESTITUTION,
  FRICTION_PER_FRAME,
  laneFloorY,
  laneForY,
  stepLaser,
  stepTreat,
  stepWand,
  stepYarn,
  WALL_RESTITUTION,
  YARN_DESPAWN_MS,
  yarnExpired,
} from './toyPhysics'

const SCENE_W = 800
const SCENE_H = 400
const FRAME = 1000 / 60

function makeYarn(over: Partial<YarnToy> = {}): YarnToy {
  return {
    kind: 'yarn',
    id: 1,
    x: 400,
    y: laneFloorY('front', SCENE_H),
    vx: 10,
    vy: 0,
    lane: 'front',
    spinPhase: 0,
    restingSince: null,
    ...over,
  }
}

function makeLaser(over: Partial<LaserToy> = {}): LaserToy {
  return { kind: 'laser', on: true, x: 100, y: 100, tx: 300, ty: 200, ...over }
}

function makeWand(over: Partial<WandToy> = {}): WandToy {
  return {
    kind: 'wand',
    held: true,
    hx: 300,
    hy: 100,
    tipX: 100,
    tipY: 100,
    tipVx: 0,
    tipVy: 0,
    ...over,
  }
}

function makeTreat(over: Partial<TreatToy> = {}): TreatToy {
  return {
    kind: 'treat',
    id: 7,
    x: 200,
    y: 40,
    vy: 0,
    lane: 'front',
    state: 'falling',
    claimedBy: null,
    ...over,
  }
}

describe('toyPhysics.stepYarn', () => {
  it('Given a rolling yarn, When one frame elapses, Then friction decays vx by ~0.985 and spin advances', () => {
    // arrange
    const yarn = makeYarn({ vx: 10 })

    // act
    const next = stepYarn(yarn, FRAME, 1000, SCENE_W, SCENE_H)

    // assert
    expect(next.vx).toBeCloseTo(10 * FRICTION_PER_FRAME, 5)
    expect(next.x).toBeGreaterThan(yarn.x)
    expect(next.spinPhase).toBeGreaterThan(0)
  })

  it('Given a yarn heading past the left margin, When it crosses, Then it is clamped to SCENE_MARGIN_PX and vx flips sign at 80%', () => {
    // arrange
    const yarn = makeYarn({ x: SCENE_MARGIN_PX + 1, vx: -10 })

    // act
    const next = stepYarn(yarn, FRAME, 1000, SCENE_W, SCENE_H)

    // assert
    expect(next.x).toBe(SCENE_MARGIN_PX)
    expect(next.vx).toBeGreaterThan(0)
    expect(next.vx).toBeCloseTo(10 * FRICTION_PER_FRAME * WALL_RESTITUTION, 5)
  })

  it('Given an airborne yarn falling onto its lane floor, When it lands, Then vy flips sign keeping 45%', () => {
    // arrange
    const floor = laneFloorY('front', SCENE_H)
    const yarn = makeYarn({ y: floor - 1, vy: 6, vx: 0 })

    // act
    const next = stepYarn(yarn, FRAME, 1000, SCENE_W, SCENE_H)

    // assert — bounce flips downward motion to upward at 45%
    expect(next.y).toBe(floor)
    expect(next.vy).toBeLessThan(0)
    expect(Math.abs(next.vy)).toBeCloseTo((6 + 0.55) * FLOOR_RESTITUTION, 5)
  })

  it('Given a yarn slower than the rest epsilon on the floor, When stepped, Then restingSince is stamped with now and it despawns 30s later', () => {
    // arrange
    const yarn = makeYarn({ vx: 0.0001, vy: 0 })

    // act
    const next = stepYarn(yarn, FRAME, 5000, SCENE_W, SCENE_H)

    // assert
    expect(next.restingSince).toBe(5000)
    expect(next.vx).toBe(0)
    expect(yarnExpired(next, 5000 + YARN_DESPAWN_MS - 1)).toBe(false)
    expect(yarnExpired(next, 5000 + YARN_DESPAWN_MS)).toBe(true)
  })

  it('Given a resting yarn, When stepped again, Then the SAME reference comes back (ref-stable bail-out)', () => {
    // arrange
    const resting = makeYarn({ vx: 0, vy: 0, restingSince: 5000 })

    // act
    const next = stepYarn(resting, FRAME, 6000, SCENE_W, SCENE_H)

    // assert
    expect(next).toBe(resting)
  })

  it('Given the same yarn throw, When integrated 1s at 60fps vs 30fps, Then the trajectories agree within tolerance (dt-normalized)', () => {
    // arrange
    let at60 = makeYarn({ x: 100, y: 100, vx: 8, vy: -4 })
    let at30 = makeYarn({ x: 100, y: 100, vx: 8, vy: -4 })

    // act — one simulated second each
    for (let i = 0; i < 60; i++) at60 = stepYarn(at60, FRAME, 0, SCENE_W, SCENE_H)
    for (let i = 0; i < 30; i++) at30 = stepYarn(at30, FRAME * 2, 0, SCENE_W, SCENE_H)

    // assert — substepped integration keeps 30fps on the 60fps path
    expect(at30.x).toBeCloseTo(at60.x, 3)
    expect(at30.y).toBeCloseTo(at60.y, 3)
  })
})

describe('toyPhysics.stepTreat', () => {
  it('Given a falling treat, When it reaches its lane floor, Then it lands with vy 0 exactly on the floor line', () => {
    // arrange
    let treat = makeTreat()
    const floor = SCENE_H * FRONT_LANE_FLOOR_PCT

    // act — fall until landed (bounded loop so a bug cannot hang the suite)
    for (let i = 0; i < 600 && treat.state === 'falling'; i++) {
      treat = stepTreat(treat, FRAME, SCENE_H)
    }

    // assert
    expect(treat.state).toBe('landed')
    expect(treat.y).toBe(floor)
    expect(treat.vy).toBe(0)
  })

  it('Given a landed treat, When stepped, Then the SAME reference comes back', () => {
    // arrange
    const landed = makeTreat({ state: 'landed', vy: 0 })

    // act
    const next = stepTreat(landed, FRAME, SCENE_H)

    // assert
    expect(next).toBe(landed)
  })
})

describe('toyPhysics.stepLaser', () => {
  it('Given an on dot away from its target, When stepped repeatedly, Then the gap shrinks monotonically to a snap', () => {
    // arrange
    let laser = makeLaser()
    let prevGap = Math.hypot(laser.tx - laser.x, laser.ty - laser.y)

    // act / assert — every step closes the gap (monotone easing)
    for (let i = 0; i < 60; i++) {
      laser = stepLaser(laser, FRAME)
      const gap = Math.hypot(laser.tx - laser.x, laser.ty - laser.y)
      expect(gap).toBeLessThanOrEqual(prevGap)
      prevGap = gap
    }
    expect(laser.x).toBeCloseTo(laser.tx, 0)
    expect(laser.y).toBeCloseTo(laser.ty, 0)
  })

  it('Given an off dot, When stepped, Then the SAME reference comes back', () => {
    // arrange
    const off = makeLaser({ on: false })

    // act
    const next = stepLaser(off, FRAME)

    // assert
    expect(next).toBe(off)
  })

  it('Given the same dot, When eased 0.5s at 60fps vs 30fps, Then positions agree within tolerance', () => {
    // arrange
    let at60 = makeLaser()
    let at30 = makeLaser()

    // act
    for (let i = 0; i < 30; i++) at60 = stepLaser(at60, FRAME)
    for (let i = 0; i < 15; i++) at30 = stepLaser(at30, FRAME * 2)

    // assert
    expect(at30.x).toBeCloseTo(at60.x, 3)
    expect(at30.y).toBeCloseTo(at60.y, 3)
  })
})

describe('toyPhysics.stepWand', () => {
  it('Given a held wand with the tip away from the handle, When stepped for 3s, Then the tip converges onto the handle without oscillating past it', () => {
    // arrange
    let wand = makeWand()

    // act
    let maxX = wand.tipX
    for (let i = 0; i < 180; i++) {
      wand = stepWand(wand, FRAME)
      maxX = Math.max(maxX, wand.tipX)
    }

    // assert — critical damping: converged, never overshot the handle
    expect(wand.tipX).toBeCloseTo(wand.hx, 0)
    expect(wand.tipY).toBeCloseTo(wand.hy, 0)
    expect(maxX).toBeLessThanOrEqual(wand.hx + 1)
  })

  it('Given a settled held wand, When stepped, Then the SAME reference comes back', () => {
    // arrange
    const settled = makeWand({ tipX: 300, tipY: 100 })

    // act
    const next = stepWand(settled, FRAME)

    // assert
    expect(next).toBe(settled)
  })

  it('Given an unheld wand, When stepped, Then the SAME reference comes back', () => {
    // arrange
    const idle = makeWand({ held: false })

    // act
    const next = stepWand(idle, FRAME)

    // assert
    expect(next).toBe(idle)
  })
})

describe('toyPhysics.laneForY', () => {
  it('Given ys above and below the floor midpoint, When classified, Then back and front lanes come out respectively', () => {
    // arrange / act / assert
    expect(laneForY(0.6 * SCENE_H, SCENE_H)).toBe('back')
    expect(laneForY(0.85 * SCENE_H, SCENE_H)).toBe('front')
  })
})
