import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  _resetWhepWarmupForTests,
  connectWhep,
  warmWhepConnection,
} from './webrtc'

type Listener = () => void

class MockRTCPeerConnection {
  static instances: MockRTCPeerConnection[] = []

  iceGatheringState: 'new' | 'gathering' | 'complete' = 'new'
  localDescription: { sdp: string; type: 'offer' | 'answer' } | null = null
  remoteDescription: { sdp: string; type: 'offer' | 'answer' } | null = null
  receivers: Array<{ track: { stop: () => void } }> = []
  ontrack: ((e: { streams: MediaStream[] }) => void) | null = null
  closed = false
  addTransceiver = vi.fn()

  private listeners: Record<string, Listener[]> = {}

  constructor(public config?: RTCConfiguration) {
    MockRTCPeerConnection.instances.push(this)
  }

  addEventListener(t: string, cb: Listener) {
    ;(this.listeners[t] ??= []).push(cb)
  }
  removeEventListener(t: string, cb: Listener) {
    this.listeners[t] = (this.listeners[t] ?? []).filter((f) => f !== cb)
  }
  async createOffer() {
    return { sdp: 'OFFER_SDP', type: 'offer' as const }
  }
  async setLocalDescription(d: { sdp: string; type: 'offer' | 'answer' }) {
    this.localDescription = d
    queueMicrotask(() => {
      this.iceGatheringState = 'complete'
      ;(this.listeners['icegatheringstatechange'] ?? []).forEach((f) => f())
    })
  }
  async setRemoteDescription(d: { sdp: string; type: 'offer' | 'answer' }) {
    this.remoteDescription = d
  }
  getReceivers() {
    return this.receivers
  }
  close() {
    this.closed = true
  }
}

function makeVideo(): HTMLVideoElement {
  return { srcObject: null } as unknown as HTMLVideoElement
}

describe('lib/webrtc.connectWhep', () => {
  beforeEach(() => {
    MockRTCPeerConnection.instances = []
    vi.stubGlobal('RTCPeerConnection', MockRTCPeerConnection as unknown as typeof RTCPeerConnection)
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('ANSWER_SDP', { status: 200 })),
    )
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('creates a peer connection and adds a recvonly video transceiver only', async () => {
    await connectWhep('http://example/cam/whep', makeVideo())
    const pc = MockRTCPeerConnection.instances[0]
    expect(pc.addTransceiver).toHaveBeenCalledWith('video', { direction: 'recvonly' })
    expect(pc.addTransceiver).toHaveBeenCalledTimes(1)
  })

  it('uses no ICE servers (LAN-only deployment)', async () => {
    await connectWhep('http://example/cam/whep', makeVideo())
    const pc = MockRTCPeerConnection.instances[0]
    expect(pc.config?.iceServers).toEqual([])
  })

  it('POSTs the local SDP to the WHEP URL with application/sdp', async () => {
    await connectWhep('http://example/cam/whep', makeVideo())
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://example/cam/whep',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/sdp' },
        body: 'OFFER_SDP',
      }),
    )
  })

  it('applies the WHEP answer as the remote description', async () => {
    await connectWhep('http://example/cam/whep', makeVideo())
    const pc = MockRTCPeerConnection.instances[0]
    expect(pc.remoteDescription).toEqual({ type: 'answer', sdp: 'ANSWER_SDP' })
  })

  it('attaches the inbound stream to the video element via ontrack', async () => {
    const video = makeVideo()
    await connectWhep('http://example/cam/whep', video)
    const pc = MockRTCPeerConnection.instances[0]
    const stream = { id: 'inbound' } as unknown as MediaStream
    pc.ontrack?.({ streams: [stream] })
    expect(video.srcObject).toBe(stream)
  })

  it('throws and closes the peer when WHEP returns non-2xx', async () => {
    ;(globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response('boom', { status: 500 }),
    )
    await expect(connectWhep('http://example/cam/whep', makeVideo())).rejects.toThrow(/WHEP 500/)
    const pc = MockRTCPeerConnection.instances[0]
    expect(pc.closed).toBe(true)
  })

  it('close() stops receivers and closes the peer', async () => {
    const stop = vi.fn()
    const conn = await connectWhep('http://example/cam/whep', makeVideo())
    const pc = MockRTCPeerConnection.instances[0]
    pc.receivers = [{ track: { stop } }]
    conn.close()
    expect(stop).toHaveBeenCalled()
    expect(pc.closed).toBe(true)
  })
})

