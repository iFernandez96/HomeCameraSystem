import { describe, expect, it } from 'vitest'
import type { ToyState, VerbStimulus } from './playgroundTypes'
import type { VerbBrain, VerbCatView } from './catBrain.verbs'
import {
  COCO_LASER_NEAR_PX,
  createVerbBrain,
  MUSHU_LASER_REACT_MS,
  PANTHER_PET_COOLDOWN_MS,
  PANTHER_SIT_MS,
  stepVerbBrain,
} from './catBrain.verbs'

const SCENE_H = 400

// A seeded roll queue: pops values in order, repeats the last one.
function rolls(...values: number[]): () => number {
  let i = 0
  return () => values[Math.min(i++, values.length - 1)]
}

function makeToys(over: Partial<ToyState> = {}): ToyState {
  return {
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
    ...over,
  }
}

function cat(id: VerbCatView['id'], over: Partial<VerbCatView> = {}): VerbCatView {
  return { id, x: 100, y: 350, lane: 'front', focus: null, asleep: false, ...over }
}

function tick(
  brain: VerbBrain,
  toys: ToyState,
  cats: readonly VerbCatView[],
  now: number,
  random: () => number = rolls(0.99),
  petTarget: VerbCatView['id'] | null = null,
): VerbStimulus[] {
  return stepVerbBrain(brain, {
    toys,
    cats,
    input: { petTarget },
    random,
    now,
    sceneH: SCENE_H,
  })
}

function forCat(stimuli: VerbStimulus[], id: VerbCatView['id']): VerbStimulus | undefined {
  return stimuli.find((s) => s.catId === id)
}

describe('catBrain.verbs laser', () => {
  it('Given the laser turns on, When 300ms have not yet passed, Then Mushu holds; after 300ms he chases at a run', () => {
    // arrange
    const brain = createVerbBrain()
    const laserOn = makeToys({
      laser: { kind: 'laser', on: true, x: 300, y: 300, tx: 300, ty: 300 },
    })
    const mushu = cat('mushu')

    // act
    const before = tick(brain, laserOn, [mushu], 1000)
    const after = tick(brain, laserOn, [mushu], 1000 + MUSHU_LASER_REACT_MS)

    // assert
    expect(forCat(before, 'mushu')).toBeUndefined()
    expect(forCat(after, 'mushu')?.request).toMatchObject({
      type: 'chase',
      targetX: 300,
      targetY: 300,
      gait: 'run',
    })
  })

  it('Given Panther rolls under 0.4 on activation, When the laser stays on, Then she ignores it with a single judging grump', () => {
    // arrange — seeded roll 0.2 < 0.4 takes the ignore branch
    const brain = createVerbBrain()
    const laserOn = makeToys({
      laser: { kind: 'laser', on: true, x: 300, y: 300, tx: 300, ty: 300 },
    })
    const panther = cat('panther')

    // act
    const first = tick(brain, laserOn, [panther], 1000, rolls(0.2))
    const second = tick(brain, laserOn, [panther], 2000, rolls(0.2))
    const later = tick(brain, laserOn, [panther], 60_000, rolls(0.2))

    // assert — one grump, then silence for the whole activation
    expect(forCat(first, 'panther')?.request).toEqual({ type: 'grump' })
    expect(forCat(second, 'panther')).toBeUndefined()
    expect(forCat(later, 'panther')).toBeUndefined()
  })

  it('Given Panther rolls the engage branch, When her 2-4s delay elapses, Then she chases, sits on the caught dot for 5s, and releases', () => {
    // arrange — first roll 0.9 (engage), second roll 0 (minimum 2s delay)
    const brain = createVerbBrain()
    const farDot = makeToys({
      laser: { kind: 'laser', on: true, x: 300, y: 350, tx: 300, ty: 350 },
    })
    const panther = cat('panther', { x: 100, y: 350 })
    const random = rolls(0.9, 0)

    // act / assert — silent through the dignified delay
    expect(forCat(tick(brain, farDot, [panther], 0, random), 'panther')).toBeUndefined()
    expect(forCat(tick(brain, farDot, [panther], 1999, random), 'panther')).toBeUndefined()

    // chases once the delay elapses
    const chasing = forCat(tick(brain, farDot, [panther], 2000, random), 'panther')
    expect(chasing?.request).toMatchObject({ type: 'chase' })

    // she reaches the dot: sit begins (no stimulus — she parks on it)
    const onDot = cat('panther', { x: 300, y: 350 })
    expect(forCat(tick(brain, farDot, [onDot], 3000, random), 'panther')).toBeUndefined()

    // 5s of sitting later she releases and is done with this activation
    const released = forCat(
      tick(brain, farDot, [onDot], 3000 + PANTHER_SIT_MS, random),
      'panther',
    )
    expect(released?.request).toEqual({ type: 'release' })
    expect(forCat(tick(brain, farDot, [onDot], 20_000, random), 'panther')).toBeUndefined()
  })

  it('Given Coco, When the dot passes within 60px only once, Then she sleeps through; on the second pass she slow-bats then gives up', () => {
    // arrange
    const brain = createVerbBrain()
    const coco = cat('coco', { x: 100, y: 350 })
    const dotNear = makeToys({
      laser: { kind: 'laser', on: true, x: 100 + COCO_LASER_NEAR_PX - 10, y: 350, tx: 0, ty: 0 },
    })
    const dotFar = makeToys({
      laser: { kind: 'laser', on: true, x: 300, y: 350, tx: 0, ty: 0 },
    })

    // act — pass 1 (near, then away), pass 2 (near again)
    const pass1 = tick(brain, dotNear, [coco], 1000)
    tick(brain, dotFar, [coco], 2000)
    const pass2 = tick(brain, dotNear, [coco], 3000)
    const afterBats = [
      tick(brain, dotNear, [coco], 4300),
      tick(brain, dotNear, [coco], 5600),
      tick(brain, dotNear, [coco], 6900),
    ]

    // assert — first pass ignored, second pass earns slow bats, then she quits
    expect(forCat(pass1, 'coco')).toBeUndefined()
    expect(forCat(pass2, 'coco')?.request).toEqual({ type: 'bat' })
    const laterBats = afterBats.flatMap((s) => (forCat(s, 'coco') ? [forCat(s, 'coco')] : []))
    expect(laterBats.length).toBeLessThanOrEqual(1) // one more at most, then gives up
  })

  it('Given a cat focused on the laser, When the dot switches off, Then a release is proposed', () => {
    // arrange
    const brain = createVerbBrain()
    const off = makeToys()
    const chaser = cat('mushu', { focus: { type: 'toy', toy: 'laser' } })

    // act
    const stimuli = tick(brain, off, [chaser], 1000)

    // assert
    expect(forCat(stimuli, 'mushu')?.request).toEqual({ type: 'release' })
  })
})

