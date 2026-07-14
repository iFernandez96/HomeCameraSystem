import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { travelToAnchor, type BeatContext } from './catBrain.beats'
import {
  PLAY_HOLD_FRAME,
  PLAY_ONGOING_SEQUENCE,
  initialPlaygroundState,
  playgroundAnimationPlanFor,
  type PlayCat,
  type PlaygroundState,
} from './playgroundState'
import { CAT_WIDTH_PX, laneFloorY } from './sceneModel'
import { applyVerbStimuli, stepPlayground } from './stepPlayground'
import { INITIAL_TOY_STATE, resetToyLayer } from './toyLayer'
import type {
  PlaygroundInput,
  ToyState,
  VerbStimulus,
} from './playgroundTypes'

const W = 800
const H = 400
const START = 10_000

function makeInput(over: Partial<PlaygroundInput> = {}): PlaygroundInput {
  return { pointer: null, activeVerb: null, petTarget: null, flick: null, treatTap: null, ...over }
}

function freshState(now = START): PlaygroundState {
  return initialPlaygroundState(now, W, H, () => 0.5)
}

function ctxFor(cats: readonly PlayCat[]): BeatContext {
  return { cats, ambient: [], sceneW: W, sceneH: H, compact: false, now: START, random: () => 0.5 }
}

function stim(catId: PlayCat['id'], request: VerbStimulus['request']): VerbStimulus {
  return { catId, request }
}

beforeEach(() => {
  // The toy layer's verb brain is module-level session state.
  resetToyLayer()
})

afterEach(() => {
  vi.restoreAllMocks()
})

