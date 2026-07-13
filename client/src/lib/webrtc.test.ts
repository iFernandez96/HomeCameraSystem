import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { log } from './log'

const { getMediaTokenM } = vi.hoisted(() => ({
  getMediaTokenM: vi.fn(),
}))

vi.mock('./api', () => ({
  getMediaToken: (...args: unknown[]) => getMediaTokenM(...args),
}))

import {
  _resetWhepAttemptLedgerForTests,
  _resetWhepWarmupForTests,
  connectWhep,
  getWhepAttemptLedger,
  summarizeCandidates,
  warmWhepConnection,
} from './webrtc'

type Listener = () => void

class MockRTCPeerConnection {
  static instances: MockRTCPeerConnection[] = []

  iceGatheringState: 'new' | 'gathering' | 'complete' = 'new'
  connectionState: RTCPeerConnectionState = 'new'
  iceConnectionState: RTCIceConnectionState = 'new'
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
  dispatchEventType(t: string) {
    ;(this.listeners[t] ?? []).forEach((f) => f())
  }
  async createOffer() {
    return { sdp: 'OFFER_SDP', type: 'offer' as const }
  }
  async setLocalDescription(d: { sdp: string; type: 'offer' | 'answer' }) {
    this.localDescription = d
    queueMicrotask(() => {
      this.iceGatheringState = 'complete'
      this.dispatchEventType('icegatheringstatechange')
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
    this.connectionState = 'closed'
  }
}

function makeVideo(): HTMLVideoElement {
  return { srcObject: null } as unknown as HTMLVideoElement
}

describe('lib/webrtc.connectWhep', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getMediaTokenM.mockResolvedValue({
      token: 'fresh-video-grant',
      expires_ts: 2000,
    })
    MockRTCPeerConnection.instances = []
    _resetWhepAttemptLedgerForTests()
    vi.stubGlobal('RTCPeerConnection', MockRTCPeerConnection as unknown as typeof RTCPeerConnection)
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('ANSWER_SDP', { status: 200 })),
    )
  })
  afterEach(() => {
    _resetWhepAttemptLedgerForTests()
    vi.unstubAllGlobals()
  })

  it('creates a peer connection and adds a recvonly video transceiver only', async () => {
    await connectWhep('http://example/cam/whep', makeVideo())
    const pc = MockRTCPeerConnection.instances[0]
    expect(pc.addTransceiver).toHaveBeenCalledWith('video', { direction: 'recvonly' })
    expect(pc.addTransceiver).toHaveBeenCalledTimes(1)
  })

  it('Given a cellular client needs NAT traversal, When connectWhep builds the peer connection, Then it configures a STUN server (iter cellular-ice)', async () => {
    // arrange / act
    await connectWhep('http://example/cam/whep', makeVideo())
    // assert — STUN is required for cellular: the in-browser media socket
    // can't ride the Tailscale tunnel, so both peers need a server-reflexive
    // candidate to hole-punch. (Was `[]` pre-iter-cellular-ice.)
    const pc = MockRTCPeerConnection.instances[0]
    const urls = (pc.config?.iceServers ?? []).map((s) => s.urls)
    expect(urls).toContain('stun:stun.l.google.com:19302')
  })

  it('requests a path-scoped grant and POSTs the local SDP with bearer authorization', async () => {
    await connectWhep('http://example/cam/whep', makeVideo())
    expect(getMediaTokenM).toHaveBeenCalledWith('read', 'cam')
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://example/cam/whep',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'application/sdp',
          Authorization: 'Bearer fresh-video-grant',
        },
        body: 'OFFER_SDP',
      }),
    )
  })

  it('derives the exact registered rung from a same-origin proxy URL', async () => {
    await connectWhep('/whep/cam_uhq/whep', makeVideo())
    expect(getMediaTokenM).toHaveBeenCalledWith('read', 'cam_uhq')
  })

  it('obtains a fresh one-use grant for every reconnect attempt', async () => {
    getMediaTokenM
      .mockResolvedValueOnce({ token: 'video-grant-one', expires_ts: 2000 })
      .mockResolvedValueOnce({ token: 'video-grant-two', expires_ts: 2001 })
    ;(globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      () => Promise.resolve(new Response('ANSWER_SDP', { status: 200 })),
    )

    await connectWhep('http://example/cam_lq/whep', makeVideo())
    await connectWhep('http://example/cam_lq/whep', makeVideo())

    expect(getMediaTokenM).toHaveBeenCalledTimes(2)
    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      1,
      'http://example/cam_lq/whep',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer video-grant-one',
        }),
      }),
    )
    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      2,
      'http://example/cam_lq/whep',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer video-grant-two',
        }),
      }),
    )
  })

  it('keeps the raw grant out of URLs, browser storage, telemetry, and the WHEP ledger', async () => {
    const rawGrant = 'raw-video-grant-must-stay-transient'
    getMediaTokenM.mockResolvedValueOnce({ token: rawGrant, expires_ts: 2000 })
    const storageSpy = vi.spyOn(Storage.prototype, 'setItem')
    const infoSpy = vi.spyOn(log, 'info').mockImplementation(() => {})
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {})
    const errorSpy = vi.spyOn(log, 'error').mockImplementation(() => {})

    await connectWhep('https://homecam.test/whep/cam/whep', makeVideo())
    const pc = MockRTCPeerConnection.instances[0]
    pc.ontrack?.({ streams: [{ id: 'inbound' } as unknown as MediaStream] })
    pc.connectionState = 'connected'
    pc.dispatchEventType('connectionstatechange')

    const [whepUrl] = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
    const nonTransportEvidence = JSON.stringify({
      url: whepUrl,
      ledger: getWhepAttemptLedger(),
      logs: [infoSpy.mock.calls, warnSpy.mock.calls, errorSpy.mock.calls],
    })
    expect(nonTransportEvidence).not.toContain(rawGrant)
    expect(storageSpy).not.toHaveBeenCalled()
    expect(window.localStorage.getItem(rawGrant)).toBeNull()
    expect(window.sessionStorage.getItem(rawGrant)).toBeNull()

    storageSpy.mockRestore()
    infoSpy.mockRestore()
    warnSpy.mockRestore()
    errorSpy.mockRestore()
  })

  it('fails closed before WHEP and closes the peer when grant issuance fails', async () => {
    getMediaTokenM.mockRejectedValueOnce(new Error('grant unavailable'))

    await expect(
      connectWhep('http://example/cam_uq/whep', makeVideo()),
    ).rejects.toThrow('grant unavailable')

    expect(globalThis.fetch).not.toHaveBeenCalled()
    expect(MockRTCPeerConnection.instances[0].closed).toBe(true)
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

  it('Given close() runs before connectionState reaches connected, When the ledger is read, Then the attempt settles as aborted', async () => {
    const conn = await connectWhep('http://example/cam/whep', makeVideo())
    const pc = MockRTCPeerConnection.instances[0]
    pc.ontrack?.({ streams: [{ id: 'inbound' } as unknown as MediaStream] })

    conn.close()

    const ledger = getWhepAttemptLedger()
    expect(ledger).toHaveLength(1)
    expect(ledger[0]).toEqual(
      expect.objectContaining({
        attemptId: 1,
        rungPath: '/cam/whep',
        outcome: 'aborted',
        msToFirstTrack: expect.any(Number),
      }),
    )
  })

  it('Given the WHEP POST rejects at the network layer, When connectWhep runs, Then the peer connection is closed (no PC leak) and the failure is logged', async () => {
    // arrange — fetch rejects (offline / MediaMTX unreachable). Before the
    // try/finally fix, pc.close() ran only in the `!res.ok` branch, so a
    // network reject returned with the PC + its ICE agent still open.
    const errSpy = vi.spyOn(log, 'error').mockImplementation(() => {})
    ;(globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
      new TypeError('Failed to fetch'),
    )

    // act
    await expect(
      connectWhep('http://example/cam/whep', makeVideo()),
    ).rejects.toThrow(/Failed to fetch/)

    // assert — regression guard for the leak fix + the express-reason log.
    const pc = MockRTCPeerConnection.instances[0]
    expect(pc.closed).toBe(true)
    expect(errSpy).toHaveBeenCalledWith(
      'webrtc:whep-network-fail',
      expect.objectContaining({ url: 'http://example/cam/whep' }),
    )
    errSpy.mockRestore()
  })

  it('Given WHEP returns non-2xx, When connectWhep runs, Then the peer is closed AND an ERROR carries the status (no leak on the HTTP-error path either)', async () => {
    // arrange
    const errSpy = vi.spyOn(log, 'error').mockImplementation(() => {})
    ;(globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response('no such path', { status: 404 }),
    )

    // act
    await expect(
      connectWhep('http://example/cam/whep', makeVideo()),
    ).rejects.toThrow(/WHEP 404/)

    // assert
    const pc = MockRTCPeerConnection.instances[0]
    expect(pc.closed).toBe(true)
    expect(errSpy).toHaveBeenCalledWith(
      'webrtc:whep-failed',
      expect.objectContaining({ status: 404 }),
    )
    errSpy.mockRestore()
  })

  // Defect-1/2 fixes (WebRTC lifecycle audit): abort-mid-fetch pc leak +
  // stale-ontrack race.

  it('Given a caller-supplied AbortSignal is already aborted, When connectWhep runs, Then it closes the pc and rejects with an AbortError WITHOUT touching the network (defect 1)', async () => {
    // arrange
    const controller = new AbortController()
    controller.abort()

    // act / assert
    await expect(
      connectWhep('http://example/cam/whep', makeVideo(), {
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(globalThis.fetch).not.toHaveBeenCalled()
    const pc = MockRTCPeerConnection.instances[0]
    expect(pc.closed).toBe(true)
  })

  it('Given a WHEP attempt receives its first track then the PC connects, When the ledger is read, Then the attempt is settled as connected with machine-diffable timing fields (W13/W14)', async () => {
    // arrange
    const infoSpy = vi.spyOn(log, 'info').mockImplementation(() => {})
    const video = makeVideo()

    // act
    await connectWhep('http://192.168.1.10:8889/cam/whep?diagnostic=redacted', video)
    expect(getWhepAttemptLedger()[0]).toEqual(
      expect.objectContaining({
        attemptId: 1,
        rungPath: '/cam/whep',
        startedAt: expect.any(Number),
      }),
    )
    expect(getWhepAttemptLedger()[0].outcome).toBeUndefined()
    const pc = MockRTCPeerConnection.instances[0]
    pc.ontrack?.({ streams: [{ id: 'inbound' } as unknown as MediaStream] })
    expect(getWhepAttemptLedger()[0].outcome).toBeUndefined()
    pc.connectionState = 'connected'
    pc.dispatchEventType('connectionstatechange')

    // assert
    const ledger = getWhepAttemptLedger()
    expect(ledger).toHaveLength(1)
    expect(ledger[0]).toEqual(
      expect.objectContaining({
        attemptId: 1,
        rungPath: '/cam/whep',
        outcome: 'connected',
      }),
    )
    expect(ledger[0].settledAt).toBeGreaterThanOrEqual(ledger[0].startedAt)
    expect(ledger[0].msToFirstTrack).toBeGreaterThanOrEqual(0)
    expect(infoSpy).toHaveBeenCalledTimes(1)
    expect(infoSpy).toHaveBeenCalledWith(
      'webrtc:whep-attempt-settled',
      expect.objectContaining({
        attemptId: 1,
        rungPath: '/cam/whep',
        outcome: 'connected',
      }),
    )
    infoSpy.mockRestore()
  })

  it('Given WHEP returns non-2xx, When the attempt settles, Then the ledger captures the HTTP outcome and emits one warning log line (W13/W14)', async () => {
    // arrange
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {})
    ;(globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response('no such path', { status: 404 }),
    )

    // act
    await expect(connectWhep('http://example/cam/whep', makeVideo())).rejects.toThrow(/WHEP 404/)

    // assert
    const ledger = getWhepAttemptLedger()
    expect(ledger).toHaveLength(1)
    expect(ledger[0]).toEqual(
      expect.objectContaining({
        attemptId: 1,
        rungPath: '/cam/whep',
        outcome: 'http-404',
      }),
    )
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy).toHaveBeenCalledWith(
      'webrtc:whep-attempt-settled',
      expect.objectContaining({
        attemptId: 1,
        rungPath: '/cam/whep',
        outcome: 'http-404',
      }),
    )
    warnSpy.mockRestore()
  })

  it('Given more than twenty WHEP attempts settle, When the ledger is read, Then only the latest twenty entries remain (W13)', async () => {
    // arrange
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() =>
        Promise.resolve(new Response('ANSWER_SDP', { status: 200 })),
      ),
    )
    const infoSpy = vi.spyOn(log, 'info').mockImplementation(() => {})

    // act
    for (let i = 0; i < 21; i++) {
      await connectWhep(`http://example/cam-${i}/whep`, makeVideo())
      const pc = MockRTCPeerConnection.instances[i]
      pc.ontrack?.({ streams: [{ id: `stream-${i}` } as unknown as MediaStream] })
      pc.connectionState = 'connected'
      pc.dispatchEventType('connectionstatechange')
    }

    // assert
    const ledger = getWhepAttemptLedger()
    expect(ledger).toHaveLength(20)
    expect(ledger[0].attemptId).toBe(2)
    expect(ledger[19].attemptId).toBe(21)
    infoSpy.mockRestore()
  })

  it('Given SDP bodies contain candidates and IPs, When an attempt is serialized from the ledger, Then no SDP, candidate string, or IP substring is present (W13 privacy)', async () => {
    // arrange
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {})
    const answerSdp = [
      'v=0',
      'a=candidate:1 1 udp 2113937151 192.168.1.50 54321 typ host',
      'a=candidate:2 1 udp 1677729535 203.0.113.7 40000 typ srflx raddr 192.168.1.50 rport 54321',
    ].join('\n')
    ;(globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(answerSdp, { status: 200 }),
    )
    const remoteSpy = vi.spyOn(MockRTCPeerConnection.prototype, 'setRemoteDescription').mockRejectedValueOnce(
      new Error('remote rejected'),
    )

    // act
    await expect(connectWhep('http://example/cam/whep', makeVideo())).rejects.toThrow(
      /remote rejected/,
    )

    // assert
    const serialized = JSON.stringify(getWhepAttemptLedger())
    expect(serialized).toContain('"answerCandidates"')
    expect(serialized).not.toContain('v=0')
    expect(serialized).not.toContain('a=candidate')
    expect(serialized).not.toContain('192.168.1.50')
    expect(serialized).not.toContain('203.0.113.7')
    remoteSpy.mockRestore()
    warnSpy.mockRestore()
  })

  it('Given the signal aborts while the WHEP POST is in flight, When the fetch rejects, Then connectWhep closes the pc (no leak on a hung POST) (defect 1)', async () => {
    // arrange — fetch never resolves on its own; only rejects when the
    // signal aborts, mirroring the real fetch+AbortController contract.
    let capturedSignal: AbortSignal | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit) => {
        capturedSignal = init?.signal ?? undefined
        return new Promise((_resolve, reject) => {
          capturedSignal?.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'))
          })
        })
      }),
    )
    const controller = new AbortController()

    // act
    const pending = connectWhep('http://example/cam/whep', makeVideo(), {
      signal: controller.signal,
    })
    controller.abort()

    // assert
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    const pc = MockRTCPeerConnection.instances[0]
    expect(pc.closed).toBe(true)
  })

  it('Given ontrack fires after the signal has aborted, When the handler runs, Then it does NOT write the stale stream into video.srcObject (defect 2)', async () => {
    // arrange — a connection that's about to resolve, but its signal is
    // aborted before ontrack fires (simulating the async race where a
    // quality switch cancels attempt A right as A's stream arrives).
    const controller = new AbortController()
    const video = makeVideo()
    const connPromise = connectWhep('http://example/cam/whep', video, {
      signal: controller.signal,
    })
    await connPromise
    const pc = MockRTCPeerConnection.instances[0]

    // act — abort AFTER connect resolved (mimics cleanup racing ontrack),
    // then fire the stale track event.
    controller.abort()
    const staleStream = { id: 'stale' } as unknown as MediaStream
    pc.ontrack?.({ streams: [staleStream] })

    // assert — srcObject was never set to the stale stream.
    expect(video.srcObject).toBeNull()
  })

  it('Given close() is called after a NEWER connection already wrote its own stream, When it runs, Then it does NOT clear video.srcObject (defect 2 — only owns its own stream)', async () => {
    // arrange — connection A resolves and binds its stream, then a NEWER
    // connection B (simulating a quality switch) binds a different stream
    // to the same shared video element before A's close() runs. Each
    // connectWhep call needs its own Response (the body can only be read
    // once), so a fresh instance is returned per invocation.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(
        () => Promise.resolve(new Response('ANSWER_SDP', { status: 200 })),
      ),
    )
    const video = makeVideo()
    const connA = await connectWhep('http://example/cam/whep', video)
    const pcA = MockRTCPeerConnection.instances[0]
    const streamA = { id: 'A' } as unknown as MediaStream
    pcA.ontrack?.({ streams: [streamA] })
    expect(video.srcObject).toBe(streamA)

    const connB = await connectWhep('http://example/cam/whep', video)
    const pcB = MockRTCPeerConnection.instances[1]
    const streamB = { id: 'B' } as unknown as MediaStream
    pcB.ontrack?.({ streams: [streamB] })
    expect(video.srcObject).toBe(streamB)

    // act — A's (superseded) close() runs after B already owns the video.
    connA.close()

    // assert — B's stream survives; A's close() did not blank it.
    expect(video.srcObject).toBe(streamB)

    // sanity — B's own close() DOES clear it (owns the stream it set).
    connB.close()
    expect(video.srcObject).toBeNull()
  })
})

