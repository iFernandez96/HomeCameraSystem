import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'

const getUnreadCount = vi.fn()
const subscribeEvents = vi.fn()

vi.mock('./api', () => ({
  getUnreadCount: (...a: unknown[]) => getUnreadCount(...a),
}))
vi.mock('./ws', () => ({
  subscribeEvents: (...a: unknown[]) => subscribeEvents(...a),
}))

import { useUnreadBadge } from './badge'

describe('useUnreadBadge', () => {
  let setAppBadge: ReturnType<typeof vi.fn>
  let clearAppBadge: ReturnType<typeof vi.fn>

  beforeEach(() => {
    getUnreadCount.mockReset()
    subscribeEvents.mockReset().mockReturnValue(() => {})
    setAppBadge = vi.fn().mockResolvedValue(undefined)
    clearAppBadge = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'setAppBadge', {
      value: setAppBadge,
      configurable: true,
    })
    Object.defineProperty(navigator, 'clearAppBadge', {
      value: clearAppBadge,
      configurable: true,
    })
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('given the unread-count poll returns N, when the hook mounts, then setAppBadge is called with N (iter-248)', async () => {
    // arrange
    getUnreadCount.mockResolvedValue({ count: 3 })

    // act
    renderHook(() => useUnreadBadge())

    // assert
    await waitFor(() => expect(setAppBadge).toHaveBeenCalledWith(3))
  })

  it('given the unread-count poll returns 0, when the hook mounts, then clearAppBadge is called (iter-248)', async () => {
    // arrange
    getUnreadCount.mockResolvedValue({ count: 0 })

    // act
    renderHook(() => useUnreadBadge())

    // assert
    await waitFor(() => expect(clearAppBadge).toHaveBeenCalled())
  })

  it('given a WS detection event arrives, when the badge hook is mounted, then setAppBadge is called with the incremented count (iter-248)', async () => {
    // arrange
    getUnreadCount.mockResolvedValue({ count: 2 })
    type Handler = (evt: { type: string }) => void
    let wsHandler: Handler | null = null
    subscribeEvents.mockImplementation((cb: Handler) => {
      wsHandler = cb
      return () => {}
    })
    renderHook(() => useUnreadBadge())
    await waitFor(() => expect(setAppBadge).toHaveBeenCalledWith(2))
    setAppBadge.mockClear()

    // act
    ;(wsHandler as Handler | null)?.({ type: 'detection' })

    // assert
    expect(setAppBadge).toHaveBeenCalledWith(3)
  })

  // iter-281 (test-coverage gap #3): visibility-resume re-fetches
  // canonical count from server. Pre-iter-276 the in-memory count
  // went stale on tab-resume (SW handled pushes while hidden).

  it('given the hook is mounted, when visibilitychange fires with state=visible, then getUnreadCount is re-fetched and setAppBadge updated (iter-276)', async () => {
    // arrange
    getUnreadCount
      .mockResolvedValueOnce({ count: 4 })
      .mockResolvedValueOnce({ count: 7 })
    renderHook(() => useUnreadBadge())
    await waitFor(() => expect(setAppBadge).toHaveBeenCalledWith(4))
    setAppBadge.mockClear()

    // act
    Object.defineProperty(document, 'visibilitychange', { configurable: true })
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    })
    document.dispatchEvent(new Event('visibilitychange'))

    // assert: 2nd getUnreadCount fires; setAppBadge gets the new
    // count. Backgrounded → foregrounded PWA picks up SW pushes.
    await waitFor(() => expect(setAppBadge).toHaveBeenCalledWith(7))
    expect(getUnreadCount).toHaveBeenCalledTimes(2)
  })

  it('given count > 99, when the hook mounts, then setAppBadge is called with 99 not the raw count (iter-356.7 widget B1)', async () => {
    // arrange — busy day with 312 unread events
    getUnreadCount.mockResolvedValue({ count: 312 })

    // act
    renderHook(() => useUnreadBadge())

    // assert — capped at 99 to match Ring/WhatsApp/iOS convention
    await waitFor(() => expect(setAppBadge).toHaveBeenCalledWith(99))
    expect(setAppBadge).not.toHaveBeenCalledWith(312)
  })

  it('given the hook is mounted, when homecam:badge-reconcile is dispatched on window, then getUnreadCount is re-fetched (iter-276)', async () => {
    // arrange
    getUnreadCount
      .mockResolvedValueOnce({ count: 5 })
      .mockResolvedValueOnce({ count: 0 })
    renderHook(() => useUnreadBadge())
    await waitFor(() => expect(setAppBadge).toHaveBeenCalledWith(5))

    // act: Events.tsx dispatches this after a per-event markEventSeen
    // so the badge re-fetches without waiting for the next WS event.
    window.dispatchEvent(new CustomEvent('homecam:badge-reconcile'))

    // assert
    await waitFor(() => expect(clearAppBadge).toHaveBeenCalled())
    expect(getUnreadCount).toHaveBeenCalledTimes(2)
  })
})
