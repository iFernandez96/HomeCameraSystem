import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'

const closeFn = vi.fn()
const connectWhep = vi.fn()
const subscribeEvents = vi.fn()

/**
 * Minimal fake of an `RTCPeerConnection`'s event-target surface so VideoTile's
 * iter-162 `connectionstatechange` listener can be exercised. Only the bits
 * the production code touches are implemented; the rest of the WebRTC API is
 * uninvolved (the WHEP handshake itself is mocked at the `connectWhep` layer).
 */
function fakePc(initialState: RTCPeerConnectionState = 'connected') {
  const listeners: Record<string, Array<() => void>> = {}
  const pc = {
    connectionState: initialState as RTCPeerConnectionState,
    addEventListener(ev: string, cb: () => void) {
      ;(listeners[ev] ??= []).push(cb)
    },
    removeEventListener(ev: string, cb: () => void) {
      listeners[ev] = (listeners[ev] ?? []).filter((f) => f !== cb)
    },
    setState(s: RTCPeerConnectionState) {
      pc.connectionState = s
      ;(listeners['connectionstatechange'] ?? []).forEach((f) => f())
    },
  }
  return pc
}

vi.mock('../lib/webrtc', () => ({
  connectWhep: (...a: unknown[]) => connectWhep(...a),
}))
vi.mock('../lib/ws', () => ({
  subscribeEvents: (...a: unknown[]) => subscribeEvents(...a),
}))

import { VideoTile } from './VideoTile'

