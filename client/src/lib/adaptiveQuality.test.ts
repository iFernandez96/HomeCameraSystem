import { describe, expect, it } from 'vitest'
import {
  advanceAdaptiveQuality,
  initialAdaptiveState,
  signalFromSnapshots,
} from './adaptiveQuality'

describe('adaptive stream quality', () => {
  it('derives loss, dropped-frame, jitter, and freeze deltas from cumulative WebRTC stats', () => {
    const signal = signalFromSnapshots(
      { packetsLost: 10, packetsReceived: 90, jitterSeconds: 0.01, framesDropped: 2, framesDecoded: 98, freezeCount: 1 },
      { packetsLost: 15, packetsReceived: 185, jitterSeconds: 0.08, framesDropped: 4, framesDecoded: 196, freezeCount: 2 },
    )

    expect(signal).toEqual({
      lossRatio: 0.05,
      dropRatio: 0.02,
      jitterMs: 80,
      freezes: 1,
    })
  })

  it('downshifts one rung immediately for a freeze after cooldown', () => {
    const state = initialAdaptiveState('hq', 0)
    const next = advanceAdaptiveQuality(
      state,
      { lossRatio: 0, dropRatio: 0, jitterMs: 10, freezes: 1 },
      15_000,
    )
    expect(next.quality).toBe('sd')
  })

  it('requires two ordinary bad samples before downshifting', () => {
    const state = initialAdaptiveState('hq', 0)
    const once = advanceAdaptiveQuality(
      state,
      { lossRatio: 0.06, dropRatio: 0, jitterMs: 20, freezes: 0 },
      15_000,
    )
    const twice = advanceAdaptiveQuality(
      once,
      { lossRatio: 0.06, dropRatio: 0, jitterMs: 20, freezes: 0 },
      20_000,
    )
    expect(once.quality).toBe('hq')
    expect(twice.quality).toBe('sd')
  })

  it('requires six clean samples and never upgrades above the initial network ceiling', () => {
    let state = initialAdaptiveState('sd', 0)
    state = { ...state, quality: 'xs', lastChangeMs: 0 }
    const clean = { lossRatio: 0, dropRatio: 0, jitterMs: 5, freezes: 0 }
    for (let i = 1; i <= 5; i += 1) {
      state = advanceAdaptiveQuality(state, clean, 30_000 + i * 5_000)
    }
    expect(state.quality).toBe('xs')
    state = advanceAdaptiveQuality(state, clean, 60_000)
    expect(state.quality).toBe('sd')
    for (let i = 1; i <= 10; i += 1) {
      state = advanceAdaptiveQuality(state, clean, 60_000 + i * 5_000)
    }
    expect(state.quality).toBe('sd')
  })

  it('returns no signal when no packets or frames advanced', () => {
    const snapshot = { packetsLost: 1, packetsReceived: 2, jitterSeconds: 0.1, framesDropped: 3, framesDecoded: 4, freezeCount: 5 }
    expect(signalFromSnapshots(snapshot, snapshot)).toBeNull()
  })
})