describe('lib/webrtc.summarizeCandidates', () => {
  it('Given an SDP with mixed candidate types, When summarized, Then it returns counts and srflxPresent WITHOUT leaking IPs', () => {
    // arrange — a candidate block with one host + one srflx line. The host
    // line carries a private IP; the summary must surface the COUNT only.
    const sdp = [
      'v=0',
      'a=candidate:1 1 udp 2113937151 192.168.1.50 54321 typ host',
      'a=candidate:2 1 udp 1677729535 203.0.113.7 40000 typ srflx raddr 192.168.1.50 rport 54321',
    ].join('\n')

    // act
    const s = summarizeCandidates(sdp)

    // assert — counts present, srflx flagged, and the function's own return
    // contains no raw IP fields (the caller logs only this object).
    expect(s.total).toBe(2)
    expect(s.host).toBe(1)
    expect(s.srflx).toBe(1)
    expect(s.srflxPresent).toBe(true)
    expect(JSON.stringify(s)).not.toContain('192.168.1.50')
  })

  it('Given a null/empty SDP, When summarized, Then all counts are zero and srflx is absent', () => {
    // arrange / act / assert
    expect(summarizeCandidates(null).srflxPresent).toBe(false)
    expect(summarizeCandidates('').total).toBe(0)
  })
})

