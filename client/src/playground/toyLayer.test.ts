import { beforeEach, describe, expect, it } from 'vitest'
import type { PlaygroundInput, ToyState } from './playgroundTypes'
import {
  INITIAL_TOY_STATE,
  MAX_TREATS,
  resetToyLayer,
  stepToyLayer,
  YARN_MAX_SPEED,
} from './toyLayer'

const SCENE_W = 800
const SCENE_H = 400
const FRAME = 1000 / 60

function makeInput(over: Partial<PlaygroundInput> = {}): PlaygroundInput {
  return {
    pointer: null,
    activeVerb: null,
    petTarget: null,
    flick: null,
    treatTap: null,
    ...over,
  }
}

function step(
  toys: ToyState,
  input: PlaygroundInput,
  now = 1000,
): ReturnType<typeof stepToyLayer> {
  return stepToyLayer(toys, input, FRAME, now, SCENE_W, SCENE_H)
}

beforeEach(() => {
  resetToyLayer()
})

describe('toyLayer one-shot consumption', () => {
  it('Given a flick in the input, When the layer steps, Then a yarn spawns and input.flick is nulled', () => {
    // arrange
    const input = makeInput({ flick: { x: 200, y: 100, vx: 0.5, vy: -0.2 } })

    // act
    const { toys } = step(INITIAL_TOY_STATE, input)

    // assert
    expect(input.flick).toBeNull()
    expect(toys.yarn).not.toBeNull()
    expect(toys.yarn?.vx).toBeGreaterThan(0)
  })

  it('Given a violent flick, When the yarn spawns, Then its speed is capped at YARN_MAX_SPEED', () => {
    // arrange — 10 px/ms would be 167 px/frame uncapped
    const input = makeInput({ flick: { x: 200, y: 100, vx: 10, vy: 0 } })

    // act
    const { toys } = step(INITIAL_TOY_STATE, input)

    // assert
    const speed = Math.hypot(toys.yarn?.vx ?? 0, toys.yarn?.vy ?? 0)
    expect(speed).toBeLessThanOrEqual(YARN_MAX_SPEED + 1e-9)
  })

  it('Given a yarn already in flight, When a second flick lands, Then THE single yarn is replaced (new id), never duplicated', () => {
    // arrange
    const first = step(INITIAL_TOY_STATE, makeInput({ flick: { x: 200, y: 100, vx: 0.5, vy: 0 } }))
    const firstId = first.toys.yarn?.id

    // act
    const second = step(
      first.toys,
      makeInput({ flick: { x: 400, y: 100, vx: -0.5, vy: 0 } }),
    )

    // assert
    expect(second.toys.yarn?.id).not.toBe(firstId)
    expect(second.toys.yarn?.x).toBeLessThanOrEqual(400)
  })

  it('Given a treat tap, When the layer steps, Then a falling treat spawns and input.treatTap is nulled', () => {
    // arrange
    const input = makeInput({ treatTap: { x: 300, y: 50, lane: 'front' } })

    // act
    const { toys } = step(INITIAL_TOY_STATE, input)

    // assert
    expect(input.treatTap).toBeNull()
    expect(toys.treats).toHaveLength(1)
    expect(toys.treats[0].state).toBe('falling')
  })

  it('Given the treat cap is reached, When another tap lands, Then it is consumed but no treat spawns', () => {
    // arrange — fill to the cap
    let toys: ToyState = INITIAL_TOY_STATE
    for (let i = 0; i < MAX_TREATS; i++) {
      toys = step(toys, makeInput({ treatTap: { x: 100 + i * 50, y: 50, lane: 'front' } })).toys
    }
    const overflow = makeInput({ treatTap: { x: 400, y: 50, lane: 'front' } })

    // act
    const result = step(toys, overflow)

    // assert — consumed (no retry loop) but capped
    expect(overflow.treatTap).toBeNull()
    expect(result.toys.treats).toHaveLength(MAX_TREATS)
  })
})