describe('lib/webrtc.warmWhepConnection', () => {
  beforeEach(() => {
    MockRTCPeerConnection.instances = []
    vi.stubGlobal('RTCPeerConnection', MockRTCPeerConnection as unknown as typeof RTCPeerConnection)
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('ANSWER_SDP', { status: 200 })),
    )
    _resetWhepWarmupForTests()
  })
  afterEach(() => {
    _resetWhepWarmupForTests()
    vi.unstubAllGlobals()
  })

  it('Given warmup runs, When the peer connection is created, Then iceServers stays [] and the only transceiver is recvonly video (auth-boundary safety: no STUN/TURN, no audio)', async () => {
    // arrange / act
    await warmWhepConnection()

    // assert — pre-warm PC is configured identically to the cold-
    // path PC so the warm-vs-cold consume produces no behavior
    // difference. iceServers: [] is the project's "no STUN ever"
    // sharp edge — pinned across both code paths.
    const pc = MockRTCPeerConnection.instances[0]
    expect(pc.config?.iceServers).toEqual([])
    expect(pc.addTransceiver).toHaveBeenCalledWith('video', { direction: 'recvonly' })
    expect(pc.addTransceiver).toHaveBeenCalledTimes(1)
  })

  it('Given warmup completes, When connectWhep runs, Then no second peer connection is created (the warmed PC is reused)', async () => {
    // arrange
    await warmWhepConnection()
    expect(MockRTCPeerConnection.instances.length).toBe(1)

    // act
    await connectWhep('http://example/cam/whep', makeVideo())

    // assert — the consume reused the warmed PC; only one PC exists.
    expect(MockRTCPeerConnection.instances.length).toBe(1)
    const pc = MockRTCPeerConnection.instances[0]
    expect(pc.localDescription).toEqual({ type: 'offer', sdp: 'OFFER_SDP' })
    expect(pc.remoteDescription).toEqual({ type: 'answer', sdp: 'ANSWER_SDP' })
  })

  it('Given warmup did NOT run, When connectWhep runs cold, Then it creates a fresh PC and behaves identically to before warmup existed (no regression)', async () => {
    // arrange — no warmup call

    // act
    await connectWhep('http://example/cam/whep', makeVideo())

    // assert — same observable contract as the legacy path.
    expect(MockRTCPeerConnection.instances.length).toBe(1)
    const pc = MockRTCPeerConnection.instances[0]
    expect(pc.config?.iceServers).toEqual([])
    expect(pc.localDescription).toEqual({ type: 'offer', sdp: 'OFFER_SDP' })
    expect(pc.remoteDescription).toEqual({ type: 'answer', sdp: 'ANSWER_SDP' })
  })

  it('Given warmup runs twice in quick succession, When the second call lands, Then it is a no-op — only one PC exists in cache (StrictMode dev double-mount safety)', async () => {
    // arrange / act
    await warmWhepConnection()
    await warmWhepConnection()

    // assert — only the first warmup's PC exists; the second was a
    // no-op because the cache was already populated.
    expect(MockRTCPeerConnection.instances.length).toBe(1)
  })

  it('Given a warmed PC sat unused past the TTL, When connectWhep claims, Then the stale PC is discarded and a fresh one is created (TTL safety)', async () => {
    // arrange — warm, then advance the clock past WARM_TTL_MS.
    vi.useFakeTimers()
    try {
      await warmWhepConnection()
      const stalePc = MockRTCPeerConnection.instances[0]
      expect(stalePc.closed).toBe(false)

      // Advance past 30 s TTL.
      vi.advanceTimersByTime(31_000)

      // act
      await connectWhep('http://example/cam/whep', makeVideo())

      // assert — stale PC was closed; a fresh one was created.
      expect(stalePc.closed).toBe(true)
      expect(MockRTCPeerConnection.instances.length).toBe(2)
      const fresh = MockRTCPeerConnection.instances[1]
      expect(fresh.remoteDescription).toEqual({ type: 'answer', sdp: 'ANSWER_SDP' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('Given the network goes offline after warmup, When the offline event fires, Then the warmed PC is closed and the cache is cleared (host-candidate freshness)', async () => {
    // arrange
    await warmWhepConnection()
    const warmedPc = MockRTCPeerConnection.instances[0]
    expect(warmedPc.closed).toBe(false)

    // act — offline event invalidates the cache.
    window.dispatchEvent(new Event('offline'))

    // assert — warmed PC was closed; next connectWhep creates a fresh one.
    expect(warmedPc.closed).toBe(true)
    await connectWhep('http://example/cam/whep', makeVideo())
    expect(MockRTCPeerConnection.instances.length).toBe(2)
  })

  it('Given warmup is called, When the work runs, Then no fetch hits the WHEP endpoint (warmup must NEVER touch /whep/* — that is auth-protected)', async () => {
    // arrange / act — Auth-boundary safety. The whole point of
    // warmup is that it stays local; if a regression introduced a
    // pre-auth /whep/* call it would either 401 against the user's
    // unsigned cookie or (worse) leak a video stream.
    await warmWhepConnection()

    // assert — fetch was never called during warmup.
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('Given warmup is called, When the work runs, Then no MediaStream is bound to a video element (the user has not chosen one yet)', async () => {
    // arrange / act
    await warmWhepConnection()

    // assert — pc.ontrack is NOT set during warmup. Setting it
    // would risk binding to a stale video element if the page
    // later remounted before consume.
    const pc = MockRTCPeerConnection.instances[0]
    expect(pc.ontrack).toBeNull()
  })

  it('Given the consume video element binds via ontrack, When the warmed PC is reused, Then the inbound stream lands on the consumer-supplied video element (warmup-cold-consume seam)', async () => {
    // arrange — warm, then consume with a specific video element.
    await warmWhepConnection()
    const video = makeVideo()

    // act
    await connectWhep('http://example/cam/whep', video)
    const pc = MockRTCPeerConnection.instances[0]
    const stream = { id: 'inbound' } as unknown as MediaStream
    pc.ontrack?.({ streams: [stream] })

    // assert — the ontrack handler attached at consume time bound
    // the stream to the right element.
    expect(video.srcObject).toBe(stream)
  })
})
