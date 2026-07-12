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

  it('Given per-cat availability, When blink and crouch variants are read, Then Coco has no blink and every cat shares the 6-frame tweened crouch', () => {
    // arrange — tween wave 2 (2026-07-11) shipped crouch_a2/b2 for
    // Mushu and Coco too, so the old Panther-only asymmetry is gone.
    const blink = CAT_ANIM_SEQUENCES.blink

    // act
    const crouchFrames = Object.fromEntries(
      CAT_IDS.map((catId) => [
        catId,
        CAT_ANIM_SEQUENCES.crouch_down[catId].map((step) => step.frame),
      ]),
    ) as Record<CatAnimId, string[]>

    // assert — blink stays Panther/Mushu-only; crouch is uniform.
    expect(blink.panther).toEqual([{ frame: 'blink', ms: 140 }])
    expect(blink.mushu).toEqual([{ frame: 'blink', ms: 140 }])
    expect(blink.coco).toEqual([])
    const expectedCrouch = ['crouch_a', 'crouch_a2', 'crouch_mid', 'crouch_b', 'crouch_b2', 'crouch']
    for (const catId of CAT_IDS) {
      expect(crouchFrames[catId]).toEqual(expectedCrouch)
      // crouch_up reverses the same chain and settles seated.
      expect(CAT_ANIM_SEQUENCES.crouch_up[catId].map((s) => s.frame)).toEqual(
        [...expectedCrouch].reverse().concat('seated'),
      )
    }
  })

  it('Given the tween-wave-2 re-timing, When each retimed sequence total is measured, Then it stays within 15% of its pre-tween duration', () => {
    // arrange — pre-tween totals (the calibrated beat/bout budget).
    const before: Partial<Record<CatAnimSequenceName, number>> = {
      run: 150,
      walk_to_front: 840,
      front_to_walk: 840,
      stand_to_seated: 282,
      seated_to_stand: 282,
      pounce: 432,
      poop_squat: 2200,
      groom_bout: 1801,
      yawn: 901,
    }

    // act / assert
    for (const [name, total] of Object.entries(before)) {
      for (const catId of CAT_IDS) {
        const steps = CAT_ANIM_SEQUENCES[name as CatAnimSequenceName][catId]
        const after = steps.reduce((sum, step) => sum + step.ms, 0)
        expect(after, `${name}:${catId}`).toBeGreaterThanOrEqual(total * 0.85)
        expect(after, `${name}:${catId}`).toBeLessThanOrEqual(total * 1.15)
      }
    }
  })

  it('Given the 4-frame gallop, When the run cycle is read, Then a/ab/b/ba play in order and the cycle total is still 150ms', () => {
    // arrange / act
    const run = CAT_ANIM_SEQUENCES.run.panther

    // assert — doubling gallop frames halved per-step ms; stride
    // calibration (STRIDE_PX_PER_CYCLE) is untouched by design.
    expect(run.map((s) => s.frame)).toEqual(['run_a', 'run_ab', 'run_b', 'run_ba'])
    expect(run.reduce((sum, s) => sum + s.ms, 0)).toBe(150)
    expect(CYCLE_DURATION_MS.run).toBe(150)
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
      'pooped',
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
            const tail = parts[i]?.[parts[i]!.length - 1]?.frame
            const head = parts[i + 1]?.[0]?.frame
            if (!tail || !head) continue
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
      // 'pooped' is pose group 'crouched': entry chains must land on the
      // crouch hold (where the looping poop_squat bout takes over) and
      // exit chains must resolve back to each destination's pose.
      { from: 'walk', to: 'pooped', acceptTerminal: ['crouch'] },
      { from: 'sit', to: 'pooped', acceptTerminal: ['crouch'] },
      { from: 'sleep', to: 'pooped', acceptTerminal: ['crouch'] },
      { from: 'pooped', to: 'walk', acceptTerminal: ['side_stand'] },
      { from: 'pooped', to: 'sit', acceptTerminal: ['seated'] },
      { from: 'pooped', to: 'sleep', acceptTerminal: ['sleep'] },
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

  it('Given the poop_squat bout, When its steps are read, Then squat_ab rides every flank and the quickening cadence survives the split', () => {
    // arrange — tween wave 2: each pre-tween strain (700/500/600/400)
    // split in half with its squat_ab midpoint; the trailing squat_ab
    // smooths the loop wrap back to poop_squat_a. Total stays 2200ms.
    const expected = [
      { frame: 'poop_squat_a', ms: 350 },
      { frame: 'squat_ab', ms: 350 },
      { frame: 'poop_squat_b', ms: 250 },
      { frame: 'squat_ab', ms: 250 },
      { frame: 'poop_squat_a', ms: 300 },
      { frame: 'squat_ab', ms: 300 },
      { frame: 'poop_squat_b', ms: 200 },
      { frame: 'squat_ab', ms: 200 },
    ]

    // act
    const perCat = CAT_IDS.map((catId) => CAT_ANIM_SEQUENCES.poop_squat[catId])

    // assert — every cat shares the same squat choreography.
    for (const steps of perCat) expect(steps).toEqual(expected)
  })

  it('Given the poop_squat frames, When the exported asset dir is scanned, Then both frames exist on disk for all three cats', () => {
    // arrange
    const assetRoot = join(__dirname, '..', '..', 'public', 'cats', 'anim')
    const frames = ['poop_squat_a', 'poop_squat_b']

    // act
    const missing = CAT_IDS.flatMap((catId) =>
      frames
        .filter((frame) => !existsSync(join(assetRoot, catId, `${frame}.png`)))
        .map((frame) => `${catId}/${frame}.png`),
    )

    // assert
    expect(missing).toEqual([])
  })
})
