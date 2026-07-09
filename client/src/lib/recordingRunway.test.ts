import { describe, expect, it } from 'vitest'
import { estimateDaysLeft } from './recordingRunway'

describe('estimateDaysLeft', () => {
  it('Given 24 GB free at 8 GB/day, When estimateDaysLeft runs, Then it reports about 3 days left', () => {
    // arrange / act
    const runway = estimateDaysLeft(24, 8)

    // assert
    expect(runway).toEqual({ daysLeft: 3, basis: 'assumed-rate' })
  })

  it('Given null free space, When estimateDaysLeft runs, Then days left is null', () => {
    // arrange / act
    const runway = estimateDaysLeft(null)

    // assert
    expect(runway).toEqual({ daysLeft: null, basis: 'assumed-rate' })
  })
})
