import { describe, expect, it } from 'vitest'
import { CAT_ANIM_SEQUENCES, CAT_IDS, sequenceDurationMs } from './catAnimSequences'
import { turnPivotView, type TurnPivot } from './catEngineCore'

const pivot: TurnPivot = { startedAt: 1000, from: 'L', to: 'R' }

describe('turn-around pivot', () => {
  it('Given the turn_around sequence, When its shape is inspected, Then it is a symmetric side→front→side ladder with the frontal stand frame centered', () => {
    // arrange — wave 5: the walk pivot carries the level-2 rungs
    // (turn_n2..n5) → 19 palindromic steps with stand at index 9. The
    // FAST pivot deliberately keeps the 11-rung wave-1 ladder: 205ms
    // over 19 rungs would be ~11ms/rung, below the 60fps display floor.
    const LADDER_19 = [
      'turn_0a', 'turn_n2', 'turn', 'turn_n3', 'turn_1b', 'turn_n4',
      'turn_2', 'turn_2c', 'turn_n5',
      'stand',
      'turn_n5', 'turn_2c', 'turn_2', 'turn_n4', 'turn_1b', 'turn_n3',
      'turn', 'turn_n2', 'turn_0a',
    ]
    const LADDER_11 = [
      'turn_0a', 'turn', 'turn_1b', 'turn_2', 'turn_2c',
      'stand',
      'turn_2c', 'turn_2', 'turn_1b', 'turn', 'turn_0a',
    ]

    // act / assert
    for (const catId of CAT_IDS) {
      const steps = CAT_ANIM_SEQUENCES.turn_around[catId]
      const fast = CAT_ANIM_SEQUENCES.turn_around_fast[catId]

      // assert — palindrome frame order, stand dead-center; the facing
      // flip at duration/2 must land INSIDE the stand step or the
      // mirror seam becomes visible on an asymmetric frame.
      for (const [seq, ladder] of [[steps, LADDER_19], [fast, LADDER_11]] as const) {
        expect(seq.map((s) => s.frame)).toEqual(ladder)
        const standIdx = ladder.indexOf('stand')
        const half = sequenceDurationMs(seq) / 2
        const standStart = seq.slice(0, standIdx).reduce((t, s) => t + s.ms, 0)
        const standEnd = standStart + seq[standIdx].ms
        expect(half).toBeGreaterThanOrEqual(standStart)
        expect(half).toBeLessThan(standEnd)
      }
    }
  })

  it('Given a pivot in flight, When the view is sampled across its timeline, Then facing switches exactly at the frontal midpoint and done fires at the end', () => {
    // arrange
    const steps = CAT_ANIM_SEQUENCES.turn_around.panther
    const duration = sequenceDurationMs(steps) // 330

    // act / assert — old facing through the first half (60ms into the
    // 18ms rungs = the turn_n3 level-2 rung)
    const early = turnPivotView(steps, pivot, 1000 + 60)
    expect(early).toEqual({ frame: 'turn_n3', facing: 'L', done: false })

    // mid-pivot: frontal frame, ALREADY flipped to the new facing
    const mid = turnPivotView(steps, pivot, 1000 + duration / 2)
    expect(mid).toEqual({ frame: 'stand', facing: 'R', done: false })

    // exit ramp: new facing on the way back out to profile (300ms lands
    // in the outbound turn_n2 rung, one from the ladder's end)
    const late = turnPivotView(steps, pivot, 1000 + duration - 30)
    expect(late).toEqual({ frame: 'turn_n2', facing: 'R', done: false })

    // completion
    expect(turnPivotView(steps, pivot, 1000 + duration).done).toBe(true)
  })

  it('Given a clock skew before the pivot start, When the view is sampled, Then elapsed clamps to zero instead of going negative', () => {
    // arrange
    const steps = CAT_ANIM_SEQUENCES.turn_around.mushu

    // act
    const view = turnPivotView(steps, pivot, 900)

    // assert
    expect(view).toEqual({ frame: 'turn_0a', facing: 'L', done: false })
  })

  it('Given both pivot speeds, When their totals are measured, Then the walk pivot is ~330ms and the sprint pivot ~205ms — both faster than reading as a hesitation', () => {
    // arrange / act / assert
    expect(sequenceDurationMs(CAT_ANIM_SEQUENCES.turn_around.coco)).toBe(330)
    expect(sequenceDurationMs(CAT_ANIM_SEQUENCES.turn_around_fast.coco)).toBe(205)
  })
})
