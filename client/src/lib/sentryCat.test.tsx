import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import { act, render } from '@testing-library/react'
import {
  sentryCatAt,
  sentryCatName,
  sentryCatPossessive,
  sentryOnWatchLabel,
  sentryOffDutyLabel,
  sentryOffDutyHint,
  useSentryCat,
  type SentryCat,
} from './sentryCat'

const SLOT_MS = 30 * 60 * 1000
const T0 = 1_700_000_000_000

describe('sentryCatAt', () => {
  it('given the same timestamp, when called twice, then returns the same cat', () => {
    // arrange
    const t = T0

    // act
    const a = sentryCatAt(t)
    const b = sentryCatAt(t)

    // assert
    expect(a).toBe(b)
  })

  it('given two timestamps within the same 30-minute slot, when sampled, then returns the same cat', () => {
    // arrange — pick any timestamp; ensure +5 min stays in the same slot.
    const t = T0
    const inSameSlot = t + 5 * 60 * 1000

    // act
    const a = sentryCatAt(t)
    const b = sentryCatAt(inSameSlot)

    // assert
    expect(a).toBe(b)
  })

  it('given a sequence of three slots in one 90-minute block, when sampled, then ALL three cats appear exactly once', () => {
    // arrange — 90-minute block = three contiguous 30-min slots.
    // Pick the start of an arbitrary block.
    const blockStart = Math.floor(T0 / (3 * SLOT_MS)) * (3 * SLOT_MS)

    // act — sample slot 0, 1, 2 within the block.
    const seen = new Set<SentryCat>()
    for (let i = 0; i < 3; i++) {
      seen.add(sentryCatAt(blockStart + i * SLOT_MS))
    }

    // assert — block guarantee: no back-to-back repeats; all three present.
    expect(seen.size).toBe(3)
    expect(seen).toContain('panther')
    expect(seen).toContain('mushu')
    expect(seen).toContain('coco')
  })

  it('given consecutive slots within ANY block, when sampled, then no two adjacent slots return the same cat', () => {
    // arrange — align the sweep to a block boundary so the Latin-
    // square structure (one permutation per 3-slot block) maps
    // cleanly onto the sweep index. Without this alignment a
    // floor(timestamp / SLOT_MS) at an arbitrary epoch starts mid-
    // block and the index → within-block-position mapping is offset.
    const blockStart = Math.floor(T0 / (3 * SLOT_MS)) * (3 * SLOT_MS)
    const cats: SentryCat[] = []
    for (let i = 0; i < 198; i++) {
      cats.push(sentryCatAt(blockStart + i * SLOT_MS))
    }

    // act — count adjacent repeats inside blocks (within=0→1, 1→2)
    // versus across block boundaries (within=2 → next block's 0).
    let inBlockRepeats = 0
    let boundaryRepeats = 0
    for (let i = 1; i < cats.length; i++) {
      if (cats[i] === cats[i - 1]) {
        const withinFromIdx = i % 3 // 0 = boundary crossing, else in-block
        if (withinFromIdx === 0) {
          boundaryRepeats++
        } else {
          inBlockRepeats++
        }
      }
    }

    // assert — within-block repeats MUST be zero (Latin-square gate).
    // Boundary repeats are allowed (uniform-random across the 6
    // permutations gives ≈ 1/6 chance of matching the prior block's
    // last cat).
    expect(inBlockRepeats).toBe(0)
    expect(boundaryRepeats).toBeLessThan(cats.length / 3)
  })

  it('given a wide sweep of slots, when sampled, then the distribution across cats is roughly uniform', () => {
    // arrange — 600 slots = 200 blocks. Each block contributes one of
    // each cat exactly once (Latin-square within), so the overall
    // count is exactly even.
    const counts = { panther: 0, mushu: 0, coco: 0 }

    // act
    for (let i = 0; i < 600; i++) {
      counts[sentryCatAt(T0 + i * SLOT_MS)]++
    }

    // assert — perfect 200/200/200 because each block contributes
    // one of each.
    expect(counts.panther).toBe(200)
    expect(counts.mushu).toBe(200)
    expect(counts.coco).toBe(200)
  })

  it('given negative timestamps, when sampled, then returns a valid cat without throwing', () => {
    // arrange — defensive: Date.now() could conceivably yield a
    // negative on a misconfigured clock. The mod-3 normalization
    // must not produce a negative index.
    const t = -1

    // act
    const cat = sentryCatAt(t)

    // assert
    expect(['panther', 'mushu', 'coco']).toContain(cat)
  })

  it('given block index N and N+1, when permutations are computed, then they vary across the sweep (not all identical)', () => {
    // arrange — sample one slot per block for many blocks. If the
    // block-permutation hash were constant the same cat would always
    // appear at within=0; we assert at least two distinct cats
    // appear at the within=0 position.
    const start = T0
    const firstCatPerBlock = new Set<SentryCat>()

    // act
    for (let block = 0; block < 24; block++) {
      firstCatPerBlock.add(sentryCatAt(start + block * 3 * SLOT_MS))
    }

    // assert — varied permutations.
    expect(firstCatPerBlock.size).toBeGreaterThanOrEqual(2)
  })
})

