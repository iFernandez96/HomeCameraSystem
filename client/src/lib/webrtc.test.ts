import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { connectWhep } from './webrtc'

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
