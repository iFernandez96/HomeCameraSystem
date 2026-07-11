import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'

const closeFn = vi.fn()
const connectWhep = vi.fn()
const subscribeEvents = vi.fn()
const drawBoxes = vi.fn()

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

/**
 * First-frame gate (2026-07-07): status flips to 'live' ONLY on a real
 * frame signal from the <video> element (`playing` / `loadeddata` /
 * requestVideoFrameCallback) — pc `connectionState === 'connected'` no
 * longer counts (ICE up is not frames on screen). jsdom never fires
 * media events on its own, so tests simulate the first decoded frame
 * explicitly. The leading empty `act` lets connectWhep's `.then` run
 * first (arming the 8 s media-timer) so the frame event also clears it,
 * matching the real-browser ordering.
 */
async function fireFirstFrame() {
  await act(async () => {})
  fireEvent.loadedData(document.querySelector('video')!)
}

function installRvfcMock() {
  const originalRequest = Object.getOwnPropertyDescriptor(
    HTMLVideoElement.prototype,
    'requestVideoFrameCallback',
  )
  const originalCancel = Object.getOwnPropertyDescriptor(
    HTMLVideoElement.prototype,
    'cancelVideoFrameCallback',
  )
  const callbacks = new Map<number, () => void>()
  let nextId = 1
  const requestVideoFrameCallback = vi.fn((cb: () => void) => {
    const id = nextId++
    callbacks.set(id, cb)
    return id
  })
  const cancelVideoFrameCallback = vi.fn((id: number) => {
    callbacks.delete(id)
  })
  Object.defineProperty(HTMLVideoElement.prototype, 'requestVideoFrameCallback', {
    configurable: true,
    value: requestVideoFrameCallback,
  })
  Object.defineProperty(HTMLVideoElement.prototype, 'cancelVideoFrameCallback', {
    configurable: true,
    value: cancelVideoFrameCallback,
  })
  return {
    requestVideoFrameCallback,
    cancelVideoFrameCallback,
    async fire(id: number) {
      await act(async () => {
        callbacks.get(id)?.()
      })
    },
    restore() {
      if (originalRequest) {
        Object.defineProperty(
          HTMLVideoElement.prototype,
          'requestVideoFrameCallback',
          originalRequest,
        )
      } else {
        Reflect.deleteProperty(
          HTMLVideoElement.prototype,
          'requestVideoFrameCallback',
        )
      }
      if (originalCancel) {
        Object.defineProperty(
          HTMLVideoElement.prototype,
          'cancelVideoFrameCallback',
          originalCancel,
        )
      } else {
        Reflect.deleteProperty(
          HTMLVideoElement.prototype,
          'cancelVideoFrameCallback',
        )
      }
    },
  }
}

vi.mock('../lib/webrtc', () => ({
  connectWhep: (...a: unknown[]) => connectWhep(...a),
}))
vi.mock('../lib/ws', () => ({
  subscribeEvents: (...a: unknown[]) => subscribeEvents(...a),
}))
vi.mock('../lib/drawBoxes', () => ({
  drawBoxes: (...a: unknown[]) => drawBoxes(...a),
}))

import { VideoTile } from './VideoTile'