describe('VideoTile', () => {
  beforeEach(() => {
    closeFn.mockClear()
    connectWhep.mockReset()
    subscribeEvents.mockReset()
    subscribeEvents.mockReturnValue(() => {})
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('shows Connecting then LIVE on a successful WHEP handshake', async () => {
    let resolveConn!: (v: { close: () => void; pc: object }) => void
    connectWhep.mockReturnValue(
      new Promise((r) => {
        resolveConn = r
      }),
    )
    render(<VideoTile src="http://test/cam/whep" />)
    expect(screen.getByText(/Connecting/i)).toBeInTheDocument()
    resolveConn({ close: closeFn, pc: fakePc() })
    await waitFor(() => expect(screen.getByText('Live')).toBeInTheDocument())
  })

  it('shows Offline when the connection fails', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    connectWhep.mockRejectedValue(new Error('boom'))
    render(<VideoTile src="http://test/cam/whep" />)
    await waitFor(() => expect(screen.getAllByText(/Offline/i)[0]).toBeInTheDocument())
    errorSpy.mockRestore()
  })

  it('passes the src URL to connectWhep', () => {
    connectWhep.mockReturnValue(new Promise(() => {}))
    render(<VideoTile src="http://test/cam/whep" />)
    expect(connectWhep).toHaveBeenCalledWith(
      'http://test/cam/whep',
      expect.any(Object),
    )
  })

  it('subscribes to the event stream on mount', () => {
    connectWhep.mockReturnValue(new Promise(() => {}))
    render(<VideoTile src="http://test/cam/whep" />)
    expect(subscribeEvents).toHaveBeenCalled()
  })

  it('closes the connection when unmounted', async () => {
    connectWhep.mockResolvedValue({ close: closeFn, pc: fakePc() })
    const { unmount } = render(<VideoTile src="http://test/cam/whep" />)
    await waitFor(() => expect(screen.getByText('Live')).toBeInTheDocument())
    unmount()
    expect(closeFn).toHaveBeenCalled()
  })

  it('unsubscribes from the event stream when unmounted', () => {
    const unsub = vi.fn()
    subscribeEvents.mockReturnValue(unsub)
    connectWhep.mockReturnValue(new Promise(() => {}))
    const { unmount } = render(<VideoTile src="http://test/cam/whep" />)
    unmount()
    expect(unsub).toHaveBeenCalled()
  })

  it('shows the PAUSED pill when detection is gated off and live', async () => {
    connectWhep.mockResolvedValue({ close: closeFn, pc: fakePc() })
    render(<VideoTile src="http://test/cam/whep" detectionActive={false} />)
    await waitFor(() => expect(screen.getByText('Live')).toBeInTheDocument())
    expect(screen.getByLabelText(/detection paused/i)).toBeInTheDocument()
  })

  it('does not show the PAUSED pill while connecting', () => {
    connectWhep.mockReturnValue(new Promise(() => {}))
    render(<VideoTile src="http://test/cam/whep" detectionActive={false} />)
    expect(screen.queryByLabelText(/detection paused/i)).not.toBeInTheDocument()
  })

  it('treats detectionActive=null as "unknown" and does not flash PAUSED', () => {
    connectWhep.mockResolvedValue({ close: closeFn, pc: fakePc() })
    render(<VideoTile src="http://test/cam/whep" detectionActive={null} />)
    expect(screen.queryByLabelText(/detection paused/i)).not.toBeInTheDocument()
  })

  // iter-356.C (mobile-redesign Slice C): the single "Detection
  // offline" pill split into three honest cases — Camera offline
  // (worker dead, no recent frame), Stream stalled (worker alive,
  // video silent), Detection paused — worker offline (worker dead
  // but video still playing). Old tests migrated to the new copy.

  it('given workerAlive=false and no recent frame, when rendered, then shows CAMERA OFFLINE pill with restart hint (iter-356.C)', async () => {
    // arrange
    connectWhep.mockResolvedValue({ close: closeFn, pc: fakePc() })

    // act
    render(
      <VideoTile
        src="http://test/cam/whep"
        detectionActive={true}
        workerAlive={false}
      />,
    )

    // assert
    await waitFor(() => expect(screen.getByText('Live')).toBeInTheDocument())
    expect(screen.getByLabelText(/camera offline/i)).toBeInTheDocument()
    expect(screen.getByText(/restart the camera service/i)).toBeInTheDocument()
  })

  it('given workerAlive=false and a recent frame counter, when rendered, then shows DETECTION PAUSED — WORKER OFFLINE pill (iter-356.C)', async () => {
    // arrange — server cached `seconds_since_last_frame` across the
    // worker restart, so the video is still playing while detection
    // is offline. Plain text only, no recovery prompt.
    connectWhep.mockResolvedValue({ close: closeFn, pc: fakePc() })

    // act
    render(
      <VideoTile
        src="http://test/cam/whep"
        detectionActive={true}
        workerAlive={false}
        streamStaleSeconds={5}
      />,
    )

    // assert
    await waitFor(() => expect(screen.getByText('Live')).toBeInTheDocument())
    expect(
      screen.getByLabelText(/detection paused — worker offline/i),
    ).toBeInTheDocument()
    expect(screen.queryByLabelText(/^camera offline/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/restart the camera service/i)).not.toBeInTheDocument()
  })

  it('CAMERA OFFLINE takes precedence over PAUSED when worker is dead', async () => {
    connectWhep.mockResolvedValue({ close: closeFn, pc: fakePc() })
    render(
      <VideoTile
        src="http://test/cam/whep"
        detectionActive={false}
        workerAlive={false}
      />,
    )
    await waitFor(() => expect(screen.getByText('Live')).toBeInTheDocument())
    expect(screen.getByLabelText(/camera offline/i)).toBeInTheDocument()
    expect(screen.queryByLabelText(/^detection paused$/i)).not.toBeInTheDocument()
  })

  it('treats workerAlive=null as "unknown" and does not flash OFFLINE', () => {
    connectWhep.mockResolvedValue({ close: closeFn, pc: fakePc() })
    render(<VideoTile src="http://test/cam/whep" workerAlive={null} />)
    expect(screen.queryByLabelText(/camera offline/i)).not.toBeInTheDocument()
    expect(
      screen.queryByLabelText(/detection paused — worker offline/i),
    ).not.toBeInTheDocument()
  })

  // iter-302a/b (test-coverage-auditor D2): the stream-stale pill is
  // the user-visible signal of the iter-300 outage class. Pin its
  // precedence + render gate.

  it('given streamStaleSeconds > 60 and status live, when rendered, then shows STREAM STALE pill (iter-302)', async () => {
    // arrange
    connectWhep.mockResolvedValue({ close: closeFn, pc: fakePc() })

    // act
    render(
      <VideoTile
        src="http://test/cam/whep"
        workerAlive={true}
        streamStaleSeconds={90}
      />,
    )

    // assert
    await waitFor(() => expect(screen.getByText('Live')).toBeInTheDocument())
    // iter-356.C: visible text "Stream stalled"; the "no video for Ns"
    // detail moved into the aria-label so SR users still hear it but
    // the visible UI stays calm.
    expect(screen.getByText(/stream stalled/i)).toBeInTheDocument()
    expect(
      screen.getByLabelText(/no video for 90s/i),
    ).toBeInTheDocument()
  })

  it('given streamStaleSeconds <= 60, when rendered, then no STREAM STALE pill (iter-302)', async () => {
    // arrange
    connectWhep.mockResolvedValue({ close: closeFn, pc: fakePc() })

    // act
    render(
      <VideoTile
        src="http://test/cam/whep"
        workerAlive={true}
        streamStaleSeconds={30}
      />,
    )

    // assert — give the LIVE pill time to render so we know the
    // status branch is "live" (when stale would be eligible).
    await waitFor(() => expect(screen.getByText('Live')).toBeInTheDocument())
    expect(screen.queryByText(/stream stalled/i)).not.toBeInTheDocument()
  })

  it('given streamStaleSeconds > 60 and worker alive, when stale and offline conflict, then STREAM STALE wins over OFFLINE (iter-302)', async () => {
    // arrange — worker alive but stream stalled is the iter-300
    // signature. Stream-stale should take precedence over the
    // OFFLINE pill (which only fires when worker_alive=false).
    connectWhep.mockResolvedValue({ close: closeFn, pc: fakePc() })

    // act
    render(
      <VideoTile
        src="http://test/cam/whep"
        workerAlive={true}
        detectionActive={true}
        streamStaleSeconds={120}
      />,
    )

    // assert
    await waitFor(() => expect(screen.getByText('Live')).toBeInTheDocument())
    // iter-356.C: stream-stale aria-label collapses seconds + Reconnect
    // hint into a single string; visible text says "Stream stalled".
    expect(screen.getByText(/stream stalled/i)).toBeInTheDocument()
    expect(
      screen.queryByLabelText(/^camera offline/i),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByLabelText(/^detection paused$/i),
    ).not.toBeInTheDocument()
  })

  it('shows the LOW MEMORY pill when the worker has tripped its memory guard', async () => {
    connectWhep.mockResolvedValue({ close: closeFn, pc: fakePc() })
    render(
      <VideoTile
        src="http://test/cam/whep"
        workerAlive={true}
        lowMemory={true}
        detectionActive={true}
      />,
    )
    await waitFor(() =>
      expect(
        screen.getByLabelText(/detection paused due to low memory/i),
      ).toBeInTheDocument(),
    )
    expect(screen.getByText(/Low memory/i)).toBeInTheDocument()
    // PAUSED should be suppressed since LOW MEMORY takes precedence.
    expect(screen.queryByText(/^PAUSED$/)).not.toBeInTheDocument()
  })

  it('shows the THERMAL pill when the worker downshifts on heat', async () => {
    connectWhep.mockResolvedValue({ close: closeFn, pc: fakePc() })
    render(
      <VideoTile
        src="http://test/cam/whep"
        workerAlive={true}
        thermal={true}
        detectionActive={true}
      />,
    )
    await waitFor(() =>
      expect(
        screen.getByLabelText(/rate-limited by gpu thermal/i),
      ).toBeInTheDocument(),
    )
    expect(screen.getByText(/camera too hot/i)).toBeInTheDocument()
    // PAUSED is suppressed since THERMAL takes precedence.
    expect(screen.queryByText(/^PAUSED$/)).not.toBeInTheDocument()
  })

  it('LOW MEMORY takes precedence over THERMAL when both are set', async () => {
    connectWhep.mockResolvedValue({ close: closeFn, pc: fakePc() })
    render(
      <VideoTile
        src="http://test/cam/whep"
        workerAlive={true}
        lowMemory={true}
        thermal={true}
      />,
    )
    await waitFor(() =>
      expect(
        screen.getByLabelText(/detection paused due to low memory/i),
      ).toBeInTheDocument(),
    )
    expect(screen.queryByText(/camera too hot/i)).not.toBeInTheDocument()
  })

  it('OFFLINE takes precedence over LOW MEMORY when the worker is dead', async () => {
    connectWhep.mockResolvedValue({ close: closeFn, pc: fakePc() })
    render(
      <VideoTile
        src="http://test/cam/whep"
        workerAlive={false}
        lowMemory={true}
      />,
    )
    await waitFor(() =>
      expect(screen.getByLabelText(/camera offline/i)).toBeInTheDocument(),
    )
    expect(screen.queryByText(/Low memory/i)).not.toBeInTheDocument()
  })

  it('flips to error when the peer connection state becomes failed (iter-162)', async () => {
    const pc = fakePc()
    connectWhep.mockResolvedValue({ close: closeFn, pc })
    render(<VideoTile src="http://test/cam/whep" />)
    await waitFor(() => expect(screen.getByText('Live')).toBeInTheDocument())
    pc.setState('failed')
    await waitFor(() =>
      expect(screen.getByText(/can.t reach your camera/i)).toBeInTheDocument(),
    )
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument()
  })

  it('flips to error when the peer connection state becomes disconnected (iter-162)', async () => {
    const pc = fakePc()
    connectWhep.mockResolvedValue({ close: closeFn, pc })
    render(<VideoTile src="http://test/cam/whep" />)
    await waitFor(() => expect(screen.getByText('Live')).toBeInTheDocument())
    pc.setState('disconnected')
    await waitFor(() =>
      expect(screen.getByText(/can.t reach your camera/i)).toBeInTheDocument(),
    )
  })

  it('does NOT flip to error on benign mid-stream state changes (iter-162)', async () => {
    // 'new' / 'connecting' / 'connected' don't indicate failure — the WebRTC
    // spec allows these to transition during a healthy session. Only the
    // failure states (`failed`, `disconnected`, `closed`) should surface
    // the Camera-unreachable UI.
    const pc = fakePc()
    connectWhep.mockResolvedValue({ close: closeFn, pc })
    render(<VideoTile src="http://test/cam/whep" />)
    await waitFor(() => expect(screen.getByText('Live')).toBeInTheDocument())
    pc.setState('connected')
    expect(screen.getByText('Live')).toBeInTheDocument()
    expect(screen.queryByText(/can.t reach your camera/i)).not.toBeInTheDocument()
  })

  it('Retry after mid-stream failure triggers a new WHEP connect (iter-162)', async () => {
    const pc1 = fakePc()
    const pc2 = fakePc()
    connectWhep
      .mockResolvedValueOnce({ close: closeFn, pc: pc1 })
      .mockResolvedValueOnce({ close: closeFn, pc: pc2 })
    render(<VideoTile src="http://test/cam/whep" />)
    await waitFor(() => expect(screen.getByText('Live')).toBeInTheDocument())
    expect(connectWhep).toHaveBeenCalledTimes(1)
    pc1.setState('failed')
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument(),
    )
    fireEvent.click(screen.getByRole('button', { name: /retry/i }))
    await waitFor(() => expect(connectWhep).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.getByText('Live')).toBeInTheDocument())
  })

  it('flips to error when the <video> element fires error (iter-174)', async () => {
    // iter-174 companion to iter-162. `connectionstatechange` covers
    // negotiation-layer failure; <video>.error covers codec/decoder
    // failure (e.g. unsupported codec, corrupt stream, hardware
    // decode bus error on the Nano). Both must surface the error UI.
    const pc = fakePc()
    connectWhep.mockResolvedValue({ close: closeFn, pc })
    render(<VideoTile src="http://test/cam/whep" />)
    await waitFor(() => expect(screen.getByText('Live')).toBeInTheDocument())
    const video = screen.getByLabelText('Live camera feed')
    fireEvent.error(video)
    await waitFor(() =>
      expect(screen.getByText(/can.t reach your camera/i)).toBeInTheDocument(),
    )
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument()
  })

  it('flips to error when the <video> element stalls for 3 s (iter-174)', async () => {
    // Browsers fire `stalled` aggressively during normal buffer fills,
    // so iter-174 debounces 3 s before flipping the UI. This test
    // proves the timer fires at the threshold.
    const pc = fakePc()
    connectWhep.mockResolvedValue({ close: closeFn, pc })
    render(<VideoTile src="http://test/cam/whep" />)
    await waitFor(() => expect(screen.getByText('Live')).toBeInTheDocument())
    vi.useFakeTimers()
    try {
      const video = screen.getByLabelText('Live camera feed')
      fireEvent.stalled(video)
      // Just under 3 s — should still be LIVE.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2900)
      })
      expect(screen.queryByText(/can.t reach your camera/i)).not.toBeInTheDocument()
      // Cross the threshold.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(200)
      })
      expect(screen.getByText(/can.t reach your camera/i)).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does NOT flip to error when a stall recovers via playing (iter-174)', async () => {
    // The most common case: browser buffers underrun briefly, then
    // recovers. Pre-iter-174 there was no observation; post-iter-174
    // we'd false-positive frozen-camera UI on every healthy hiccup
    // unless the stall timer is cancelled by `playing`.
    const pc = fakePc()
    connectWhep.mockResolvedValue({ close: closeFn, pc })
    render(<VideoTile src="http://test/cam/whep" />)
    await waitFor(() => expect(screen.getByText('Live')).toBeInTheDocument())
    vi.useFakeTimers()
    try {
      const video = screen.getByLabelText('Live camera feed')
      fireEvent.stalled(video)
      // 1 s into the stall, playing recovers — timer must be cancelled.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000)
      })
      fireEvent.playing(video)
      // Run past the original 3 s threshold; UI must NOT flip.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000)
      })
      expect(screen.getByText('Live')).toBeInTheDocument()
      expect(screen.queryByText(/can.t reach your camera/i)).not.toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('given WHEP resolves but media never flows, when 8s elapse, then status flips to error (iter-244d)', async () => {
    // arrange
    vi.useFakeTimers()
    const pc = fakePc('connecting')
    connectWhep.mockResolvedValue({ close: closeFn, pc })
    render(<VideoTile src="http://test/cam/whep" />)

    // act
    // Let the connectWhep promise resolve into the .then handler so
    // the 8 s media-timer is armed.
    await act(async () => {
      await Promise.resolve()
    })
    await act(async () => {
      vi.advanceTimersByTime(8001)
    })

    // assert
    // iter-356.63 (mobile redesign Slice F): the offline overlay
    // now uses the shared <OfflineState> primitive whose heading
    // is "Camera offline", so /Offline/i now matches both the
    // StatusPill label AND the overlay heading. Match specifically
    // by allowing multiple results.
    expect(screen.getAllByText(/Offline/i).length).toBeGreaterThan(0)
    expect(screen.queryByText('LIVE')).not.toBeInTheDocument()
    vi.useRealTimers()
  })

  it('when the box-overlay toggle is clicked, then aria-pressed flips and persists in localStorage (iter-246)', async () => {
    // arrange
    window.localStorage.removeItem('homecam:boxesVisible')
    connectWhep.mockResolvedValue({ close: closeFn, pc: fakePc() })
    render(<VideoTile src="http://test/cam/whep" />)
    const btn = screen.getByRole('button', { name: /hide detection boxes/i })

    // act
    fireEvent.click(btn)

    // assert
    expect(btn).toHaveAttribute('aria-pressed', 'false')
    expect(window.localStorage.getItem('homecam:boxesVisible')).toBe('0')
    expect(
      screen.getByRole('button', { name: /show detection boxes/i }),
    ).toBeInTheDocument()
  })

  it('when the fullscreen button is clicked, then container.requestFullscreen is called (iter-244c)', async () => {
    // arrange
    const requestFullscreen = vi.fn().mockResolvedValue(undefined)
    // jsdom doesn't implement Fullscreen API; install a stub on the
    // HTMLElement prototype so ANY ref-targeted element gains it.
    const proto = HTMLElement.prototype as unknown as {
      requestFullscreen?: () => Promise<void>
    }
    const original = proto.requestFullscreen
    proto.requestFullscreen = requestFullscreen

    connectWhep.mockResolvedValue({ close: closeFn, pc: fakePc() })
    render(<VideoTile src="http://test/cam/whep" />)
    const btn = screen.getByRole('button', { name: /enter fullscreen/i })

    // act
    fireEvent.click(btn)

    // assert
    expect(requestFullscreen).toHaveBeenCalledTimes(1)
    if (original) proto.requestFullscreen = original
    else delete proto.requestFullscreen
  })

  // iter-277 (functionality-auditor #3): visibility-resume retry +
  // network-online retry. BDD-lite naming, AAA structure.

  it('given status is error, when the tab becomes visible, then connectWhep is re-invoked (iter-277)', async () => {
    // arrange: WHEP fails first time → status='error'.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    connectWhep.mockRejectedValueOnce(new Error('boom'))
    // Second attempt resolves cleanly so the retry succeeds.
    connectWhep.mockResolvedValue({ close: closeFn, pc: fakePc() })
    render(<VideoTile src="http://test/cam/whep" />)
    await waitFor(() =>
      expect(screen.getAllByText(/Offline/i)[0]).toBeInTheDocument(),
    )
    expect(connectWhep).toHaveBeenCalledTimes(1)

    // act: simulate phone-resume (background → foreground).
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    })
    document.dispatchEvent(new Event('visibilitychange'))

    // assert: a fresh WHEP attempt (retryNonce bump triggers the
    // effect closure to re-run with a new connection).
    await waitFor(() => expect(connectWhep).toHaveBeenCalledTimes(2))
    errorSpy.mockRestore()
  })

  it('given status is error, when network goes online, then connectWhep is re-invoked (iter-277)', async () => {
    // arrange
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    connectWhep.mockRejectedValueOnce(new Error('boom'))
    connectWhep.mockResolvedValue({ close: closeFn, pc: fakePc() })
    render(<VideoTile src="http://test/cam/whep" />)
    await waitFor(() =>
      expect(screen.getAllByText(/Offline/i)[0]).toBeInTheDocument(),
    )
    expect(connectWhep).toHaveBeenCalledTimes(1)

    // act: Wi-Fi → cellular (or vice versa) fires `online` on window.
    window.dispatchEvent(new Event('online'))

    // assert
    await waitFor(() => expect(connectWhep).toHaveBeenCalledTimes(2))
    errorSpy.mockRestore()
  })

  it('given status is live, when the tab becomes visible, then connectWhep is NOT re-invoked (iter-277 idempotency)', async () => {
    // arrange: clean LIVE state.
    connectWhep.mockResolvedValue({ close: closeFn, pc: fakePc() })
    render(<VideoTile src="http://test/cam/whep" />)
    await waitFor(() => expect(connectWhep).toHaveBeenCalledTimes(1))

    // act
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    })
    document.dispatchEvent(new Event('visibilitychange'))
    // Give React/effects a tick to settle.
    await new Promise((r) => setTimeout(r, 50))

    // assert: no extra connectWhep call. Visibility-resume only acts
    // when status === 'error', not when the connection is healthy.
    expect(connectWhep).toHaveBeenCalledTimes(1)
  })

  it('observes the video element and redraws on resize', async () => {
    const observe = vi.fn()
    const disconnect = vi.fn()
    let observerCallback: (() => void) | null = null
    const RealRO = window.ResizeObserver
    class MockRO {
      constructor(cb: () => void) {
        observerCallback = cb
      }
      observe = observe
      disconnect = disconnect
      unobserve = vi.fn()
    }
    // @ts-expect-error - swapping a global for the duration of one test.
    window.ResizeObserver = MockRO

    connectWhep.mockResolvedValue({ close: closeFn, pc: fakePc() })
    const { unmount } = render(<VideoTile src="http://test/cam/whep" />)
    await waitFor(() => expect(observe).toHaveBeenCalledTimes(1))
    // Observed target is the <video> element.
    const observed = observe.mock.calls[0][0] as HTMLElement
    expect(observed.tagName).toBe('VIDEO')
    // Triggering the callback shouldn't throw — the draw path runs against
    // the canvas with whatever boxes/visibility state we have.
    expect(() => observerCallback?.()).not.toThrow()
    unmount()
    expect(disconnect).toHaveBeenCalled()
    window.ResizeObserver = RealRO
  })
})
