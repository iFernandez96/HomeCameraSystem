import { describe, expect, it } from 'vitest'
import { CAT_ANIM_MANIFEST } from '../components/catAnimSequences'
import {
  PLAYGROUND_CAT_FRAME_MANIFEST,
  PLAYGROUND_CAT_IDS,
  PLAYGROUND_PRELOAD_WAVE_1,
  PLAYGROUND_PRELOAD_WAVE_2,
  playgroundCatFrameUrl,
} from './playgroundAssets'
import {
  PLAYGROUND_PER_CAT_SEQUENCES,
  PLAYGROUND_SEQUENCES,
} from './playgroundSequences'

// Slice A pins validate against the MANIFEST CONSTANTS, not the disk —
// the playground PNGs are still generating; the on-disk pin lands with
// the export step (see the TODO in playgroundAssets.ts).

describe('playgroundSequences', () => {
  it('Given every playground sequence, When its frames are checked against the manifests, Then each frame is in each rendering cat\'s playground or anim manifest', () => {
    // arrange — shared sequences must clear ALL cats' manifests; the
    // per-cat variants (drink_bout / climb) only their own cat's.
    const okFor = (catId: (typeof PLAYGROUND_CAT_IDS)[number], frame: string) =>
      (PLAYGROUND_CAT_FRAME_MANIFEST[catId] as readonly string[]).includes(frame) ||
      (CAT_ANIM_MANIFEST[catId] as readonly string[]).includes(frame)

    // act / assert — a frame missing from a cat's manifests would 404
    // for that cat once the brain plays the bout.
    for (const [name, steps] of Object.entries(PLAYGROUND_SEQUENCES)) {
      for (const step of steps) {
        for (const catId of PLAYGROUND_CAT_IDS) {
          expect(
            okFor(catId, step.frame),
            `sequence "${name}" uses frame "${step.frame}" missing from ${catId}'s manifests`,
          ).toBe(true)
        }
      }
    }
    for (const [name, byCat] of Object.entries(PLAYGROUND_PER_CAT_SEQUENCES)) {
      for (const catId of PLAYGROUND_CAT_IDS) {
        for (const step of byCat[catId]) {
          expect(
            okFor(catId, step.frame),
            `per-cat sequence "${name}" (${catId}) uses frame "${step.frame}" missing from ${catId}'s manifests`,
          ).toBe(true)
        }
      }
    }
  })

  it('Given every sequence step, When durations are read, Then each ms is a positive integer (the 1ms hold-pose convention is the floor)', () => {
    // arrange / act / assert
    const allSequences = [
      ...Object.values(PLAYGROUND_SEQUENCES),
      ...Object.values(PLAYGROUND_PER_CAT_SEQUENCES).flatMap((byCat) =>
        PLAYGROUND_CAT_IDS.map((catId) => byCat[catId]),
      ),
    ]
    for (const steps of allSequences) {
      expect(steps.length).toBeGreaterThan(0)
      for (const step of steps) {
        expect(Number.isInteger(step.ms)).toBe(true)
        expect(step.ms).toBeGreaterThanOrEqual(1)
      }
    }
  })

  it('Given the two preload waves, When compared, Then wave 1 is furniture-only, wave 2 covers toys+ambient+per-cat frames, and the sets do not overlap', () => {
    // arrange / act
    const wave1 = new Set(PLAYGROUND_PRELOAD_WAVE_1)
    const wave2 = new Set(PLAYGROUND_PRELOAD_WAVE_2)

    // assert — 12 furniture pieces; 6 toys + 4 ambient + 3 cats × 45
    // frames each (44 shared: the 32 through wave-2c plus the 12 wave-4
    // habitat frames — mount/dismount/hamset/chatter triples — plus
    // drink_ab for panther/mushu or climb_ab for coco). Count updated
    // deliberately 2026-07-12 (frames-30 wave 4), and again 2026-07-13
    // for the wave-5 window/climb/bout-mid pack (45 -> 85 frames/cat).
    expect(wave1.size).toBe(12)
    expect(wave2.size).toBe(6 + 4 + 3 * 85)
    for (const url of wave1) {
      expect(url).toMatch(/^\/cats\/playground\/furniture\/[a-z_]+\.png$/)
      expect(wave2.has(url)).toBe(false)
    }
    // Per-cat frame URLs resolve under the cat's own directory.
    expect(playgroundCatFrameUrl('mushu', 'bat_a')).toBe(
      '/cats/playground/mushu/bat_a.png',
    )
  })

  it('Given the interaction-wave bouts, When their rhythms are read, Then scratch tweens for all cats while drink tweens only where drink_ab exists, totals preserved', () => {
    // arrange / act
    const scratch = PLAYGROUND_SEQUENCES.scratch_bout
    const drink = PLAYGROUND_PER_CAT_SEQUENCES.drink_bout

    // assert — tween wave 2: each stroke split in half around its
    // scratch_ab midpoint; the final full stroke keeps its original ms
    // so the pre-tween 1561ms bout total is exact.
    // Wave-5: the strokes split again through the level-2 mids
    // (scratch_n1 = a<->ab, scratch_n2 = ab<->b), totals still exact.
    expect(scratch.slice(0, 6)).toEqual([
      { frame: 'scratch_a', ms: 70 },
      { frame: 'scratch_n1', ms: 70 },
      { frame: 'scratch_ab', ms: 70 },
      { frame: 'scratch_n2', ms: 70 },
      { frame: 'scratch_b', ms: 60 },
      { frame: 'scratch_n2', ms: 60 },
    ])
    expect(scratch.filter((s) => s.frame === 'scratch_a')).toHaveLength(3)
    expect(scratch.filter((s) => s.frame === 'scratch_b')).toHaveLength(3)
    expect(scratch.reduce((sum, s) => sum + s.ms, 0)).toBe(1561)
    expect(scratch[scratch.length - 1]).toEqual({ frame: 'seated', ms: 1 })
    // drink: panther/mushu lap ×4 with drink_ab interleaved; coco (her
    // drink_ab re-roll was dropped) keeps the plain 260/300 lapping.
    // Every variant totals 2241ms so bout math never sees the split.
    for (const catId of ['panther', 'mushu'] as const) {
      const steps = drink[catId]
      expect(steps.filter((s) => s.frame === 'drink_ab')).toHaveLength(7)
      expect(steps[0]).toEqual({ frame: 'drink_a', ms: 130 })
      expect(steps[1]).toEqual({ frame: 'drink_ab', ms: 130 })
      expect(steps[2]).toEqual({ frame: 'drink_b', ms: 150 })
    }
    expect(drink.coco.filter((s) => s.frame === 'drink_ab')).toHaveLength(0)
    // Wave-5: coco finally laps through a midpoint — drink_n1 (the
    // direct a<->b mid) fills the role her dropped drink_ab left.
    expect(drink.coco[0]).toEqual({ frame: 'drink_a', ms: 130 })
    expect(drink.coco[1]).toEqual({ frame: 'drink_n1', ms: 130 })
    expect(drink.coco[2]).toEqual({ frame: 'drink_b', ms: 300 })
    for (const catId of PLAYGROUND_CAT_IDS) {
      const steps = drink[catId]
      expect(steps.filter((s) => s.frame === 'drink_a')).toHaveLength(4)
      expect(steps.filter((s) => s.frame === 'drink_b')).toHaveLength(4)
      expect(steps.reduce((sum, s) => sum + s.ms, 0)).toBe(2241)
      expect(steps[steps.length - 1]).toEqual({ frame: 'seated', ms: 1 })
    }
  })

  it('Given the per-cat climb loop and the two holds, When read, Then coco ping-pongs via climb_ab while panther/mushu keep the plain a/b loop, both 400ms', () => {
    // arrange / act / assert — climb has NO trailing hold: it loops for
    // exactly as long as the vertical travel runs. Coco's climb_ab is
    // reused on the return leg (classic 3-frame ping-pong); the other
    // two cats' climb_ab re-rolls were dropped, so they stay 2-frame.
    expect(PLAYGROUND_PER_CAT_SEQUENCES.climb.coco).toEqual([
      { frame: 'climb_a', ms: 100 },
      { frame: 'climb_ab', ms: 100 },
      { frame: 'climb_b', ms: 100 },
      { frame: 'climb_ab', ms: 100 },
    ])
    for (const catId of ['panther', 'mushu'] as const) {
      // Wave-5: climb_n1 (the direct a<->b mid) gives panther/mushu the
      // same 4-step ping-pong coco's climb_ab always had.
      expect(PLAYGROUND_PER_CAT_SEQUENCES.climb[catId]).toEqual([
        { frame: 'climb_a', ms: 100 },
        { frame: 'climb_n1', ms: 100 },
        { frame: 'climb_b', ms: 100 },
        { frame: 'climb_n1', ms: 100 },
      ])
    }
    expect(PLAYGROUND_SEQUENCES.hammock_hold).toEqual([{ frame: 'hammock_lie', ms: 1 }])
    expect(PLAYGROUND_SEQUENCES.window_hold).toEqual([{ frame: 'window_watch', ms: 1 }])
  })

  it('Given the tween-wave-2 bout re-timings, When bat and eat totals are measured, Then each equals its pre-tween duration with *_ab midpoints interleaved', () => {
    // arrange / act
    const bat = PLAYGROUND_SEQUENCES.bat_bout
    const eat = PLAYGROUND_SEQUENCES.eat_bout

    // assert — donor halves preserve the totals exactly (bat 401,
    // eat 1951); midpoints appear between every a↔b flank.
    expect(bat.reduce((sum, s) => sum + s.ms, 0)).toBe(401)
    expect(bat.filter((s) => s.frame === 'bat_ab')).toHaveLength(2)
    expect(eat.reduce((sum, s) => sum + s.ms, 0)).toBe(1951)
    expect(eat.filter((s) => s.frame === 'eat_ab')).toHaveLength(5)
    expect(bat[bat.length - 1]).toEqual({ frame: 'seated', ms: 1 })
    expect(eat[eat.length - 1]).toEqual({ frame: 'seated', ms: 1 })
  })
})
