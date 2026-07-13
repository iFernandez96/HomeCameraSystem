import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { getMediaTokenM, logWarnM } = vi.hoisted(() => ({
  getMediaTokenM: vi.fn(),
  logWarnM: vi.fn(),
}))

vi.mock('./api', () => ({
  getMediaToken: (...args: unknown[]) => getMediaTokenM(...args),
}))

vi.mock('./log', () => ({
  log: { warn: (...args: unknown[]) => logWarnM(...args) },
  errFields: (error: unknown) => ({
    name: error instanceof Error ? error.name : 'Error',
    message: error instanceof Error ? error.message : String(error),
  }),
}))

import {
  startListenSession,
  startTalkSession,
  talkWhipUrlForTests,
} from './twoWayAudio'

function peerConnection() {
  let connectionListener: (() => void) | null = null
  const peer = {
    iceGatheringState: 'complete',
    connectionState: 'new' as RTCPeerConnectionState,
    localDescription: null as RTCSessionDescriptionInit | null,
    createOffer: vi.fn().mockResolvedValue({ type: 'offer', sdp: 'private-offer-sdp' }),
    setLocalDescription: vi.fn(async (description: RTCSessionDescriptionInit) => {
      peer.localDescription = description
    }),
    setRemoteDescription: vi.fn().mockResolvedValue(undefined),
    addTrack: vi.fn(),
    addTransceiver: vi.fn(),
    addEventListener: vi.fn((type: string, listener: () => void) => {
      if (type === 'connectionstatechange') connectionListener = listener
    }),
    removeEventListener: vi.fn((type: string, listener: () => void) => {
      if (type === 'connectionstatechange' && connectionListener === listener) {
        connectionListener = null
      }
    }),
    close: vi.fn(),
    ontrack: null,
    emitConnectionState(state: RTCPeerConnectionState) {
      peer.connectionState = state
      connectionListener?.()
    },
  }
  return peer
}

const mediaDevicesDescriptor = Object.getOwnPropertyDescriptor(
  navigator,
  'mediaDevices',
)