describe('display helpers', () => {
  it('given a cat key, when sentryCatName called, then returns Title-Case name', () => {
    // arrange / act / assert
    expect(sentryCatName('panther')).toBe('Panther')
    expect(sentryCatName('mushu')).toBe('Mushu')
    expect(sentryCatName('coco')).toBe('Coco')
  })

  it('given a cat key, when sentryCatPossessive called, then returns Name+"’s"-style apostrophe-s', () => {
    // arrange / act / assert
    expect(sentryCatPossessive('panther')).toBe("Panther's")
    expect(sentryCatPossessive('mushu')).toBe("Mushu's")
    expect(sentryCatPossessive('coco')).toBe("Coco's")
  })

  it('given a cat key, when sentryOnWatchLabel called, then returns "<Name> on watch"', () => {
    // arrange / act / assert
    expect(sentryOnWatchLabel('panther')).toBe('Panther on watch')
    expect(sentryOnWatchLabel('mushu')).toBe('Mushu on watch')
    expect(sentryOnWatchLabel('coco')).toBe('Coco on watch')
  })

  it('given a cat key, when sentryOffDutyLabel called, then returns "<Name>’s off duty"', () => {
    // arrange / act / assert
    expect(sentryOffDutyLabel('panther')).toBe("Panther's off duty")
    expect(sentryOffDutyLabel('mushu')).toBe("Mushu's off duty")
    expect(sentryOffDutyLabel('coco')).toBe("Coco's off duty")
  })

  it('given a cat key, when sentryOffDutyHint called, then names the same cat in the resume copy', () => {
    // arrange / act / assert — pin: copy uses the SAME cat name as
    // the headline so user sees "Panther's off duty / bring Panther
    // back" and not a mixed-name banner.
    expect(sentryOffDutyHint('panther')).toContain('Panther')
    expect(sentryOffDutyHint('mushu')).toContain('Mushu')
    expect(sentryOffDutyHint('coco')).toContain('Coco')
  })
})

// iter-356.66: visibility-aware tick — the hook pauses while the
// tab is hidden so a backgrounded session doesn't burn frame budget
// on a sparkle animation no one can see.
describe('useSentryCat (visibility-aware)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  function HookProbe() {
    const cat = useSentryCat()
    return <span data-testid="cat">{cat}</span>
  }

  it('given the tab is hidden on mount, when 60s pass, then no interval tick fires', () => {
    // arrange — JSDOM defaults to visibilityState='visible'; force hidden.
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'hidden',
    })
    const setIntervalSpy = vi.spyOn(window, 'setInterval')

    // act
    render(<HookProbe />)
    act(() => {
      vi.advanceTimersByTime(60_000)
    })

    // assert — no setInterval was scheduled because mount started hidden.
    expect(setIntervalSpy).not.toHaveBeenCalled()
    setIntervalSpy.mockRestore()
  })

  it('given a visible tick, when the page becomes hidden, then the interval is cleared', () => {
    // arrange
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    })
    const clearIntervalSpy = vi.spyOn(window, 'clearInterval')
    render(<HookProbe />)

    // act — flip to hidden + dispatch the visibility event.
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'hidden',
    })
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })

    // assert
    expect(clearIntervalSpy).toHaveBeenCalled()
    clearIntervalSpy.mockRestore()
  })
})