describe('catBrain.verbs treats', () => {
  const landedTreat = makeToys({
    treats: [
      {
        kind: 'treat',
        id: 5,
        x: 300,
        y: 352,
        vy: 0,
        lane: 'front',
        state: 'landed',
        claimedBy: null,
      },
    ],
  })

  it('Given a landed treat, When Mushu is free, Then he RUNS to it and eats on arrival', () => {
    // arrange
    const brain = createVerbBrain()
    const far = cat('mushu', { x: 100 })
    const arrived = cat('mushu', { x: 300, y: 352 })

    // act
    const chasing = forCat(tick(brain, landedTreat, [far], 1000), 'mushu')
    const eating = forCat(tick(brain, landedTreat, [arrived], 2000), 'mushu')

    // assert
    expect(chasing?.request).toMatchObject({ type: 'chase', gait: 'run' })
    expect(eating?.request).toEqual({ type: 'eat', treatId: 5 })
  })

  it('Given another cat within 80px of the treat, When Panther considers it, Then she WAITS; once clear she walks over', () => {
    // arrange
    const brain = createVerbBrain()
    const panther = cat('panther', { x: 100 })
    const crowder = cat('mushu', { x: 310, y: 352 })
    const farMushu = cat('mushu', { x: 700, y: 352, focus: { type: 'anchor', anchorId: 'rug' } })

    // act
    const crowded = forCat(tick(brain, landedTreat, [panther, crowder], 1000), 'panther')
    const clear = forCat(tick(brain, landedTreat, [panther, farMushu], 2000), 'panther')

    // assert
    expect(crowded).toBeUndefined()
    expect(clear?.request).toMatchObject({ type: 'chase', gait: 'walk' })
  })

  it('Given Coco asleep and committed to an anchor, When a treat lands, Then she preempts and trots anyway (her only high-energy trigger)', () => {
    // arrange
    const brain = createVerbBrain()
    const napping = cat('coco', {
      x: 600,
      asleep: true,
      focus: { type: 'anchor', anchorId: 'nook' },
    })

    // act
    const stimulus = forCat(tick(brain, landedTreat, [napping], 1000), 'coco')

    // assert
    expect(stimulus?.request).toMatchObject({ type: 'chase', gait: 'run', targetX: 300 })
  })

  it('Given Mushu already committed to an anchor beat, When a treat lands, Then he does NOT preempt (focus commitment)', () => {
    // arrange
    const brain = createVerbBrain()
    const busy = cat('mushu', { focus: { type: 'anchor', anchorId: 'rug' } })

    // act
    const stimulus = forCat(tick(brain, landedTreat, [busy], 1000), 'mushu')

    // assert
    expect(stimulus).toBeUndefined()
  })
})