describe('lib/webrtc.warmWhepConnection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getMediaTokenM.mockResolvedValue({
      token: 'fresh-video-grant',
      expires_ts: 2000,
    })
    MockRTCPeerConnection.instances = []
    _resetWhepAttemptLedgerForTests()
    vi.stubGlobal('RTCPeerConnection', MockRTCPeerConnection as unknown as typeof RTCPeerConnection)
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('ANSWER_SDP', { status: 200 })),
    )
    _resetWhepWarmupForTests()
  })
  afterEach(() => {
    _resetWhepWarmupForTests()
    _resetWhepAttemptLedgerForTests()
    vi.unstubAllGlobals()
  })

  it('Given warmup runs, When the peer connection is created, Then it uses the same STUN config as the cold path and the only transceiver is recvonly video (iter cellular-ice: warm/cold parity, no audio)', async () => {
    // arrange / act
    await warmWhepConnection()

    // assert — pre-warm PC is configured identically to the cold-path PC
    // so warm-vs-cold consume produces no behavior difference. Both now
    // carry STUN (iter cellular-ice) so the warmed PC pre-gathers the
    // srflx candidate cellular needs. Still no audio transceiver.
    const pc = MockRTCPeerConnection.instances[0]
    const urls = (pc.config?.iceServers ?? []).map((s) => s.urls)
    expect(urls).toContain('stun:stun.l.google.com:19302')
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
    const urls = (pc.config?.iceServers ?? []).map((s) => s.urls)
    expect(urls).toContain('stun:stun.l.google.com:19302')
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
    expect(getMediaTokenM).not.toHaveBeenCalled()
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