describe('VideoTile', () => {
  beforeEach(() => {
    closeFn.mockClear()
    connectWhep.mockReset()
    subscribeEvents.mockReset()
    subscribeEvents.mockReturnValue(() => {})
    drawBoxes.mockReset()
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
    await fireFirstFrame()
    await waitFor(() => expect(screen.getByText('Live')).toBeInTheDocument())
  })

  it('Given WHEP resolved and the pc reports connected, When no frame signal has fired, Then the pill stays Connecting; a subsequent loadeddata flips it to Live (first-frame gate, 2026-07-07)', async () => {
    // arrange — WHEP handshake succeeds and ICE reaches 'connected'.
    const pc = fakePc('connecting')
    connectWhep.mockResolvedValue({ close: closeFn, pc })
    render(<VideoTile src="http://test/cam/whep" />)
    await act(async () => {}) // let connectWhep's .then register the pc listener

    // act — ICE up. This used to mark live, but ICE connects seconds
    // before the first decodable keyframe (~4 s GOP), so 'connected'
    // alone must NOT produce the Live pill anymore.
    act(() => pc.setState('connected'))

    // assert — still Connecting, no Live pill.
    expect(screen.getByText(/Connecting/i)).toBeInTheDocument()
    expect(screen.queryByText('Live')).not.toBeInTheDocument()

    // act — the first decoded frame arrives.
    await fireFirstFrame()

    // assert — NOW it's Live.
    await waitFor(() => expect(screen.getByText('Live')).toBeInTheDocument())
  })

  it('Given requestVideoFrameCallback exists, When playing fires before a presented frame, Then the pill stays Connecting until rVFC fires (harness #5 W3)', async () => {
    const rvfc = installRvfcMock()
    try {
      connectWhep.mockResolvedValue({ close: closeFn, pc: fakePc() })
      render(<VideoTile src="http://test/cam/whep" />)
      await act(async () => {})

      fireEvent.playing(screen.getByLabelText('Live camera feed'))

      expect(screen.getByText(/Connecting/i)).toBeInTheDocument()
      expect(screen.queryByText('Live')).not.toBeInTheDocument()

      await rvfc.fire(1)

      await waitFor(() => expect(screen.getByText('Live')).toBeInTheDocument())
    } finally {
      rvfc.restore()
    }
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
      expect.any(Object),
    )
  })

  it('subscribes to the event stream on mount', () => {
    connectWhep.mockReturnValue(new Promise(() => {}))
    render(<VideoTile src="http://test/cam/whep" />)
    expect(subscribeEvents).toHaveBeenCalled()
  })

  it('uses live_detection samples for the live bbox overlay', async () => {
    const originalGetContext = HTMLCanvasElement.prototype.getContext
    HTMLCanvasElement.prototype.getContext = vi.fn(() => ({})) as unknown as typeof originalGetContext
    try {
      let handler!: (evt: {
        type: 'live_detection'
        boxes: Array<{ x: number; y: number; w: number; h: number; label: string; score: number }>
        camera_id: string
        ts: number
        v: 1
      }) => void
      subscribeEvents.mockImplementation((cb) => {
        handler = cb
        return () => {}
      })
      connectWhep.mockReturnValue(new Promise(() => {}))
      render(<VideoTile src="http://test/cam/whep" />)

      const box = { x: 0.1, y: 0.2, w: 0.3, h: 0.4, label: 'person', score: 0.9 }
      await act(async () => {
        handler({ v: 1, type: 'live_detection', ts: 1, camera_id: 'cam1', boxes: [box] })
      })

      expect(drawBoxes).toHaveBeenLastCalledWith(
        expect.any(Object),
        expect.any(HTMLCanvasElement),
        expect.any(HTMLVideoElement),
        [box],
        null,
      )
    } finally {
      HTMLCanvasElement.prototype.getContext = originalGetContext
    }
  })

  it('closes the connection when unmounted', async () => {
    connectWhep.mockResolvedValue({ close: closeFn, pc: fakePc() })
    const { unmount } = render(<VideoTile src="http://test/cam/whep" />)
    await fireFirstFrame()
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
    await fireFirstFrame()
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

  // Status-truth fix (server-restart contradiction, 2026-07-07): the
  // old split — a red "Camera offline. Restart the camera service."
  // pill vs a yellow "Detection paused — worker offline" pill, picked
  // by whether the server had ever cached a frame counter — let the
  // red pill render WHILE `status === 'live'` (frames visibly
  // flowing), a live-caught contradiction. Both `workerAlive=false`
  // cases now collapse into ONE amber "Detection unavailable" pill
  // regardless of detector frame age; "Camera offline" copy is
  // reserved for the status==='error' overlay (video path itself
  // confirmed dead), tested separately below.

  it('Given worker_alive=false and no recent frame, When the tile is live, Then it shows Detection unavailable and explicitly preserves live-video truth', async () => {
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

    // assert — frames are confirmed flowing (status === 'live'), so
    // the pill must never claim the camera itself is offline.
    await fireFirstFrame()
    await waitFor(() => expect(screen.getByText('Live')).toBeInTheDocument())
    expect(screen.getByLabelText(/detection unavailable.*live video is still on/i)).toBeInTheDocument()
    expect(screen.queryByText(/camera offline/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/restart the camera service/i)).not.toBeInTheDocument()
  })

  it('Given worker_alive=false and a recent frame counter, When the tile is live, Then it shows the same Detection-unavailable pill', async () => {
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
        detectionFrameAgeSeconds={5}
      />,
    )

    // assert
    await fireFirstFrame()
    await waitFor(() => expect(screen.getByText('Live')).toBeInTheDocument())
    expect(screen.getByLabelText(/detection unavailable.*live video is still on/i)).toBeInTheDocument()
    expect(screen.queryByText(/camera offline/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/restart the camera service/i)).not.toBeInTheDocument()
  })

  it('Given worker_alive=false, When the tile is live, Then Detection unavailable takes precedence over the deliberate paused state', async () => {
    connectWhep.mockResolvedValue({ close: closeFn, pc: fakePc() })
    render(
      <VideoTile
        src="http://test/cam/whep"
        detectionActive={false}
        workerAlive={false}
      />,
    )
    await fireFirstFrame()
    await waitFor(() => expect(screen.getByText('Live')).toBeInTheDocument())
    expect(screen.getByLabelText(/detection unavailable/i)).toBeInTheDocument()
    expect(screen.queryByLabelText(/^detection paused$/i)).not.toBeInTheDocument()
  })

  it('treats workerAlive=null as "unknown" and does not flash OFFLINE', () => {
    connectWhep.mockResolvedValue({ close: closeFn, pc: fakePc() })
    render(<VideoTile src="http://test/cam/whep" workerAlive={null} />)
    expect(screen.queryByText(/camera offline/i)).not.toBeInTheDocument()
    expect(screen.queryByLabelText(/detection unavailable/i)).not.toBeInTheDocument()
  })

  // Detector freshness is independent from the visible WebRTC stream.

  it('given detector frames are stale while video is live, when rendered, then it reports detection delayed and preserves live-video truth', async () => {
    // arrange
    connectWhep.mockResolvedValue({ close: closeFn, pc: fakePc() })

    // act
    render(
      <VideoTile
        src="http://test/cam/whep"
        workerAlive={true}
        detectionFrameAgeSeconds={90}
      />,
    )

    // assert
    await fireFirstFrame()
    await waitFor(() => expect(screen.getByText('Live')).toBeInTheDocument())
    expect(screen.getByText(/detection delayed/i)).toBeInTheDocument()
    expect(screen.getByText(/live video is on/i)).toBeInTheDocument()
    expect(
      screen.getByLabelText(/detection feed stalled for 90 seconds.*live video is still on/i),
    ).toBeInTheDocument()
    expect(screen.queryByText(/stream stalled/i)).not.toBeInTheDocument()
  })

  it('given detector frames are within the freshness threshold, when rendered, then no detection-delay pill appears', async () => {
    // arrange
    connectWhep.mockResolvedValue({ close: closeFn, pc: fakePc() })

    // act
    render(
      <VideoTile
        src="http://test/cam/whep"
        workerAlive={true}
        detectionFrameAgeSeconds={30}
      />,
    )

    // assert — give the LIVE pill time to render so we know the
    // status branch is "live" (when stale would be eligible).
    await fireFirstFrame()
    await waitFor(() => expect(screen.getByText('Live')).toBeInTheDocument())
    expect(screen.queryByText(/detection delayed/i)).not.toBeInTheDocument()
  })

  it('given detector intake is stale while worker and video are live, then it never claims the camera is offline', async () => {
    connectWhep.mockResolvedValue({ close: closeFn, pc: fakePc() })

    // act
    render(
      <VideoTile
        src="http://test/cam/whep"
        workerAlive={true}
        detectionActive={true}
        detectionFrameAgeSeconds={120}
      />,
    )

    // assert
    await fireFirstFrame()
    await waitFor(() => expect(screen.getByText('Live')).toBeInTheDocument())
    expect(screen.getByText(/detection delayed/i)).toBeInTheDocument()
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
    await fireFirstFrame()
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
    await fireFirstFrame()
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
    await fireFirstFrame()
    await waitFor(() =>
      expect(
        screen.getByLabelText(/detection paused due to low memory/i),
      ).toBeInTheDocument(),
    )
    expect(screen.queryByText(/camera too hot/i)).not.toBeInTheDocument()
  })

  it('worker-dead Detection-unavailable pill takes precedence over LOW MEMORY', async () => {
    connectWhep.mockResolvedValue({ close: closeFn, pc: fakePc() })
    render(
      <VideoTile
        src="http://test/cam/whep"
        workerAlive={false}
        lowMemory={true}
      />,
    )
    await fireFirstFrame()
    await waitFor(() =>
      expect(screen.getByLabelText(/detection unavailable/i)).toBeInTheDocument(),
    )
    expect(screen.queryByText(/Low memory/i)).not.toBeInTheDocument()
  })

  it('Given a live stream, When the transport drops once while the tab is visible, Then one silent reconnect fires without showing the error overlay (resume-drop fix 2026-07-07)', async () => {
    // arrange — first episode reaches Live via real frames.
    const pc1 = fakePc()
    const pc2 = fakePc()
    connectWhep
      .mockResolvedValueOnce({ close: closeFn, pc: pc1 })
      .mockResolvedValueOnce({ close: closeFn, pc: pc2 })
    render(<VideoTile src="http://test/cam/whep" />)
    await fireFirstFrame()
    await waitFor(() => expect(screen.getByText('Live')).toBeInTheDocument())
    expect(connectWhep).toHaveBeenCalledTimes(1)

    // act — mid-stream drop (the backgrounded-tab kill shape).
    pc1.setState('failed')

    // assert — a second WHEP attempt fires silently: the tile shows
    // Connecting, never the Camera-offline overlay.
    await waitFor(() => expect(connectWhep).toHaveBeenCalledTimes(2))
    expect(screen.queryByText(/camera offline/i)).not.toBeInTheDocument()
    expect(screen.getByText(/connecting/i)).toBeInTheDocument()

    // act — frames flow on the new connection.
    await fireFirstFrame()

    // assert — back to Live with no user interaction.
    await waitFor(() => expect(screen.getByText('Live')).toBeInTheDocument())
  })

  it('flips to error when the peer connection fails again after the one silent reconnect (iter-162 + resume-drop fix)', async () => {
    // arrange — episode 1 goes live; its drop spends the silent retry.
    const pc1 = fakePc()
    const pc2 = fakePc()
    connectWhep
      .mockResolvedValueOnce({ close: closeFn, pc: pc1 })
      .mockResolvedValueOnce({ close: closeFn, pc: pc2 })
    render(<VideoTile src="http://test/cam/whep" />)
    await fireFirstFrame()
    await waitFor(() => expect(screen.getByText('Live')).toBeInTheDocument())

    // act — first drop consumes the silent retry; the retry's pc then
    // fails before any frame arrives (server really down).
    pc1.setState('failed')
    await waitFor(() => expect(connectWhep).toHaveBeenCalledTimes(2))
    pc2.setState('disconnected')

    // assert — now the manual-Retry error surface shows (compact
    // OfflineState heading + Retry button).
    await waitFor(() =>
      expect(screen.getByText(/camera offline/i)).toBeInTheDocument(),
    )
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument()
  })

  it('does NOT flip to error on benign mid-stream state changes (iter-162)', async () => {
    // 'new' / 'connecting' / 'connected' don't indicate failure — the WebRTC
    // spec allows these to transition during a healthy session. Only the
    // failure states (`failed`, `disconnected`, `closed`) should surface
    // the Camera-unreachable UI.
    const pc = fakePc()
    connectWhep.mockResolvedValue({ close: closeFn, pc })
    render(<VideoTile src="http://test/cam/whep" />)
    await fireFirstFrame()
    await waitFor(() => expect(screen.getByText('Live')).toBeInTheDocument())
    pc.setState('connected')
    expect(screen.getByText('Live')).toBeInTheDocument()
    expect(
      screen.queryByText(/check your connection or the camera/i),
    ).not.toBeInTheDocument()
  })

  it('Retry after mid-stream failure triggers a new WHEP connect (iter-162; failures 1+2 spend the silent reconnect first)', async () => {
    const pc1 = fakePc()
    const pc2 = fakePc()
    const pc3 = fakePc()
    connectWhep
      .mockResolvedValueOnce({ close: closeFn, pc: pc1 })
      .mockResolvedValueOnce({ close: closeFn, pc: pc2 })
      .mockResolvedValueOnce({ close: closeFn, pc: pc3 })
    render(<VideoTile src="http://test/cam/whep" />)
    await fireFirstFrame()
    await waitFor(() => expect(screen.getByText('Live')).toBeInTheDocument())
    expect(connectWhep).toHaveBeenCalledTimes(1)
    // First drop is absorbed by the one silent reconnect (attempt 2);
    // its pc failing too is what surfaces the manual Retry button.
    pc1.setState('failed')
    await waitFor(() => expect(connectWhep).toHaveBeenCalledTimes(2))
    pc2.setState('failed')
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument(),
    )
    fireEvent.click(screen.getByRole('button', { name: /retry/i }))
    await waitFor(() => expect(connectWhep).toHaveBeenCalledTimes(3))
    await fireFirstFrame()
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
    await fireFirstFrame()
    await waitFor(() => expect(screen.getByText('Live')).toBeInTheDocument())
    const video = screen.getByLabelText('Live camera feed')
    fireEvent.error(video)
    await waitFor(() =>
      // Premium-launch slice (Maya Critical #4): VideoTile error
      // overlay now uses the compact OfflineState variant ("Camera
      // offline" heading + "Power-cycle…" hint) instead of the full-
      // page body. Either visible string identifies the error
      // surface; we query the stable heading.
      expect(screen.getByText(/camera offline/i)).toBeInTheDocument(),
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
    await fireFirstFrame()
    await waitFor(() => expect(screen.getByText('Live')).toBeInTheDocument())
    vi.useFakeTimers()
    try {
      const video = screen.getByLabelText('Live camera feed')
      fireEvent.stalled(video)
      // Just under 3 s — should still be LIVE.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2900)
      })
      expect(screen.queryByText(/power-cycle the camera/i)).not.toBeInTheDocument()
      // Cross the threshold.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(200)
      })
      // Premium-launch slice (Maya Critical #4): compact variant.
      expect(screen.getByText(/camera offline/i)).toBeInTheDocument()
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
    await fireFirstFrame()
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
      expect(screen.queryByText(/power-cycle the camera/i)).not.toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('Given requestVideoFrameCallback exists, When a live stream stalls, Then VideoTile re-arms rVFC for frame-truth recovery (harness #5 W3)', async () => {
    const rvfc = installRvfcMock()
    try {
      connectWhep.mockResolvedValue({ close: closeFn, pc: fakePc() })
      render(<VideoTile src="http://test/cam/whep" />)
      await rvfc.fire(1)
      await waitFor(() => expect(screen.getByText('Live')).toBeInTheDocument())

      fireEvent.stalled(screen.getByLabelText('Live camera feed'))

      expect(rvfc.requestVideoFrameCallback).toHaveBeenCalledTimes(2)
    } finally {
      rvfc.restore()
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

  it('Given a fresh localStorage, When VideoTile mounts, Then a transient "Detection boxes" hint appears near the toggle (painfix wave B #2)', () => {
    // arrange
    window.localStorage.removeItem('homecam:bboxHintViews')
    connectWhep.mockResolvedValue({ close: closeFn, pc: fakePc() })

    // act
    render(<VideoTile src="http://test/cam/whep" />)

    // assert — first-ever mount shows the hint and records the view.
    expect(screen.getByTestId('bbox-hint')).toHaveTextContent('Detection boxes')
    expect(window.localStorage.getItem('homecam:bboxHintViews')).toBe('1')
  })

  it('Given the hint has already been shown twice, When VideoTile mounts again, Then the hint no longer renders (painfix wave B #2)', () => {
    // arrange
    window.localStorage.setItem('homecam:bboxHintViews', '2')
    connectWhep.mockResolvedValue({ close: closeFn, pc: fakePc() })

    // act
    render(<VideoTile src="http://test/cam/whep" />)

    // assert
    expect(screen.queryByTestId('bbox-hint')).not.toBeInTheDocument()
  })

  it('Given the hint is showing, When ~4s elapse, Then it auto-hides (painfix wave B #2)', async () => {
    // arrange
    vi.useFakeTimers()
    window.localStorage.removeItem('homecam:bboxHintViews')
    connectWhep.mockResolvedValue({ close: closeFn, pc: fakePc() })
    render(<VideoTile src="http://test/cam/whep" />)
    expect(screen.getByTestId('bbox-hint')).toBeInTheDocument()

    // act
    await act(async () => {
      vi.advanceTimersByTime(4001)
    })

    // assert
    expect(screen.queryByTestId('bbox-hint')).not.toBeInTheDocument()
    vi.useRealTimers()
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

  it('Given a standalone VideoTile, When rendered with defaults, Then the bbox toggle and the native fullscreen button are siblings inside one corner row (control-overlap fix)', () => {
    // arrange / act
    connectWhep.mockResolvedValue({ close: closeFn, pc: fakePc() })
    render(<VideoTile src="http://test/cam/whep" />)

    // assert — both live inside the same flex row container, so
    // there's exactly one owner of the docked corner (not two
    // independently-positioned absolute pieces that could overlap).
    const bboxToggle = screen.getByRole('button', { name: /detection boxes/i })
    const fullscreenBtn = screen.getByRole('button', { name: /enter fullscreen/i })
    expect(bboxToggle.parentElement).toBe(fullscreenBtn.parentElement)
  })

  it('Given a caller passes actions + showFullscreenButton=false, When rendered, Then the actions render inside the row and the native fullscreen button is omitted (control-overlap fix)', () => {
    // arrange / act
    connectWhep.mockResolvedValue({ close: closeFn, pc: fakePc() })
    render(
      <VideoTile
        src="http://test/cam/whep"
        showFullscreenButton={false}
        actions={
          <button type="button" aria-label="caller action">
            caller action
          </button>
        }
      />,
    )

    // assert
    const callerBtn = screen.getByRole('button', { name: 'caller action' })
    const bboxToggle = screen.getByRole('button', { name: /detection boxes/i })
    expect(callerBtn.parentElement).toBe(bboxToggle.parentElement)
    expect(
      screen.queryByRole('button', { name: /enter fullscreen|exit fullscreen/i }),
    ).not.toBeInTheDocument()
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
    await fireFirstFrame()
    await waitFor(() => expect(screen.getByText('Live')).toBeInTheDocument())

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

  // Cellular-adaptive streaming (2026-06-16): the tile owns a quality
  // picker. When no `src` override is given it composes its own WHEP
  // URL from the chosen quality via lib/streamQuality. Switching tiers
  // re-runs the WHEP connect against the new path (same mechanism as
  // manual Retry: a change in the effect's URL dep).

  it('given no src override, when rendered, then the quality control is reachable by accessible name (2026-06-16, updated fuzz F6: themed QualityMenu replaces the native select)', () => {
    // arrange
    window.localStorage.removeItem('homecam:streamQuality')
    connectWhep.mockReturnValue(new Promise(() => {}))

    // act
    render(<VideoTile detectionActive={null} />)

    // assert — labelled, role-discoverable trigger button, defaults to Auto.
    const control = screen.getByRole('button', { name: /stream quality/i })
    expect(control).toBeInTheDocument()
    expect(control).toHaveTextContent('Auto')
  })

  it('given the default Auto tier, when rendered, then connectWhep targets the HQ path (2026-06-16)', () => {
    // arrange — jsdom has no navigator.connection, so Auto resolves HQ.
    window.localStorage.removeItem('homecam:streamQuality')
    connectWhep.mockReturnValue(new Promise(() => {}))

    // act
    render(<VideoTile detectionActive={null} />)

    // assert
    expect(connectWhep).toHaveBeenCalledWith(
      `${window.location.origin}/whep/cam/whep`,
      expect.any(Object),
      expect.any(Object),
    )
  })

  it('given the quality control, when Data-saver is picked from the themed listbox, then the WHEP URL swaps and persists (2026-06-16, updated fuzz F6)', async () => {
    // arrange
    window.localStorage.removeItem('homecam:streamQuality')
    connectWhep.mockReturnValue(new Promise(() => {}))
    render(<VideoTile detectionActive={null} />)
    expect(connectWhep).toHaveBeenCalledTimes(1)
    expect(connectWhep).toHaveBeenLastCalledWith(
      `${window.location.origin}/whep/cam/whep`,
      expect.any(Object),
      expect.any(Object),
    )

    // act — open the popover, pick Data-saver (sd -> cam_lq).
    fireEvent.click(screen.getByRole('button', { name: /stream quality/i }))
    fireEvent.click(screen.getByRole('option', { name: /data-saver/i }))

    // assert — connect re-runs against the new path; choice persisted.
    await waitFor(() =>
      expect(connectWhep).toHaveBeenLastCalledWith(
        `${window.location.origin}/whep/cam_lq/whep`,
        expect.any(Object),
        expect.any(Object),
      ),
    )
    expect(window.localStorage.getItem('homecam:streamQuality')).toBe('sd')
  })

  it('given a persisted Ultra-low choice, when the tile mounts, then it connects to the ultra-low path (2026-06-16, updated fuzz F6)', () => {
    // arrange
    window.localStorage.setItem('homecam:streamQuality', 'xs')
    connectWhep.mockReturnValue(new Promise(() => {}))

    // act
    render(<VideoTile detectionActive={null} />)

    // assert
    expect(connectWhep).toHaveBeenCalledWith(
      `${window.location.origin}/whep/cam_uq/whep`,
      expect.any(Object),
      expect.any(Object),
    )
    expect(
      screen.getByRole('button', { name: /stream quality/i }),
    ).toHaveTextContent('Ultra-low')
    window.localStorage.removeItem('homecam:streamQuality')
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

  it('Given the pill cluster needs to announce status transitions, When VideoTile renders, Then the role="status" wrapper is a real positioned div (NOT className="contents") so iOS VoiceOver and NVDA + Chrome on Android receive the live-region updates (premium-launch slice — Dana #3 critical)', async () => {
    // arrange — Dana #3 critical: pre-fix the wrapper carried
    // `className="contents"` which strips the element from the box
    // tree. WebKit + Blink both treat `display: contents` elements
    // as if they had no role for accessibility — the live-region
    // announcement was dropped on iOS VoiceOver and on NVDA +
    // Chrome on Android, leaving SR users without any signal that
    // the camera flipped from live → "Camera offline."
    connectWhep.mockResolvedValue({ close: closeFn, pc: fakePc() })

    // act
    render(<VideoTile src="http://test/cam/whep" workerAlive={true} />)
    await fireFirstFrame()
    await waitFor(() => expect(screen.getByText('Live')).toBeInTheDocument())

    // assert — the role="status" element is the (single) one inside
    // VideoTile that drives pill-cluster announcements. Its
    // className must NOT carry `contents`; it must be a positioned
    // div with pointer-events:none so video clicks pass through.
    const statuses = screen.getAllByRole('status')
    const pillRegion = statuses.find(
      (el) => el.className.includes('absolute') && el.className.includes('top-3'),
    )
    expect(pillRegion).toBeDefined()
    expect(pillRegion!.className).not.toMatch(/\bcontents\b/)
    expect(pillRegion!.className).toMatch(/pointer-events-none/)
  })

  it('Given the camera is unreachable, When the error overlay renders, Then it uses the compact OfflineState variant (premium-launch slice — Maya Critical #4)', async () => {
    // arrange — Maya Critical #4: pre-fix the full-page OfflineState
    // overflowed inside a 16:9 video tile. The compact variant
    // shows a tight actionable hint instead of the multi-line
    // full-page body.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    connectWhep.mockRejectedValue(new Error('boom'))

    // act
    render(<VideoTile src="http://test/cam/whep" />)

    // assert — the compact body ("Check your connection or the
    // camera, then tap Retry.") is present; the full-size body
    // ("powered on and connected") is NOT.
    await waitFor(() =>
      expect(
        screen.getByText(/check your connection or the camera/i),
      ).toBeInTheDocument(),
    )
    expect(
      screen.queryByText(/powered on and connected/i),
    ).not.toBeInTheDocument()

    errorSpy.mockRestore()
  })

  it('Given detector intake goes stale, When the pill renders, Then a detection-stale severity glyph reinforces the warning', async () => {
    // arrange — Dana #2 partial-sight redundancy: each precedence-
    // ladder pill carries a distinctive glyph in addition to the
    // colored dot so tritan-deficient + low-vision users have a
    // redundant signal channel.
    connectWhep.mockResolvedValue({ close: closeFn, pc: fakePc() })

    // act
    render(
      <VideoTile
        src="http://test/cam/whep"
        workerAlive={true}
        detectionFrameAgeSeconds={120}
      />,
    )

    // assert — the kind-specific glyph is rendered, aria-hidden so
    // it's pure visual reinforcement (the parent pill's aria-label
    // carries the accessible meaning).
    await fireFirstFrame()
    await waitFor(() =>
      expect(screen.getByTestId('pill-icon-detection-stale')).toBeInTheDocument(),
    )
    expect(screen.getByTestId('pill-icon-detection-stale')).toHaveAttribute(
      'aria-hidden',
      'true',
    )
  })

  it('Given the worker died with no recent frames, When the tile is live, Then the worker-offline severity glyph is present, NOT the camera-offline glyph (status-truth fix, Dana #2)', async () => {
    // arrange / act
    connectWhep.mockResolvedValue({ close: closeFn, pc: fakePc() })
    render(<VideoTile src="http://test/cam/whep" workerAlive={false} />)

    // assert — frames are confirmed flowing; must never render the
    // camera-offline glyph while status === 'live'.
    await fireFirstFrame()
    await waitFor(() =>
      expect(screen.getByTestId('pill-icon-worker-offline')).toBeInTheDocument(),
    )
    expect(screen.queryByTestId('pill-icon-camera-offline')).not.toBeInTheDocument()
  })

  it('Given the worker has died but the stream is fine, When the worker-offline pill renders, Then a worker-offline severity glyph is present (Dana #2)', async () => {
    // arrange — workerAlive=false + recent detector frame age present
    // frame counter cached server-side) — same merged Detection-paused
    // pill as the no-frame-counter case above (status-truth fix).
    connectWhep.mockResolvedValue({ close: closeFn, pc: fakePc() })

    // act
    render(
      <VideoTile
        src="http://test/cam/whep"
        workerAlive={false}
        detectionFrameAgeSeconds={20}
      />,
    )

    // assert
    await fireFirstFrame()
    await waitFor(() =>
      expect(screen.getByTestId('pill-icon-worker-offline')).toBeInTheDocument(),
    )
  })

  it('Given memory pressure, When the low-memory pill renders, Then a memory-chip severity glyph is present (Dana #2)', async () => {
    // arrange / act
    connectWhep.mockResolvedValue({ close: closeFn, pc: fakePc() })
    render(<VideoTile src="http://test/cam/whep" workerAlive={true} lowMemory={true} />)

    // assert
    await fireFirstFrame()
    await waitFor(() =>
      expect(screen.getByTestId('pill-icon-low-memory')).toBeInTheDocument(),
    )
  })

  it('Given thermal throttle, When the thermal pill renders, Then a thermometer severity glyph is present (Dana #2)', async () => {
    // arrange / act
    connectWhep.mockResolvedValue({ close: closeFn, pc: fakePc() })
    render(<VideoTile src="http://test/cam/whep" workerAlive={true} thermal={true} />)

    // assert
    await fireFirstFrame()
    await waitFor(() =>
      expect(screen.getByTestId('pill-icon-thermal')).toBeInTheDocument(),
    )
  })

  it('Given detection is deliberately paused, When the paused pill renders, Then a pause-bars severity glyph is present (Dana #2 — distinct from the slashed-glyph failure pills so users can tell deliberate-pause from system-failure at a glance)', async () => {
    // arrange / act
    connectWhep.mockResolvedValue({ close: closeFn, pc: fakePc() })
    render(<VideoTile src="http://test/cam/whep" workerAlive={true} detectionActive={false} />)

    // assert
    await fireFirstFrame()
    await waitFor(() =>
      expect(screen.getByTestId('pill-icon-paused')).toBeInTheDocument(),
    )
  })

  // WebRTC lifecycle audit — defect 1: unmount/rung-change mid-fetch leaked
  // the in-flight RTCPeerConnection because cleanup had nothing to close
  // (`conn` was still null). VideoTile now passes an AbortController signal
  // into connectWhep and aborts it in cleanup.

  it('given a WHEP connect is still in flight, when the tile unmounts, then connectWhep receives an AbortSignal that is aborted on cleanup (defect 1)', () => {
    // arrange — never-resolving connectWhep so unmount races the in-flight
    // attempt exactly like a hung POST would.
    connectWhep.mockReturnValue(new Promise(() => {}))

    // act
    const { unmount } = render(<VideoTile src="http://test/cam/whep" />)
    const [, , opts] = connectWhep.mock.calls[0] as [
      string,
      unknown,
      { signal?: AbortSignal },
    ]
    expect(opts?.signal).toBeInstanceOf(AbortSignal)
    expect(opts!.signal!.aborted).toBe(false)
    unmount()

    // assert — cleanup aborted the signal connectWhep was given, so the
    // library-level fetch(signal) can now reject and close the leaked pc.
    expect(opts!.signal!.aborted).toBe(true)
  })

  it('given a rung change fires mid-connect, when the previous attempt is superseded, then its AbortSignal is aborted before the new attempt starts (defect 1 — no stacked concurrent sessions)', () => {
    // arrange
    let firstSignal: AbortSignal | undefined
    let firstSignalWasAbortedWhenSecondAttemptStarted = false
    connectWhep.mockImplementation((_url: string, _video: unknown, opts?: { signal?: AbortSignal }) => {
      if (connectWhep.mock.calls.length === 1) {
        firstSignal = opts?.signal
      } else if (connectWhep.mock.calls.length === 2) {
        firstSignalWasAbortedWhenSecondAttemptStarted = firstSignal?.aborted === true
      }
      return new Promise(() => {})
    })
    window.localStorage.removeItem('homecam:streamQuality')

    // act — mount, then switch quality (re-runs the connect effect on the
    // new `effectiveSrc`, tearing down the first attempt).
    render(<VideoTile detectionActive={null} />)
    const [, , firstOpts] = connectWhep.mock.calls[0] as [
      string,
      unknown,
      { signal?: AbortSignal },
    ]
    fireEvent.click(screen.getByRole('button', { name: /stream quality/i }))
    fireEvent.click(screen.getByRole('option', { name: /data-saver/i }))

    // assert — the FIRST attempt's signal is already aborted by the time the
    // second (rung-change) attempt starts, matching the real Chromium harness:
    // no replacement POST may overlap a still-open hung POST.
    expect(firstOpts!.signal!.aborted).toBe(true)
    expect(firstSignalWasAbortedWhenSecondAttemptStarted).toBe(true)
  })

  it('given the tile unmounts while connecting, when the aborted connectWhep promise later rejects, then no error is logged and status is not flipped (deliberate teardown, not a failure)', async () => {
    // arrange
    let rejectConn!: (e: unknown) => void
    connectWhep.mockReturnValue(
      new Promise((_res, rej) => {
        rejectConn = rej
      }),
    )
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    // act
    const { unmount } = render(<VideoTile src="http://test/cam/whep" />)
    unmount()
    await act(async () => {
      rejectConn(new DOMException('Aborted', 'AbortError'))
      await Promise.resolve()
    })

    // assert — no console.error from an unhandled/logged rejection path.
    expect(errorSpy).not.toHaveBeenCalled()
    errorSpy.mockRestore()
  })

  it('given detection intake is stale while WebRTC is live, then it offers no misleading video reconnect action', async () => {
    // arrange
    connectWhep.mockResolvedValue({ close: closeFn, pc: fakePc() })
    render(
      <VideoTile
        src="http://test/cam/whep"
        workerAlive={true}
        detectionFrameAgeSeconds={90}
      />,
    )
    await fireFirstFrame()
    await waitFor(() => expect(screen.getByText(/detection delayed/i)).toBeInTheDocument())
    expect(connectWhep).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('button', { name: /reconnect/i })).not.toBeInTheDocument()
    expect(connectWhep).toHaveBeenCalledTimes(1)
  })

  // WebRTC lifecycle audit — defect 4: mobile resume can fire
  // `visibilitychange` AND `online` in the same turn while status is
  // 'error', double-bumping retryNonce. Both signals now coalesce through
  // one guarded requestReconnect().

  it('given status is error, when visibilitychange and online fire simultaneously, then only one new connectWhep attempt is triggered (defect 4)', async () => {
    // arrange
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    connectWhep.mockRejectedValueOnce(new Error('boom'))
    connectWhep.mockReturnValue(new Promise(() => {}))
    render(<VideoTile src="http://test/cam/whep" />)
    await waitFor(() =>
      expect(screen.getAllByText(/Offline/i)[0]).toBeInTheDocument(),
    )
    expect(connectWhep).toHaveBeenCalledTimes(1)

    // act — both resume signals fire back-to-back, before React re-renders
    // in response to either (the exact race that used to double-fire).
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    })
    document.dispatchEvent(new Event('visibilitychange'))
    window.dispatchEvent(new Event('online'))

    // assert — coalesced into exactly one new attempt.
    await waitFor(() => expect(connectWhep).toHaveBeenCalledTimes(2))
    await new Promise((r) => setTimeout(r, 20))
    expect(connectWhep).toHaveBeenCalledTimes(2)
    errorSpy.mockRestore()
  })
})
