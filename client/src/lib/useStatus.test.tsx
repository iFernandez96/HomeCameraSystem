import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'

const getStatus = vi.fn()
vi.mock('./api', () => ({
  getStatus: (...a: unknown[]) => getStatus(...a),
}))

import { useStatus } from './useStatus'
import type { ServerStatus } from './types'

function fakeStatus(over: Partial<ServerStatus> = {}): ServerStatus {
  return {
    ok: true,
    uptime_s: 100,
    camera: 'ok',
    detection_active: true,
    worker_alive: true,
    worker_last_seen_s: 5,
    worker_metrics: null,
    cpu_temp_c: 50,
    gpu_temp_c: 47,
    cpu_freq_pct: 100,
    load_avg: [0.5, 0.6, 0.7],
    memory_used_mb: 1400,
    memory_total_mb: 1979,
    disk_free_gb: 28,
    fps: 5.0,
    push_subs_count: 0,
    seconds_since_last_frame: null,
    camera_label: 'Front Door',
    audio_enabled: false,
    ...over,
  }
}

describe('useStatus', () => {
  beforeEach(() => {
    getStatus.mockReset()
    // jsdom defaults visibilityState to "visible" — but reset just in case
    // a prior test mutated it.
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('fetches status on mount when the tab is visible', async () => {
    getStatus.mockResolvedValue(fakeStatus({ uptime_s: 42 }))
    const { result } = renderHook(() => useStatus(5000))
    await waitFor(() => expect(result.current?.uptime_s).toBe(42))
    expect(getStatus).toHaveBeenCalledTimes(1)
  })

  it('does not fetch while the tab is hidden on mount', () => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'hidden',
    })
    getStatus.mockResolvedValue(fakeStatus())
    renderHook(() => useStatus(5000))
    expect(getStatus).not.toHaveBeenCalled()
  })

  it('resumes polling with an immediate tick when visibility changes back', async () => {
    let visState = 'hidden'
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => visState,
    })
    getStatus.mockResolvedValue(fakeStatus())
    renderHook(() => useStatus(5000))
    expect(getStatus).not.toHaveBeenCalled()

    visState = 'visible'
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await waitFor(() => expect(getStatus).toHaveBeenCalledTimes(1))
  })

  it('stops fetching when the tab goes hidden mid-session', async () => {
    getStatus.mockResolvedValue(fakeStatus())
    let visState = 'visible'
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => visState,
    })
    renderHook(() => useStatus(50))
    await waitFor(() => expect(getStatus).toHaveBeenCalledTimes(1))

    // Go hidden — pending interval should be torn down.
    visState = 'hidden'
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    const callsAtPause = getStatus.mock.calls.length
    // Wait several intervals worth of wall time; calls should not grow.
    await new Promise((r) => setTimeout(r, 200))
    expect(getStatus.mock.calls.length).toBe(callsAtPause)
  })

  it('returns null after sustained fetch failures', async () => {
    // iter-177: a SINGLE failed poll no longer flips state to null.
    // Pre-iter-177 a transient blip would collapse every LiveStats
    // / Settings readout to em-dashes for one tick. Now we hold the
    // last-known-good through the first failure; only on the second
    // consecutive non-Abort failure do we surface "server
    // unreachable" by clearing state. This test exercises the
    // sustained-failure case with rejects on every poll.
    getStatus.mockRejectedValue(new Error('boom'))
    const { result } = renderHook(() => useStatus(50))
    // Two failures × 50 ms interval + scheduling slack — within
    // 500 ms result.current should have flipped to null.
    await waitFor(() => expect(result.current).toBeNull(), { timeout: 500 })
  })

  it('preserves last-known-good through a single transient failure (iter-177)', async () => {
    // Single failed poll: state must NOT clear. Charter "boring to
    // operate" bar — UI shouldn't flicker readouts to em-dashes
    // every time the LAN drops a packet. Pre-iter-177 a single
    // failure flipped to null; post-iter-177 the failure-streak
    // threshold (2) holds last-known-good through the first miss.
    //
    // Mock pattern: succeed → fail → succeed-forever. Asserts that
    // state never becomes null across the whole sequence.
    let pollCount = 0
    getStatus.mockImplementation(() => {
      pollCount += 1
      if (pollCount === 2) {
        return Promise.reject(new Error('transient'))
      }
      return Promise.resolve(fakeStatus({ uptime_s: pollCount }))
    })
    const { result } = renderHook(() => useStatus(30))
    // Wait for at least 3 polls (success, fail, success-again).
    await waitFor(() => expect(pollCount).toBeGreaterThanOrEqual(3), {
      timeout: 1000,
    })
    // Critical invariant: through the entire sequence — including
    // the moment after the failure landed — state was never
    // cleared to null. Pre-iter-177 it would have been.
    expect(result.current).not.toBeNull()
    // And we got a fresh value after recovery (some successful
    // poll number ≥ 3, since exact timing of waitFor vs the next
    // tick is racy).
    expect(result.current?.uptime_s).toBeGreaterThanOrEqual(3)
  })
})
