import { describe, expect, it } from 'vitest'
import { CAT_ANIM_SEQUENCES, CAT_IDS, sequenceDurationMs } from './catAnimSequences'
import { turnPivotView, type TurnPivot } from './catEngineCore'

const pivot: TurnPivot = { startedAt: 1000, from: 'L', to: 'R' }

describe('turn-around pivot', () => {
  it('Given the turn_around sequence, When its shape is inspected, Then it is a symmetric side→front→side ladder with the frontal stand frame centered', () => {
    // arrange / act
    for (const catId of CAT_IDS) {
      const steps = CAT_ANIM_SEQUENCES.turn_around[catId]
      const fast = CAT_ANIM_SEQUENCES.turn_around_fast[catId]

      // assert — palindrome frame order, stand dead-center; the facing
      // flip at duration/2 must land INSIDE the stand step or the
      // mirror seam becomes visible on an asymmetric frame.
      for (const seq of [steps, fast]) {
        expect(seq.map((s) => s.frame)).toEqual(['turn', 'turn_2', 'stand', 'turn_2', 'turn'])
        const half = sequenceDurationMs(seq) / 2
        const standStart = seq[0].ms + seq[1].ms
        const standEnd = standStart + seq[2].ms
        expect(half).toBeGreaterThanOrEqual(standStart)
        expect(half).toBeLessThan(standEnd)
      }
    }
  })

  it('Given a pivot in flight, When the view is sampled across its timeline, Then facing switches exactly at the frontal midpoint and done fires at the end', () => {
    // arrange
    const steps = CAT_ANIM_SEQUENCES.turn_around.panther
    const duration = sequenceDurationMs(steps) // 330

    // act / assert — old facing through the first half
    const early = turnPivotView(steps, pivot, 1000 + 60)
    expect(early).toEqual({ frame: 'turn', facing: 'L', done: false })

    // mid-pivot: frontal frame, ALREADY flipped to the new facing
    const mid = turnPivotView(steps, pivot, 1000 + duration / 2)
    expect(mid).toEqual({ frame: 'stand', facing: 'R', done: false })

    // exit ramp: new facing on the way back out to profile
    const late = turnPivotView(steps, pivot, 1000 + duration - 30)
    expect(late).toEqual({ frame: 'turn', facing: 'R', done: false })

    // completion
    expect(turnPivotView(steps, pivot, 1000 + duration).done).toBe(true)
  })

  it('Given a clock skew before the pivot start, When the view is sampled, Then elapsed clamps to zero instead of going negative', () => {
    // arrange
    const steps = CAT_ANIM_SEQUENCES.turn_around.mushu

    // act
    const view = turnPivotView(steps, pivot, 900)

    // assert
    expect(view).toEqual({ frame: 'turn', facing: 'L', done: false })
  })

  it('Given both pivot speeds, When their totals are measured, Then the walk pivot is ~330ms and the sprint pivot ~205ms — both faster than reading as a hesitation', () => {
    // arrange / act / assert
    expect(sequenceDurationMs(CAT_ANIM_SEQUENCES.turn_around.coco)).toBe(330)
    expect(sequenceDurationMs(CAT_ANIM_SEQUENCES.turn_around_fast.coco)).toBe(205)
  })
})
