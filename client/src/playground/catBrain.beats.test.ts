import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  PLAY_BEATS,
  rollNextBeat,
  rollPairInteraction,
  travelToAnchor,
  type Beat,
  type BeatContext,
} from './catBrain.beats'
import { buildHomeCat, type PlayCat } from './playgroundState'

// The beat pool rolls through catEngineCore's rollWeighted, which
// consumes exactly ONE Math.random() per roll — tests pin outcomes by
// stubbing Math.random. Duration jitter / target scatter go through the
// INJECTED ctx.random instead, held constant here.

const W = 800
const H = 400
const NOW = 50_000

function ctxFor(cats: readonly PlayCat[], over: Partial<BeatContext> = {}): BeatContext {
  return { cats, ambient: [], sceneW: W, sceneH: H, compact: false, now: NOW, random: () => 0.5, ...over }
}

function homeCat(id: 'panther' | 'mushu' | 'coco'): PlayCat {
  return buildHomeCat(id, NOW - 10_000, W, H, () => 0.5)
}

function beatById(id: string): Beat {
  const beat = PLAY_BEATS.find((b) => b.id === id)
  if (!beat) throw new Error(`missing beat ${id}`)
  return beat
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('catBrain.beats personality weights (Shimeji rule: personality lives ONLY in the weights)', () => {
  it('Given the dweller taxonomy, When beat weights are read, Then each cat dominates its own zone', () => {
    // arrange + act + assert — Panther the Tree Dweller
    expect(beatById('tree_perch').weights.panther).toBeGreaterThan(
      beatById('tree_perch').weights.mushu,
    )
    expect(beatById('tree_perch').weights.panther).toBeGreaterThan(
      beatById('tree_perch').weights.coco,
    )
    // Coco the Bush Dweller: hammock naps dominate
    expect(beatById('hammock_nap').weights.coco).toBeGreaterThan(
      beatById('hammock_nap').weights.panther,
    )
    expect(beatById('hammock_nap').weights.coco).toBeGreaterThan(
      beatById('hammock_nap').weights.mushu,
    )
    // Mushu the Beach Dweller: open floor, first responder to critters
    expect(beatById('ambient_pursuit').weights.mushu).toBeGreaterThan(
      beatById('ambient_pursuit').weights.panther,
    )
    expect(beatById('tunnel_dive').weights.mushu).toBeGreaterThan(
      beatById('tunnel_dive').weights.coco,
    )
  })

  it('Given a seeded low roll, When Coco rolls her next beat, Then the first pool beat (hammock nap) wins and she travels there', () => {
    // arrange — roll ~0 lands on the pool head
    vi.spyOn(Math, 'random').mockReturnValue(0.001)
    const coco = homeCat('coco')

    // act
    const next = rollNextBeat(coco, NOW, ctxFor([coco]))

    // assert — en route to the hammock, arrival starts the nap beat
    expect(next.lastBeatId).toBe('hammock_nap')
    expect(next.targetAnchor).toBe('hammock')
    expect(next.arrival).toMatchObject({ activity: 'hammock' })
    expect(next.activity).toBe('walk')
    expect(next.mood).toBe('😴')
  })

  it('Given the duration jitter, When a beat applies, Then the bout length is nominal x (0.78 + random * 0.54)', () => {
    // arrange — floor_nap is nominal 22000ms; ctx.random 0.5 => x1.05.
    // Force the weighted roll past hammock (8) into floor_nap's 8–14
    // band (coco's pool totals 28 since floor_poop; 9/27 × 28 ≈ 9.3).
    vi.spyOn(Math, 'random').mockReturnValue(9 / 27)
    const coco = homeCat('coco')

    // act
    const next = rollNextBeat(coco, NOW, ctxFor([coco]))

    // assert
    expect(next.lastBeatId).toBe('floor_nap')
    expect(next.activity).toBe('sleep')
    expect(next.activityUntil).toBe(NOW + 22000 * 1.05)
  })

  it('Given the last beat repeats on the roll, When rolled again, Then the anti-repeat wrapper re-rolls once', () => {
    // arrange — first roll collides with lastBeatId, second lands elsewhere
    vi.spyOn(Math, 'random')
      .mockReturnValueOnce(0.001) // hammock_nap — collision
      .mockReturnValueOnce(9 / 27) // floor_nap — accepted
    const coco = { ...homeCat('coco'), lastBeatId: 'hammock_nap' }

    // act
    const next = rollNextBeat(coco, NOW, ctxFor([coco]))

    // assert
    expect(next.lastBeatId).toBe('floor_nap')
  })

  it('Given another cat already holds the hammock, When Coco rolls low, Then the occupied beat leaves the pool entirely', () => {
    // arrange
    vi.spyOn(Math, 'random').mockReturnValue(0.001)
    const coco = homeCat('coco')
    const mushu = { ...homeCat('mushu'), anchorId: 'hammock' }

    // act
    const next = rollNextBeat(coco, NOW, ctxFor([coco, mushu]))

    // assert — the roll head moved past hammock_nap
    expect(next.lastBeatId).not.toBe('hammock_nap')
    expect(next.targetAnchor === 'hammock').toBe(false)
  })
})

describe('catBrain.beats pooping (2026-07-11: ground object, never a mood bubble)', () => {
  it('Given the litter visit, When it applies, Then the cat travels to the box for a squat with NO 💩 bubble', () => {
    // arrange
    const mushu = homeCat('mushu')

    // act
    const next = beatById('litter_visit').apply(mushu, NOW, ctxFor([mushu]))

    // assert — en route to the box, arrival squats; mood untouched
    expect(next.targetAnchor).toBe('litter_box')
    expect(next.arrival).toMatchObject({ activity: 'pooped' })
    expect(next.mood).toBeNull()
  })

  it('Given the rare floor accident, When it applies, Then the cat squats IN PLACE (stepPlayground drops the ground poop when the bout completes)', () => {
    // arrange — every cat can have the accident, rarely
    const beat = beatById('floor_poop')
    expect(beat.weights).toEqual({ panther: 1, mushu: 1, coco: 1 })
    const mushu = homeCat('mushu')

    // act
    const next = beat.apply(mushu, NOW, ctxFor([mushu]))

    // assert — no travel, no mood; the squat plays where the cat stands
    expect(next.activity).toBe('pooped')
    expect(next.targetAnchor).toBeNull()
    expect(next.mood).toBeNull()
  })

  it('Given a cat perched on the tree top, When the floor accident is gated, Then it is unavailable (no poop floating on a platform)', () => {
    // arrange — panther's home anchor IS tree_top
    const panther = homeCat('panther')
    const mushu = homeCat('mushu') // floor home (rug)

    // act + assert
    const available = beatById('floor_poop').available
    expect(available?.(panther, ctxFor([panther]))).toBe(false)
    expect(available?.(mushu, ctxFor([mushu]))).toBe(true)
  })
})

describe('catBrain.beats travel routing', () => {
  it('Given Panther already on the tree top, When she travels to a shelf, Then the already-climbed waypoints are skipped', () => {
    // arrange
    const panther = homeCat('panther') // home anchor IS tree_top

    // act
    const next = travelToAnchor(panther, NOW, ctxFor([panther]), 'shelf_1', 'perch', 14000)

    // assert — full route is tree_mid -> tree_top -> shelf_1; she hops direct
    expect(next.route).toEqual(['shelf_1'])
    expect(next.targetAnchor).toBe('shelf_1')
    expect(next.anchorId).toBeNull()
    expect(next.arrival).toMatchObject({ activity: 'perch' })
  })

  it('Given a cat already AT the destination, When it travels there, Then the arrival beat starts in place', () => {
    // arrange
    const panther = homeCat('panther')

    // act
    const next = travelToAnchor(panther, NOW, ctxFor([panther]), 'tree_top', 'perch', 16000)

    // assert
    expect(next.activity).toBe('perch')
    expect(next.anchorId).toBe('tree_top')
    expect(next.targetAnchor).toBeNull()
  })
})

describe('catBrain.beats bowl beats (interaction wave 2026-07-11)', () => {
  it('Given the food bowl is free, When bowl_snack applies, Then the cat arrives into an eat bout', () => {
    // arrange
    const mushu = homeCat('mushu')

    // act
    const next = beatById('bowl_snack').apply(mushu, NOW, ctxFor([mushu]))

    // assert
    expect(next.targetAnchor).toBe('food_bowl')
    expect(next.arrival).toMatchObject({ activity: 'eat' })
  })

  it('Given the food bowl is taken, When bowl_snack applies, Then the cat heads to the WATER bowl and arrives into a drink (lapping) bout', () => {
    // arrange — panther camps the food bowl
    const mushu = homeCat('mushu')
    const panther = { ...homeCat('panther'), anchorId: 'food_bowl' }

    // act
    const next = beatById('bowl_snack').apply(mushu, NOW, ctxFor([mushu, panther]))

    // assert — water reads as lapping, not chewing
    expect(next.targetAnchor).toBe('water_bowl')
    expect(next.arrival).toMatchObject({ activity: 'drink' })
  })
})

describe('catBrain.beats climb travel legs (interaction wave 2026-07-11)', () => {
  it('Given a floor cat mounting the tree top, When travel starts, Then the leg is flagged climbTravel (the render layer plays climb_a/b while y lerps)', () => {
    // arrange — mushu's home is the rug (floor)
    const mushu = homeCat('mushu')

    // act
    const next = travelToAnchor(mushu, NOW, ctxFor([mushu]), 'tree_top', 'perch', 16000)

    // assert
    expect(next.climbTravel).toBe(true)
    expect(next.activity).toBe('walk')
  })

  it('Given a perched cat dismounting to a floor anchor, When travel starts, Then the descent is ALSO a climb leg (dismounts reverse with climb frames)', () => {
    // arrange — panther's home is the tree top
    const panther = homeCat('panther')

    // act
    const next = travelToAnchor(panther, NOW, ctxFor([panther]), 'rug', 'sit', 5000)

    // assert
    expect(next.climbTravel).toBe(true)
  })

  it('Given floor-to-floor travel, When it starts, Then no climb leg is flagged (walk gait all the way)', () => {
    // arrange
    const mushu = homeCat('mushu')

    // act
    const next = travelToAnchor(mushu, NOW, ctxFor([mushu]), 'litter_box', 'pooped', 4500)

    // assert
    expect(next.climbTravel).toBe(false)
  })
})

describe('catBrain.beats perch no-repeat window (RESIDUAL B: Panther glued to the tree)', () => {
  it('Given a fresh dismount cooldown on the tree top, When tree_perch availability is checked, Then the beat is off the menu until the window passes', () => {
    // arrange — panther just vacated the tree top
    const panther = {
      ...homeCat('panther'),
      anchorId: null,
      anchorCooldownId: 'tree_top',
      anchorCooldownUntil: NOW + 20000,
    }
    const available = beatById('tree_perch').available

    // act + assert — blocked inside the window, open after it
    expect(available?.(panther, ctxFor([panther]))).toBe(false)
    expect(available?.(panther, ctxFor([panther], { now: NOW + 20001 }))).toBe(true)
  })

  it('Given a beat roll moves Panther OFF the tree top, When the new beat applies, Then the vacated perch gets a ~20s no-repeat window', () => {
    // arrange — roll ~0 lands on hammock_nap (travel away from the tree)
    vi.spyOn(Math, 'random').mockReturnValue(0.001)
    const panther = homeCat('panther') // anchored at tree_top

    // act
    const next = rollNextBeat(panther, NOW, ctxFor([panther]))

    // assert — she left, and the tree is cooling down
    expect(next.lastBeatId).toBe('hammock_nap')
    expect(next.anchorId).toBeNull()
    expect(next.anchorCooldownId).toBe('tree_top')
    expect(next.anchorCooldownUntil).toBe(NOW + 20000)
  })

  it('Given an in-place beat on the same anchor, When it applies, Then the continuous-stay clock and cooldown are untouched', () => {
    // arrange — panther perched, sit_spot applies in place
    const panther = { ...homeCat('panther'), anchorSince: NOW - 9000 }

    // act
    const next = beatById('sit_spot').apply(panther, NOW, ctxFor([panther]))

    // assert — still on her anchor, stay clock intact
    expect(next.anchorId).toBe('tree_top')
    expect(next.anchorSince).toBe(NOW - 9000)
    expect(next.anchorCooldownId).toBeNull()
  })
})

describe('catBrain.beats pair interactions (ported pools)', () => {
  it('Given Mushu meets Panther, When the seeded roll lands on the first outcome, Then Panther hisses and Mushu backs away scared', () => {
    // arrange
    vi.spyOn(Math, 'random').mockReturnValue(0.001)
    const mushu = { ...homeCat('mushu'), x: 300 }
    const panther = { ...homeCat('panther'), x: 330 }

    // act
    const result = rollPairInteraction(mushu, panther, NOW, W, () => 0.5)

    // assert — result order matches the argument order
    expect(result).not.toBeNull()
    const [first, second] = result ?? []
    expect(first?.id).toBe('mushu')
    expect(first?.activity).toBe('scared')
    expect(second?.activity).toBe('hiss')
    expect(second?.mood).toBe('😾')
    expect(first?.lastInteractedWith).toBe('panther')
    expect(second?.lastInteractedWith).toBe('mushu')
  })
})
