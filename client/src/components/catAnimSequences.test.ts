import { describe, expect, it } from 'vitest'
import {
  CAT_ANIM_MANIFEST,
  CAT_ANIM_SEQUENCES,
  CAT_IDS,
  CYCLE_DURATION_MS,
  STRIDE_PX_PER_CYCLE,
  gaitVelocityPxPerMs,
  type CatAnimId,
} from './catAnimSequences'

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
})