describe('toyLayer ref stability', () => {
  it('Given no toys and no input, When the layer steps, Then the SAME ToyState reference comes back', () => {
    // arrange
    const input = makeInput()

    // act
    const { toys, stimuli } = step(INITIAL_TOY_STATE, input)

    // assert
    expect(toys).toBe(INITIAL_TOY_STATE)
    expect(stimuli).toEqual([])
  })

  it('Given a yarn that has come to rest, When the layer keeps stepping, Then the ToyState reference stays stable until despawn', () => {
    // arrange — throw, then run until the yarn rests
    let { toys } = step(
      INITIAL_TOY_STATE,
      makeInput({ flick: { x: 400, y: 300, vx: 0.05, vy: 0 } }),
      0,
    )
    let now = 0
    for (let i = 0; i < 3000 && toys.yarn?.restingSince === null; i++) {
      now += FRAME
      toys = step(toys, makeInput(), now).toys
    }
    expect(toys.yarn?.restingSince).not.toBeNull()

    // act — one more idle step
    const again = step(toys, makeInput(), now + FRAME)

    // assert
    expect(again.toys).toBe(toys)
  })

  it('Given a resting yarn past 30s, When the layer steps, Then the yarn despawns', () => {
    // arrange
    let { toys } = step(
      INITIAL_TOY_STATE,
      makeInput({ flick: { x: 400, y: 300, vx: 0.05, vy: 0 } }),
      0,
    )
    let now = 0
    for (let i = 0; i < 3000 && toys.yarn?.restingSince === null; i++) {
      now += FRAME
      toys = step(toys, makeInput(), now).toys
    }
    const restedAt = toys.yarn?.restingSince ?? 0

    // act
    const after = step(toys, makeInput(), restedAt + 30_000)

    // assert
    expect(after.toys.yarn).toBeNull()
  })
})

describe('toyLayer laser + wand driving', () => {
  it('Given the laser verb and a held pointer, When the layer steps, Then the dot turns on AT the pointer (no fly-in)', () => {
    // arrange
    const input = makeInput({
      activeVerb: 'laser',
      pointer: { x: 250, y: 150, down: true },
    })

    // act
    const { toys } = step(INITIAL_TOY_STATE, input)

    // assert
    expect(toys.laser.on).toBe(true)
    expect(toys.laser.x).toBe(250)
    expect(toys.laser.y).toBe(150)
  })

  it('Given a lit dot, When the pointer lifts, Then the dot turns off', () => {
    // arrange
    const lit = step(
      INITIAL_TOY_STATE,
      makeInput({ activeVerb: 'laser', pointer: { x: 250, y: 150, down: true } }),
    ).toys

    // act
    const { toys } = step(lit, makeInput({ activeVerb: 'laser', pointer: null }))

    // assert
    expect(toys.laser.on).toBe(false)
  })

  it('Given the wand verb and a moving pointer, When the layer steps, Then the handle tracks the pointer instantly and the tip lags behind', () => {
    // arrange
    const grabbed = step(
      INITIAL_TOY_STATE,
      makeInput({ activeVerb: 'wand', pointer: { x: 100, y: 100, down: true } }),
    ).toys

    // act — handle jumps, tip springs
    const { toys } = step(
      grabbed,
      makeInput({ activeVerb: 'wand', pointer: { x: 300, y: 100, down: true } }),
    )

    // assert
    expect(toys.wand.held).toBe(true)
    expect(toys.wand.hx).toBe(300) // instant (Swink rule)
    expect(toys.wand.tipX).toBeLessThan(300) // critically-damped lag
    expect(toys.wand.tipX).toBeGreaterThanOrEqual(100)
  })
})

describe('toyLayer stimuli plumbing', () => {
  it('Given cat views and a seeded random in ctx, When a treat lands beside Mushu, Then an eat stimulus flows out and the treat is claimed', () => {
    // arrange — drop a treat and let it land
    let toys = step(
      INITIAL_TOY_STATE,
      makeInput({ treatTap: { x: 300, y: 340, lane: 'front' } }),
      0,
    ).toys
    let now = 0
    for (let i = 0; i < 600 && toys.treats[0]?.state === 'falling'; i++) {
      now += FRAME
      toys = step(toys, makeInput(), now).toys
    }
    expect(toys.treats[0]?.state).toBe('landed')
    const mushu = {
      id: 'mushu' as const,
      x: toys.treats[0].x,
      y: toys.treats[0].y,
      lane: 'front' as const,
      focus: null,
      asleep: false,
    }

    // act
    const result = stepToyLayer(toys, makeInput(), FRAME, now + FRAME, SCENE_W, SCENE_H, {
      cats: [mushu],
      random: () => 0.99,
    })

    // assert
    expect(result.stimuli).toContainEqual({
      catId: 'mushu',
      request: { type: 'eat', treatId: toys.treats[0].id },
    })
    expect(result.toys.treats[0].state).toBe('claimed')
    expect(result.toys.treats[0].claimedBy).toBe('mushu')
  })

  it('Given no ctx (Slice B integrating incrementally), When the layer steps, Then toys run and stimuli stay empty', () => {
    // arrange
    const input = makeInput({ flick: { x: 200, y: 100, vx: 0.5, vy: 0 } })

    // act
    const { toys, stimuli } = step(INITIAL_TOY_STATE, input)

    // assert
    expect(toys.yarn).not.toBeNull()
    expect(stimuli).toEqual([])
  })
})