describe('catBrain.verbs yarn', () => {
  function yarnAt(x: number, y: number, resting = false): ToyState {
    return makeToys({
      yarn: {
        kind: 'yarn',
        id: 9,
        x,
        y,
        vx: resting ? 0 : 5,
        vy: 0,
        lane: 'front',
        spinPhase: 0,
        restingSince: resting ? 1 : null,
      },
    })
  }

  it('Given a rolling yarn far away, When Mushu is free, Then he first-responds with a run; in reach he bats', () => {
    // arrange
    const brain = createVerbBrain()
    const far = cat('mushu', { x: 700 })
    const close = cat('mushu', { x: 310, y: 350 })

    // act
    const chasing = forCat(tick(brain, yarnAt(300, 350), [far], 1000), 'mushu')
    const batting = forCat(tick(brain, yarnAt(300, 350), [close], 2000), 'mushu')

    // assert
    expect(chasing?.request).toMatchObject({ type: 'chase', gait: 'run' })
    expect(batting?.request).toEqual({ type: 'bat' })
  })

  it('Given a yarn outside her 120px zone, When Panther is free, Then she does not join; inside the zone she bats 1-2 times then stops', () => {
    // arrange — zone roll 0.9 grants 2 dignified bats
    const brain = createVerbBrain()
    const outside = cat('panther', { x: 700 })
    const inZone = cat('panther', { x: 310, y: 350 })
    const random = rolls(0.9)

    // act
    const ignored = forCat(tick(brain, yarnAt(300, 350), [outside], 1000, random), 'panther')
    const bat1 = forCat(tick(brain, yarnAt(300, 350), [inZone], 2000, random), 'panther')
    const bat2 = forCat(tick(brain, yarnAt(300, 350), [inZone], 3000, random), 'panther')
    const done = forCat(tick(brain, yarnAt(300, 350), [inZone], 4000, random), 'panther')

    // assert
    expect(ignored).toBeUndefined()
    expect(bat1?.request).toEqual({ type: 'bat' })
    expect(bat2?.request).toEqual({ type: 'bat' })
    expect(done).toBeUndefined()
  })

  it('Given a MOVING yarn beside Coco, When she is free, Then she only watches; once it RESTS beside her she bats it', () => {
    // arrange
    const brain = createVerbBrain()
    const coco = cat('coco', { x: 310, y: 350 })

    // act
    const moving = forCat(tick(brain, yarnAt(300, 350, false), [coco], 1000), 'coco')
    const resting = forCat(tick(brain, yarnAt(300, 350, true), [coco], 2000), 'coco')

    // assert
    expect(moving).toBeUndefined()
    expect(resting?.request).toEqual({ type: 'bat' })
  })
})

describe('catBrain.verbs petting', () => {
  it('Given a press-and-hold on Mushu, When the hold starts, Then a purr lands immediately and a release follows the hold ending', () => {
    // arrange
    const brain = createVerbBrain()
    const toys = makeToys()
    const mushu = cat('mushu')

    // act
    const start = tick(brain, toys, [mushu], 1000, rolls(0.5), 'mushu')
    const held = tick(brain, toys, [mushu], 2000, rolls(0.5), 'mushu')
    const ended = tick(brain, toys, [mushu], 3000, rolls(0.5), null)

    // assert
    expect(forCat(start, 'mushu')?.request).toEqual({ type: 'purr' })
    expect(forCat(held, 'mushu')).toBeUndefined()
    expect(forCat(ended, 'mushu')?.request).toEqual({ type: 'release' })
  })

  it('Given a long hold on Panther, When ~2s of tolerance elapses, Then she grumps and an 8s cooldown blocks the next purr', () => {
    // arrange — jitter roll 0.5 pins tolerance at exactly 2000ms
    const brain = createVerbBrain()
    const toys = makeToys()
    const panther = cat('panther')
    const random = rolls(0.5)

    // act
    const start = tick(brain, toys, [panther], 1000, random, 'panther')
    const stillOk = tick(brain, toys, [panther], 2500, random, 'panther')
    const grumped = tick(brain, toys, [panther], 3001, random, 'panther')
    const retryInCooldown = tick(brain, toys, [panther], 3001 + 4000, random, 'panther')
    const retryAfter = tick(
      brain,
      toys,
      [panther],
      3001 + PANTHER_PET_COOLDOWN_MS + 1,
      random,
      'panther',
    )

    // assert
    expect(forCat(start, 'panther')?.request).toEqual({ type: 'purr' })
    expect(forCat(stillOk, 'panther')).toBeUndefined()
    expect(forCat(grumped, 'panther')?.request).toEqual({ type: 'grump' })
    expect(forCat(retryInCooldown, 'panther')).toBeUndefined()
    expect(forCat(retryAfter, 'panther')?.request).toEqual({ type: 'purr' })
  })

  it('Given a cat mid-toy-focus, When a pet hold starts, Then petting preempts with a purr anyway', () => {
    // arrange
    const brain = createVerbBrain()
    const laserOn = makeToys({
      laser: { kind: 'laser', on: true, x: 300, y: 300, tx: 300, ty: 300 },
    })
    const chasing = cat('mushu', { focus: { type: 'toy', toy: 'laser' } })

    // act
    const stimuli = tick(brain, laserOn, [chasing], 1000, rolls(0.5), 'mushu')

    // assert
    expect(forCat(stimuli, 'mushu')?.request).toEqual({ type: 'purr' })
  })
})
