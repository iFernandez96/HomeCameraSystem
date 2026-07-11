import { describe, expect, it } from 'vitest'
import { pathOverlapsPrivacyMasks } from './geometry'

const MASK: Array<[number, number]> = [
  [0.4, 0.4],
  [0.6, 0.4],
  [0.6, 0.6],
  [0.4, 0.6],
]

describe('pathOverlapsPrivacyMasks', () => {
  it('given a crossing line whose endpoints sit outside a mask, when it passes through the mask, then overlap is detected', () => {
    expect(
      pathOverlapsPrivacyMasks(
        [
          [0.2, 0.5],
          [0.8, 0.5],
        ],
        false,
        [MASK],
      ),
    ).toBe(true)
  })

  it('given a privacy mask wholly inside a rule polygon, when checked, then containment overlap is detected', () => {
    expect(
      pathOverlapsPrivacyMasks(
        [
          [0.1, 0.1],
          [0.9, 0.1],
          [0.9, 0.9],
          [0.1, 0.9],
        ],
        true,
        [MASK],
      ),
    ).toBe(true)
  })

  it('given a rule outside every privacy mask, when checked, then saving remains allowed', () => {
    expect(
      pathOverlapsPrivacyMasks(
        [
          [0.05, 0.05],
          [0.2, 0.2],
        ],
        false,
        [MASK],
      ),
    ).toBe(false)
  })
})