beforeEach(() => {
  vi.clearAllMocks()
  getMediaTokenM.mockResolvedValue({
    token: 'super-secret-scoped-token',
    expires_ts: 2000,
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  if (mediaDevicesDescriptor) {
    Object.defineProperty(navigator, 'mediaDevices', mediaDevicesDescriptor)
  } else {
    Reflect.deleteProperty(navigator, 'mediaDevices')
  }
})

describe('talk WHIP routing', () => {
  it('never bypasses the same-origin media proxy for an HTTP origin', () => {
    expect(talkWhipUrlForTests({ protocol: 'http:', hostname: 'jetson', origin: 'http://jetson:8000' }))
      .toBe('http://jetson:8000/whep/talk/whip')
  })

  it('uses the existing secure MediaMTX path proxy on HTTPS', () => {
    expect(talkWhipUrlForTests({ protocol: 'https:', hostname: 'homecam.test', origin: 'https://homecam.test' }))
      .toBe('https://homecam.test/whep/talk/whip')
  })
})

describe('scoped two-way audio authorization', () => {
  it('asks for microphone permission before fetching a fresh publish token immediately before WHIP', async () => {
    const track = { stop: vi.fn() }
    const getUserMedia = vi.fn().mockResolvedValue({
      getAudioTracks: () => [track],
      getTracks: () => [track],
    })
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia },
    })
    const peer = peerConnection()
    vi.stubGlobal('RTCPeerConnection', vi.fn(() => peer))
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('answer-sdp', { status: 200 }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const storageSpy = vi.spyOn(Storage.prototype, 'setItem')

    const session = await startTalkSession({
      protocol: 'https:',
      hostname: 'homecam.test',
      origin: 'https://homecam.test',
    })

    expect(getMediaTokenM).toHaveBeenCalledWith('publish', 'talk')
    expect(getUserMedia.mock.invocationCallOrder[0]).toBeLessThan(
      getMediaTokenM.mock.invocationCallOrder[0],
    )
    expect(getMediaTokenM.mock.invocationCallOrder[0]).toBeLessThan(
      fetchMock.mock.invocationCallOrder[0],
    )
    expect(fetchMock).toHaveBeenCalledWith(
      'https://homecam.test/whep/talk/whip',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'application/sdp',
          Authorization: 'Bearer super-secret-scoped-token',
        },
      }),
    )
    expect(logWarnM).not.toHaveBeenCalled()
    expect(storageSpy).not.toHaveBeenCalled()
    expect(window.localStorage.getItem('super-secret-scoped-token')).toBeNull()
    expect(window.sessionStorage.getItem('super-secret-scoped-token')).toBeNull()

    session.close()
    expect(track.stop).toHaveBeenCalled()
    expect(peer.close).toHaveBeenCalled()
  })

  it('fetches a read token and attaches Bearer to listen WHEP', async () => {
    const peer = peerConnection()
    const player = {
      autoplay: false,
      srcObject: null,
      play: vi.fn().mockResolvedValue(undefined),
      pause: vi.fn(),
    }
    vi.stubGlobal('RTCPeerConnection', vi.fn(() => peer))
    vi.stubGlobal('Audio', vi.fn(() => player))
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('answer-sdp', { status: 200 }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const session = await startListenSession({
      protocol: 'https:',
      hostname: 'homecam.test',
      origin: 'https://homecam.test',
    })

    expect(getMediaTokenM).toHaveBeenCalledWith('read', 'listen')
    expect(fetchMock).toHaveBeenCalledWith(
      'https://homecam.test/whep/listen/whep',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer super-secret-scoped-token',
        }),
      }),
    )
    session.close()
    expect(player.pause).toHaveBeenCalled()
    expect(peer.close).toHaveBeenCalled()
  })

  it('stops microphone tracks on WHIP failure without logging or storing the token', async () => {
    const track = { stop: vi.fn() }
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: vi.fn().mockResolvedValue({
          getAudioTracks: () => [track],
          getTracks: () => [track],
        }),
      },
    })
    const peer = peerConnection()
    vi.stubGlobal('RTCPeerConnection', vi.fn(() => peer))
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 503 })))
    const storageSpy = vi.spyOn(Storage.prototype, 'setItem')

    await expect(startTalkSession()).rejects.toThrow('WHIP 503')

    expect(track.stop).toHaveBeenCalled()
    expect(peer.close).toHaveBeenCalled()
    expect(storageSpy).not.toHaveBeenCalled()
    expect(JSON.stringify(logWarnM.mock.calls)).not.toContain(
      'super-secret-scoped-token',
    )
  })

  it('stops granted microphone tracks when scoped-token issuance fails', async () => {
    const track = { stop: vi.fn() }
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: vi.fn().mockResolvedValue({
          getAudioTracks: () => [track],
          getTracks: () => [track],
        }),
      },
    })
    const peer = peerConnection()
    vi.stubGlobal('RTCPeerConnection', vi.fn(() => peer))
    getMediaTokenM.mockRejectedValueOnce(new Error('token unavailable'))

    await expect(startTalkSession()).rejects.toThrow('token unavailable')

    expect(track.stop).toHaveBeenCalled()
    expect(peer.close).toHaveBeenCalled()
    expect(JSON.stringify(logWarnM.mock.calls)).not.toContain(
      'super-secret-scoped-token',
    )
  })

  it('stops microphone tracks and notifies the caller when the peer fails remotely', async () => {
    const track = { stop: vi.fn() }
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: vi.fn().mockResolvedValue({
          getAudioTracks: () => [track],
          getTracks: () => [track],
        }),
      },
    })
    const peer = peerConnection()
    const onEnded = vi.fn()
    vi.stubGlobal('RTCPeerConnection', vi.fn(() => peer))
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('answer-sdp', { status: 200 })),
    )
    await startTalkSession(undefined, onEnded)

    peer.emitConnectionState('failed')

    expect(track.stop).toHaveBeenCalledTimes(1)
    expect(peer.close).toHaveBeenCalledTimes(1)
    expect(onEnded).toHaveBeenCalledWith('failed')
  })
})
