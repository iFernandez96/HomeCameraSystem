import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CAT_ANIM_MANIFEST,
  CAT_ANIM_SEQUENCES,
  CAT_IDS,
  CYCLE_DURATION_MS,
  STRIDE_PX_PER_CYCLE,
  gaitVelocityPxPerMs,
  type CatAnimId,
  type CatAnimSequenceName,
} from './catAnimSequences'
import { _catSequenceNamesForTransitionForTests } from './CatLayer'

describe('cat animation sequences', () => {
  it('Given the exported manifest, When every sequence step is inspected, Then frames exist and durations are positive', () => {
    // arrange
    const manifestSets = Object.fromEntries(
      CAT_IDS.map((catId) => [catId, new Set(CAT_ANIM_MANIFEST[catId])]),
    ) as Record<CatAnimId, Set<string>>

    // act
    const invalid = Object.entries(CAT_ANIM_SEQUENCES).flatMap(([name, byCat]) =>
      CAT_IDS.flatMap((catId) => byCat[catId].flatMap((step) => {
        const valid = manifestSets[catId].has(step.frame) && step.ms > 0
        return valid ? [] : [`${name}:${catId}:${step.frame}:${step.ms}`]
      })),
    )

    // assert
    expect(invalid).toEqual([])
  })

  it('Given per-cat availability, When blink and crouch variants are read, Then Coco has no blink and only Panther uses crouch_a2', () => {
    // arrange
    const blink = CAT_ANIM_SEQUENCES.blink

    // act
    const crouchFrames = Object.fromEntries(
      CAT_IDS.map((catId) => [
        catId,
        CAT_ANIM_SEQUENCES.crouch_down[catId].map((step) => step.frame),
      ]),
    ) as Record<CatAnimId, string[]>

    // assert
    expect(blink.panther).toEqual([{ frame: 'blink', ms: 140 }])
    expect(blink.mushu).toEqual([{ frame: 'blink', ms: 140 }])
    expect(blink.coco).toEqual([])
    expect(crouchFrames.panther).toContain('crouch_a2')
    expect(crouchFrames.mushu).not.toContain('crouch_a2')
    expect(crouchFrames.coco).not.toContain('crouch_a2')
  })

  it('Given the pounce choreography, When the landing frame is inspected, Then it has a deliberate hit-pause', () => {
    // arrange
    const pantherPounce = CAT_ANIM_SEQUENCES.pounce.panther

    // act
    const landing = pantherPounce.find((step) => step.frame === 'pounce_land')

    // assert
    expect(landing?.ms).toBeGreaterThanOrEqual(180)
  })

  it('Given a rendered cat width, When walk velocity is calculated, Then it derives from stride divided by cycle duration', () => {
    // arrange
    const bodyWidthPx = 48

    // act
    const velocity = gaitVelocityPxPerMs('walk', bodyWidthPx)

    // assert
    expect(velocity).toBe(
      STRIDE_PX_PER_CYCLE.walk(bodyWidthPx) / CYCLE_DURATION_MS.walk,
    )
    expect(STRIDE_PX_PER_CYCLE.walk(bodyWidthPx)).toBeCloseTo(bodyWidthPx * 0.55 * 2)
  })

  it('Given the walk sequence, When its frame order is read, Then walk_01..walk_12 play strictly in ascending order', () => {
    // arrange
    const expected = Array.from({ length: 12 }, (_, i) =>
      `walk_${String(i + 1).padStart(2, '0')}`,
    )

    // act
    const orders = CAT_IDS.map((catId) =>
      CAT_ANIM_SEQUENCES.walk[catId].map((s) => s.frame),
    )

    // assert — a reordered or reversed cycle reads as moonwalking.
    for (const order of orders) expect(order).toEqual(expected)
  })

  it('Given every manifest frame, When the exported asset dir is scanned, Then each frame PNG exists on disk', () => {
    // arrange
    const assetRoot = join(__dirname, '..', '..', 'public', 'cats', 'anim')

    // act
    const missing = CAT_IDS.flatMap((catId) =>
      CAT_ANIM_MANIFEST[catId]
        .filter((frame) => !existsSync(join(assetRoot, catId, `${frame}.png`)))
        .map((frame) => `${catId}/${frame}.png`),
    )

    // assert
    expect(missing).toEqual([])
  })

  it('Given every activity pair, When its transition chain is composed, Then consecutive sequences join on pose-compatible frames', () => {
    // arrange — activities mirrored from POSE_GROUP_BY_ACTIVITY in
    // CatLayer. Join legality: the first frame of sequence N+1 must be
    // reachable from the last frame of sequence N (same frame, or one of
    // the designed pose pivots).
    const activities = [
      'walk', 'chase', 'flee', 'sit', 'judge', 'loaf', 'snuggle', 'groom',
      'in_box', 'sleep', 'stretch', 'play', 'pounce', 'on_post', 'hiss', 'scared',
    ] as const
    const legalJoins: Record<string, readonly string[]> = {
      stand: ['stand', 'sit_a', 'hiss_windup'],
      seated: ['seated', 'sleep_a', 'crouch_a', 'sit_b', 'groom_a'],
      crouch: ['crouch', 'pounce_launch', 'jump_post', 'crouch_b'],
      sleep: ['sleep', 'sleep_b'],
      side_stand: ['side_stand', 'turn'],
    }

    // act
    const badJoins: string[] = []
    for (const from of activities) {
      for (const to of activities) {
        const names = _catSequenceNamesForTransitionForTests(from, to)
        for (const catId of CAT_IDS) {
          const parts = names
            .map((n: CatAnimSequenceName) => CAT_ANIM_SEQUENCES[n][catId])
            .filter((steps) => steps.length > 0)
          for (let i = 0; i + 1 < parts.length; i++) {
            const tail = parts[i][parts[i].length - 1].frame
            const head = parts[i + 1][0].frame
            const legal = legalJoins[tail]?.includes(head) ?? tail === head
            if (!legal) badJoins.push(`${from}->${to} (${catId}): ${tail} !-> ${head}`)
          }
        }
      }
    }

    // assert
    expect(badJoins).toEqual([])
  })

  it('Given transitions into resting activities, When each chain terminates, Then the final frame matches the destination pose', () => {
    // arrange — where a destination has a hold frame or an ongoing gait,
    // the chain must hand off cleanly: terminal frame equals the hold, or
    // is a legal launch pose for the ongoing sequence's first frame.
    const cases: readonly { from: string; to: string; acceptTerminal: readonly string[] }[] = [
      { from: 'walk', to: 'sit', acceptTerminal: ['seated'] },
      { from: 'walk', to: 'sleep', acceptTerminal: ['sleep'] },
      { from: 'walk', to: 'stretch', acceptTerminal: ['crouch'] },
      { from: 'sleep', to: 'sit', acceptTerminal: ['seated'] },
      { from: 'sleep', to: 'walk', acceptTerminal: ['side_stand'] },
      { from: 'sit', to: 'walk', acceptTerminal: ['side_stand'] },
      { from: 'sit', to: 'sleep', acceptTerminal: ['sleep'] },
      { from: 'sit', to: 'pounce', acceptTerminal: ['crouch'] },
      { from: 'stretch', to: 'sit', acceptTerminal: ['seated'] },
      { from: 'stretch', to: 'walk', acceptTerminal: ['side_stand'] },
      { from: 'hiss', to: 'sit', acceptTerminal: ['seated'] },
      { from: 'sit', to: 'on_post', acceptTerminal: ['jump_post'] },
    ]

    // act
    const bad: string[] = []
    for (const { from, to, acceptTerminal } of cases) {
      const names = _catSequenceNamesForTransitionForTests(
        from as Parameters<typeof _catSequenceNamesForTransitionForTests>[0],
        to as Parameters<typeof _catSequenceNamesForTransitionForTests>[1],
      )
      for (const catId of CAT_IDS) {
        const steps = names.flatMap((n: CatAnimSequenceName) => CAT_ANIM_SEQUENCES[n][catId])
        const terminal = steps.length ? steps[steps.length - 1].frame : '(empty)'
        if (!acceptTerminal.includes(terminal)) {
          bad.push(`${from}->${to} (${catId}) ends at ${terminal}, wanted ${acceptTerminal.join('|')}`)
        }
      }
    }

    // assert
    expect(bad).toEqual([])
  })
})