function lcg(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

describe('stepPlayground ground-poop lifecycle (2026-07-11: poop is a ground object, not a bubble)', () => {
  function poopedCat(cat: PlayCat, over: Partial<PlayCat> = {}): PlayCat {
    return {
      ...cat,
      x: 300,
      y: laneFloorY('front', H),
      lane: 'front',
      activity: 'pooped',
      previousActivity: 'pooped',
      direction: 'L',
      activityStartedAt: START - 4500,
      activityUntil: START,
      anchorId: null,
      targetAnchor: null,
      route: [],
      arrival: null,
      mood: null,
      focus: null,
      ...over,
    }
  }

  function withCat(state: PlaygroundState, next: PlayCat): PlaygroundState {
    return { ...state, cats: state.cats.map((c) => (c.id === next.id ? next : c)) }
  }

  function mushuOf(state: PlaygroundState): PlayCat {
    const mushu = state.cats.find((c) => c.id === 'mushu')
    if (!mushu) throw new Error('missing mushu')
    return mushu
  }

  it('Given a floor squat whose bout completes, When the beat expires, Then the poop appears ON THE GROUND at the trailing edge and the cat moves on to its next beat', () => {
    // arrange — mushu mid-squat on the open floor, bout just ended
    const base = freshState()
    const state = withCat(base, poopedCat(mushuOf(base)))

    // act — expiry tick (dt after activityUntil)
    const stepped = stepPlayground(state, makeInput(), 16, START + 1, W, H, {
      compact: false,
      random: () => 0.5,
    })

    // assert — spawned at bout END, trailing the left-facing cat
    const mushu = mushuOf(stepped)
    expect(mushu.poop).not.toBeNull()
    expect(mushu.poop?.x).toBe(336) // 300 + 44 - round(44*0.42)*0.45
    expect(mushu.poop?.y).toBe(laneFloorY('front', H))
    expect(mushu.poop?.lane).toBe('front')
    expect(mushu.poop?.spawnedAt).toBe(START + 1)
    expect(mushu.poop?.fadeAt).toBe(START + 1 + 7000) // 6000 + 0.5 * 2000
    // the squat itself ended — a new beat rolled
    expect(mushu.lastBeatId).not.toBeNull()
  })

  it('Given a live poop, When the cat walks away on later ticks, Then the poop persists past the activity at its original spot', () => {
    // arrange — poop already down, cat off doing something else
    const base = freshState()
    const walkingAway = poopedCat(mushuOf(base), {
      activity: 'walk',
      previousActivity: 'pooped',
      activityUntil: START + 60_000,
      targetX: 500,
      targetY: laneFloorY('front', H),
      moveRampAt: START,
      poop: { x: 336, y: laneFloorY('front', H), lane: 'front', spawnedAt: START, fadeAt: START + 7000 },
    })

    // act — a mid-lifecycle tick (before fadeAt)
    const stepped = stepPlayground(withCat(base, walkingAway), makeInput(), 16, START + 3000, W, H, {
      compact: false,
      random: () => 0.5,
    })

    // assert — untouched, still anchored to its scene spot
    const after = mushuOf(stepped)
    expect(after.poop).toEqual(walkingAway.poop)
    expect(after.activity).not.toBe('pooped')
  })

  it('Given the visible window and fade have fully played out, When the world steps, Then the poop leaves state', () => {
    // arrange
    const base = freshState()
    const sitting = poopedCat(mushuOf(base), {
      activity: 'sit',
      previousActivity: 'sit',
      activityUntil: START + 60_000,
      poop: { x: 336, y: laneFloorY('front', H), lane: 'front', spawnedAt: START, fadeAt: START + 7000 },
    })

    // act — beyond fadeAt + the 600ms fade
    const stepped = stepPlayground(withCat(base, sitting), makeInput(), 16, START + 7601, W, H, {
      compact: false,
      random: () => 0.5,
    })

    // assert
    expect(mushuOf(stepped).poop).toBeNull()
  })

  it('Given a squat AT the litter box, When the bout completes, Then no visible ground poop spawns (the box masks it)', () => {
    // arrange — anchored litter visit
    const base = freshState()
    const state = withCat(base, poopedCat(mushuOf(base), { anchorId: 'litter_box' }))

    // act
    const stepped = stepPlayground(state, makeInput(), 16, START + 1, W, H, {
      compact: false,
      random: () => 0.5,
    })

    // assert
    expect(mushuOf(stepped).poop).toBeNull()
  })
})

describe('stepPlayground interaction proximity gate', () => {
  it('Given two cats superposed mid-pass, When the interaction window is evaluated, Then no interaction grounds them inside each other (10Hz audit, 2026-07-11)', () => {
    // arrange — two floor cats at 2px apart (they can walk through each
    // other), both idle and interaction-eligible. Grounding a snuggle
    // here would freeze them visually merged for seconds.
    const state = freshState()
    const cats = state.cats.map((c) =>
      c.id === 'coco'
        ? { ...c, x: 300, y: laneFloorY('front', H), lane: 'front' as const, activity: 'sit' as const, anchorId: null, targetAnchor: null, lastInteractedWith: null, lastInteractedAt: 0 }
        : c.id === 'mushu'
          ? { ...c, x: 302, y: laneFloorY('front', H), lane: 'front' as const, activity: 'sit' as const, anchorId: null, targetAnchor: null, lastInteractedWith: null, lastInteractedAt: 0 }
          : c,
    )
    const withPair: PlaygroundState = { ...state, cats, lastInteractionAt: 0 }

    // act — step past the interaction cooldown with random forced to
    // always roll an interaction if the gate lets it through.
    const stepped = stepPlayground(withPair, makeInput(), 16, START + 60_000, W, H, {
      compact: false,
      random: () => 0.01,
    })

    // assert — the pair stays un-grounded: no interaction fired, so
    // lastInteractionAt is unchanged (superposed cats keep walking).
    expect(stepped.lastInteractionAt).toBe(0)
  })
})

describe('stepPlayground bail-out discipline', () => {
  it('Given nothing moves in a quiet frame, When the world steps, Then the ORIGINAL state reference comes back (React setState bails out)', () => {
    // arrange — home poses hold, no toys, no ambient due, idle gap open.
    // The quiet frames land AFTER the spawn transition (jump_post) so no
    // sprite timeline is advancing phaseTime, and BEFORE the first idle
    // micro-beat / beat expiry / ambient spawn. The first post-transition
    // step legitimately changes state once (it snaps the frozen phase
    // clock to the transition's end — the jump_post statue fix); the
    // steady state after it must bail out.
    const state = freshState()
    const settled = stepPlayground(state, makeInput(), 16, START + 4000, W, H, {
      random: () => 0.5,
    })

    // act
    const next = stepPlayground(settled, makeInput(), 16, START + 4016, W, H, {
      random: () => 0.5,
    })

    // assert — same reference, not a deep-equal copy
    expect(next).toBe(settled)
  })

  it('Given a cat is mid-travel, When the world steps, Then a NEW state reference comes back with the cat advanced', () => {
    // arrange — send mushu walking somewhere
    const state = freshState()
    const mushu = state.cats.find((c) => c.id === 'mushu')
    if (!mushu) throw new Error('missing mushu')
    const walking: PlayCat = {
      ...mushu,
      activity: 'walk',
      previousActivity: 'walk',
      activityUntil: START + 60000,
      targetX: mushu.x + 200,
      targetY: mushu.y,
      anchorId: null,
      focus: null,
    }
    const moving = { ...state, cats: state.cats.map((c) => (c.id === 'mushu' ? walking : c)) }

    // act
    const next = stepPlayground(moving, makeInput(), 16, START + 16, W, H, {
      random: () => 0.5,
    })

    // assert
    expect(next).not.toBe(moving)
    const steppedMushu = next.cats.find((c) => c.id === 'mushu')
    expect(steppedMushu && steppedMushu.x).toBeGreaterThan(walking.x)
  })
})

describe('stepPlayground stimulus application (Slice C proposes, Slice B applies)', () => {
  function catsOf(state: PlaygroundState): PlayCat[] {
    return state.cats
  }

  it('Given a chase stimulus, When applied, Then the cat runs grounded on the target lane floor with a toy focus', () => {
    // arrange — laser on so the inferred toy identity is the dot
    const state = freshState()
    const toys: ToyState = {
      ...INITIAL_TOY_STATE,
      laser: { kind: 'laser', on: true, x: 500, y: 340, tx: 500, ty: 340 },
    }

    // act
    const next = applyVerbStimuli(
      catsOf(state),
      [stim('mushu', { type: 'chase', targetX: 500, targetY: 340, lane: 'front', gait: 'run' })],
      toys,
      START,
      ctxFor(state.cats),
    )

    // assert — centered under the toy, y snapped to the lane floor
    const mushu = next.find((c) => c.id === 'mushu')
    expect(mushu?.activity).toBe('run')
    expect(mushu?.focus).toEqual({ type: 'toy', toy: 'laser' })
    expect(mushu?.targetX).toBe(500 - CAT_WIDTH_PX / 2)
    expect(mushu?.targetY).toBe(laneFloorY('front', H))
    expect(mushu?.anchorId).toBeNull()
  })

  it('Given a bat stimulus, When applied, Then the cat enters a bat bout in place', () => {
    // arrange
    const state = freshState()

    // act
    const next = applyVerbStimuli(
      catsOf(state),
      [stim('coco', { type: 'bat' })],
      INITIAL_TOY_STATE,
      START,
      ctxFor(state.cats),
    )

    // assert
    const coco = next.find((c) => c.id === 'coco')
    expect(coco?.activity).toBe('bat')
    expect(coco?.targetX).toBeNull()
  })

  it('Given an eat stimulus for a live treat, When applied, Then the cat walks to the treat with an eat arrival and a treat focus', () => {
    // arrange
    const state = freshState()
    const toys: ToyState = {
      ...INITIAL_TOY_STATE,
      treats: [
        { kind: 'treat', id: 7, x: 600, y: 352, vy: 0, lane: 'front', state: 'landed', claimedBy: null },
      ],
    }

    // act
    const next = applyVerbStimuli(
      catsOf(state),
      [stim('mushu', { type: 'eat', treatId: 7 })],
      toys,
      START,
      ctxFor(state.cats),
    )

    // assert
    const mushu = next.find((c) => c.id === 'mushu')
    expect(mushu?.activity).toBe('walk')
    expect(mushu?.arrival).toMatchObject({ activity: 'eat' })
    expect(mushu?.focus).toEqual({ type: 'treat', treatId: 7 })
  })

  it('Given an eat stimulus for a treat that no longer exists, When applied, Then the cat is untouched (same reference)', () => {
    // arrange
    const state = freshState()

    // act
    const next = applyVerbStimuli(
      catsOf(state),
      [stim('mushu', { type: 'eat', treatId: 99 })],
      INITIAL_TOY_STATE,
      START,
      ctxFor(state.cats),
    )

    // assert
    expect(next).toBe(state.cats)
  })

  it('Given a purr stimulus, When applied, Then the cat purrs with a pet focus and a heart mood', () => {
    // arrange
    const state = freshState()

    // act
    const next = applyVerbStimuli(
      catsOf(state),
      [stim('coco', { type: 'purr' })],
      INITIAL_TOY_STATE,
      START,
      ctxFor(state.cats),
    )

    // assert
    const coco = next.find((c) => c.id === 'coco')
    expect(coco?.activity).toBe('purr')
    expect(coco?.focus).toEqual({ type: 'pet' })
    expect(coco?.petStartedAt).toBe(START)
    expect(coco?.mood).toBe('😻')
  })

  it('Given a grump stimulus (Panther over-petted), When applied, Then she walks off grumpy with no focus', () => {
    // arrange
    const state = freshState()

    // act
    const next = applyVerbStimuli(
      catsOf(state),
      [stim('panther', { type: 'grump' })],
      INITIAL_TOY_STATE,
      START,
      ctxFor(state.cats),
    )

    // assert
    const panther = next.find((c) => c.id === 'panther')
    expect(panther?.activity).toBe('walk')
    expect(panther?.mood).toBe('😾')
    expect(panther?.focus).toBeNull()
    expect(panther?.petStartedAt).toBeNull()
  })

  it('Given a release stimulus for a committed cat, When applied, Then the focus clears and the bout winds down within 400ms', () => {
    // arrange — panther parked on the laser dot
    const state = freshState()
    const parked = state.cats.map((c): PlayCat =>
      c.id === 'panther'
        ? { ...c, focus: { type: 'toy', toy: 'laser' }, activityUntil: START + 60_000 }
        : c,
    )

    // act
    const next = applyVerbStimuli(
      parked,
      [stim('panther', { type: 'release' })],
      INITIAL_TOY_STATE,
      START,
      ctxFor(parked),
    )

    // assert
    const panther = next.find((c) => c.id === 'panther')
    expect(panther?.focus).toBeNull()
    expect(panther?.activityUntil).toBeLessThanOrEqual(START + 400)
  })

  it('Given a cat mid-pet, When a toy stimulus arrives, Then petting preempts and the stimulus is ignored', () => {
    // arrange
    const state = freshState()
    const petted = state.cats.map((c): PlayCat =>
      c.id === 'mushu' ? { ...c, focus: { type: 'pet' } } : c,
    )

    // act
    const next = applyVerbStimuli(
      petted,
      [stim('mushu', { type: 'chase', targetX: 100, targetY: 340, lane: 'front', gait: 'run' })],
      INITIAL_TOY_STATE,
      START,
      ctxFor(petted),
    )

    // assert — untouched
    expect(next).toBe(petted)
  })
})

describe('stepPlayground toy-layer ctx pass-through (the Slice C seam)', () => {
  it('Given the laser is held on, When Mushu reaction time elapses, Then the verb brain sees the cats and Mushu chases (proves ctx.cats flows)', () => {
    // arrange — laser verb active, pointer pressed mid-scene
    const state = freshState()
    const input = makeInput({
      activeVerb: 'laser',
      pointer: { x: 600, y: 340, down: true },
    })

    // act — tick 1 turns the dot on (Mushu's 300ms reaction starts);
    // tick 2 lands after the reaction window.
    const s1 = stepPlayground(state, input, 16, START + 16, W, H, { random: () => 0.5 })
    const s2 = stepPlayground(s1, input, 16, START + 400, W, H, { random: () => 0.5 })

    // assert
    expect(s1.toys.laser.on).toBe(true)
    const mushu = s2.cats.find((c) => c.id === 'mushu')
    expect(mushu?.activity).toBe('run')
    expect(mushu?.focus).toEqual({ type: 'toy', toy: 'laser' })
  })

  it('Given a landed treat under Mushu, When the world steps, Then the brain proposes eat, the engine routes the cat, and the toy layer claims the treat', () => {
    // arrange — treat exactly at Mushu`s feet (toy space: center x /
    // top-origin y; the ctx seam converts the cat view to match).
    const state = freshState()
    const mushu = state.cats.find((c) => c.id === 'mushu')
    if (!mushu) throw new Error('missing mushu')
    const treatX = mushu.x + CAT_WIDTH_PX / 2
    const withTreat: PlaygroundState = {
      ...state,
      toys: {
        ...INITIAL_TOY_STATE,
        treats: [
          {
            kind: 'treat',
            id: 3,
            x: treatX,
            y: H * 0.88,
            vy: 0,
            lane: 'front',
            state: 'landed',
            claimedBy: null,
          },
        ],
      },
    }

    // act
    const next = stepPlayground(withTreat, makeInput(), 16, START + 16, W, H, {
      random: () => 0.5,
    })

    // assert — engine side: Mushu heads into the eat bout; toy side:
    // the treat is claimed by the layer itself (despawn follows the bout)
    const fed = next.cats.find((c) => c.id === 'mushu')
    expect(fed?.focus).toEqual({ type: 'treat', treatId: 3 })
    expect(fed?.arrival).toMatchObject({ activity: 'eat' })
    expect(next.toys.treats[0]).toMatchObject({ state: 'claimed', claimedBy: 'mushu' })
  })

  it('Given Panther parked on a toy focus with her bout expired, When the world steps without a release, Then the engine keeps her parked (sit, focus intact)', () => {
    // arrange — laser on (so the brain does not emit a stale-focus
    // release); Panther committed to the dot with an expired sit.
    const state = freshState()
    const input = makeInput({
      activeVerb: 'laser',
      pointer: { x: 500, y: 340, down: true },
    })
    const s1 = stepPlayground(state, input, 16, START + 16, W, H, { random: () => 0.9 })
    const parked = {
      ...s1,
      cats: s1.cats.map((c): PlayCat =>
        c.id === 'panther'
          ? {
              ...c,
              activity: 'sit',
              previousActivity: 'sit',
              focus: { type: 'toy', toy: 'laser' },
              activityUntil: START + 20,
              targetAnchor: null,
              route: [],
              anchorId: null,
            }
          : c,
      ),
    }

    // act — well past activityUntil but inside Panther's reaction delay
    const next = stepPlayground(parked, input, 16, START + 200, W, H, { random: () => 0.9 })

    // assert — still sitting, still committed; no beat roll stole her
    const panther = next.cats.find((c) => c.id === 'panther')
    expect(panther?.activity).toBe('sit')
    expect(panther?.focus).toEqual({ type: 'toy', toy: 'laser' })
  })
})

describe('stepPlayground vertical mounts play the climb loop (interaction wave 2026-07-11)', () => {
  it('Given a floor cat mounting the tree top, When the travel steps, Then climb_a AND climb_b render during the ascent and the loop ends on arrival', () => {
    // arrange — mushu (rug home) sent up the tree; ramp opened so paws
    // move immediately; ambient spawns pushed out of the window
    const state = freshState()
    const base = state.cats.find((c) => c.id === 'mushu')
    if (!base) throw new Error('missing mushu')
    const mounted = travelToAnchor(base, START, ctxFor(state.cats), 'tree_top', 'perch', 16000)
    const walking: PlayCat = { ...mounted, moveRampAt: START }
    let sim: PlaygroundState = {
      ...state,
      cats: state.cats.map((c) => (c.id === 'mushu' ? walking : c)),
      ambientNextAt: START + 10_000_000,
    }

    // act — step until arrival, collecting rendered frames + the flag
    const framesWhileClimbing = new Set<string>()
    let sawClimbFlag = false
    let mushu: PlayCat = walking
    let now = START
    for (let i = 0; i < 1200 && mushu.anchorId !== 'tree_top'; i++) {
      now += 33
      sim = stepPlayground(sim, makeInput(), 33, now, W, H, { random: () => 0.5 })
      const next = sim.cats.find((c) => c.id === 'mushu')
      if (!next) throw new Error('missing mushu')
      mushu = next
      if (mushu.climbing) {
        sawClimbFlag = true
        const frame = playgroundAnimationPlanFor(mushu, mushu.phaseTime).frame
        if (frame) framesWhileClimbing.add(frame)
      }
    }

    // assert — the cling loop alternated during the vertical lerp…
    expect(sawClimbFlag).toBe(true)
    expect(framesWhileClimbing.has('climb_a')).toBe(true)
    expect(framesWhileClimbing.has('climb_b')).toBe(true)
    // …and the mount completed with the loop shut off
    expect(mushu.anchorId).toBe('tree_top')
    expect(mushu.activity).toBe('perch')
    expect(mushu.climbing).toBe(false)
  })

  it('Given a perched cat dismounting to the floor, When the descent steps, Then the climb loop plays on the way DOWN too', () => {
    // arrange — panther travels from her tree-top home to the rug
    const state = freshState()
    const base = state.cats.find((c) => c.id === 'panther')
    if (!base) throw new Error('missing panther')
    const descent = travelToAnchor(base, START, ctxFor(state.cats), 'rug', 'sit', 5000)
    const walking: PlayCat = { ...descent, moveRampAt: START }
    let sim: PlaygroundState = {
      ...state,
      cats: state.cats.map((c) => (c.id === 'panther' ? walking : c)),
      ambientNextAt: START + 10_000_000,
    }

    // act — a few early steps while the drop is still in progress
    let sawClimb = false
    let now = START
    for (let i = 0; i < 12; i++) {
      now += 33
      sim = stepPlayground(sim, makeInput(), 33, now, W, H, { random: () => 0.5 })
      const panther = sim.cats.find((c) => c.id === 'panther')
      if (panther?.climbing) {
        sawClimb = true
        expect(playgroundAnimationPlanFor(panther, panther.phaseTime).frame).toMatch(/^climb_/)
      }
    }

    // assert
    expect(sawClimb).toBe(true)
  })
})

describe('stepPlayground perch dwell cap (RESIDUAL B: Panther glued to the tree)', () => {
  it('Given a perch stay past its jittered dwell deadline, When the bout expires, Then a FORCED dismount stroll starts and the vacated anchor cools down ~20s', () => {
    // arrange — panther perched with both clocks expired
    const state = freshState()
    const cats = state.cats.map((c): PlayCat =>
      c.id === 'panther'
        ? {
            ...c,
            activity: 'perch',
            previousActivity: 'perch',
            activityStartedAt: START - 20_000,
            activityUntil: START,
            anchorSince: START - 20_000,
            perchDwellDeadline: START - 1,
            focus: { type: 'anchor', anchorId: 'tree_top' },
          }
        : c,
    )

    // act — expiry tick
    const next = stepPlayground({ ...state, cats }, makeInput(), 16, START + 1, W, H, {
      random: () => 0.5,
    })

    // assert — off the perch, strolling to the floor, tree cooling down
    const panther = next.cats.find((c) => c.id === 'panther')
    expect(panther?.activity).toBe('walk')
    expect(panther?.anchorId).toBeNull()
    expect(panther?.targetY).toBe(laneFloorY('front', H))
    expect(panther?.anchorCooldownId).toBe('tree_top')
    expect(panther?.anchorCooldownUntil).toBe(START + 1 + 20_000)
    expect(panther?.climbTravel).toBe(true) // the descent plays climb frames
    expect(panther?.arrival).toMatchObject({ activity: 'sit' })
  })

  it('Given a seeded 2-minute autonomous run, When tree-top occupancy is measured, Then Panther holds it at most 70% of the run (the cap guarantees movement)', () => {
    // arrange — deterministic: beat rolls (Math.random) AND jitter both
    // ride seeded LCGs
    vi.spyOn(Math, 'random').mockImplementation(lcg(1234))
    const random = lcg(99)
    let now = START
    let state = initialPlaygroundState(now, W, H, random)

    // act — 2 simulated minutes at ~30fps
    const totalTicks = 3600
    let treeTicks = 0
    for (let i = 0; i < totalTicks; i++) {
      now += 33.4
      state = stepPlayground(state, makeInput(), 33.4, now, W, H, { random })
      const panther = state.cats.find((c) => c.id === 'panther')
      if (panther?.anchorId === 'tree_top') treeTicks++
    }

    // assert — she starts there (Tree Dweller home) but the dwell cap +
    // no-repeat window force her to live a rounder life
    expect(treeTicks).toBeGreaterThan(0)
    expect(treeTicks / totalTicks).toBeLessThanOrEqual(0.7)
  })
})

describe('stepPlayground new-frame beat wiring (scratch / drink / hammock / window)', () => {
  it('Given the activity maps, When the new beats are resolved, Then scratch and drink loop their bouts and hammock/window hold their dedicated frames', () => {
    // arrange / act / assert — the sequence-table bindings
    expect(PLAY_ONGOING_SEQUENCE.scratch).toBe('scratch_bout')
    expect(PLAY_ONGOING_SEQUENCE.drink).toBe('drink_bout')
    expect(PLAY_HOLD_FRAME.hammock).toBe('hammock_lie')
    expect(PLAY_HOLD_FRAME.watch).toBe('window_watch')
  })

  it('Given cats settled into the new activities, When their animation plans are read, Then the rendered frames come from the new art', () => {
    // arrange — long-settled activities (transitions fully behind)
    const state = freshState()
    const settled = (id: PlayCat['id'], activity: PlayCat['activity']): PlayCat => {
      const cat = state.cats.find((c) => c.id === id)
      if (!cat) throw new Error(`missing ${id}`)
      return {
        ...cat,
        activity,
        previousActivity: activity,
        activityStartedAt: START - 30_000,
        idleSequence: null,
      }
    }

    // act / assert — scratch and drink loop their bouts…
    expect(
      playgroundAnimationPlanFor(settled('mushu', 'scratch'), START).frame,
    ).toMatch(/^scratch_|^seated$/)
    expect(
      playgroundAnimationPlanFor(settled('coco', 'drink'), START).frame,
    ).toMatch(/^drink_|^seated$/)
    // …the holds pin the dedicated single frames
    expect(playgroundAnimationPlanFor(settled('coco', 'hammock'), START).frame).toBe(
      'hammock_lie',
    )
    expect(playgroundAnimationPlanFor(settled('panther', 'watch'), START).frame).toBe(
      'window_watch',
    )
  })
})
