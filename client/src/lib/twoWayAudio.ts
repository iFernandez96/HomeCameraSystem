import { log, errFields } from './log'
import { getMediaToken } from './api'

export type AudioSessionEndReason = 'failed' | 'closed' | 'disconnected'
export type TalkSession = { close: () => void }
export type ListenSession = { close: () => void }
type SessionEnded = (reason: AudioSessionEndReason) => void

function connectionGuard(
  pc: RTCPeerConnection,
  cleanup: () => void,
  onEnded?: SessionEnded,
): { close: () => void; abort: () => void } {
  let ended = false
  let disconnectTimer: number | null = null
  const clearDisconnectTimer = () => {
    if (disconnectTimer !== null) window.clearTimeout(disconnectTimer)
    disconnectTimer = null
  }
  const finish = (reason?: AudioSessionEndReason) => {
    if (ended) return
    ended = true
    clearDisconnectTimer()
    pc.removeEventListener('connectionstatechange', changed)
    cleanup()
    if (pc.connectionState !== 'closed') pc.close()
    if (reason) onEnded?.(reason)
  }
  const changed = () => {
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
      finish(pc.connectionState)
      return
    }
    if (pc.connectionState === 'disconnected') {
      clearDisconnectTimer()
      disconnectTimer = window.setTimeout(() => {
        if (pc.connectionState === 'disconnected') finish('disconnected')
      }, 5000)
      return
    }
    clearDisconnectTimer()
  }
  pc.addEventListener('connectionstatechange', changed)
  return {
    close: () => finish(),
    abort: () => finish(),
  }
}

function whipUrl(location: Pick<Location, 'protocol' | 'hostname' | 'origin'>): string {
  // Production reaches MediaMTX only through the same-origin Tailscale HTTPS
  // proxy. The upstream suffix can still be /whip, allowing ingress without
  // another remotely reachable signaling listener. Local Vite development
  // uses the matching same-origin proxy.
  return `${location.origin}/whep/talk/whip`
}

function waitForIce(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve()
  return new Promise((resolve) => {
    const timeout = window.setTimeout(done, 2500)
    function done() {
      window.clearTimeout(timeout)
      pc.removeEventListener('icegatheringstatechange', changed)
      resolve()
    }
    function changed() {
      if (pc.iceGatheringState === 'complete') done()
    }
    pc.addEventListener('icegatheringstatechange', changed)
  })
}

export async function startTalkSession(
  location: Pick<Location, 'protocol' | 'hostname' | 'origin'> = window.location,
  onEnded?: SessionEnded,
): Promise<TalkSession> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    video: false,
  })
  let pc: RTCPeerConnection | null = null
  let guard: ReturnType<typeof connectionGuard> | null = null
  const cleanup = () => {
    for (const track of stream.getTracks()) track.stop()
  }
  try {
    const peer = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] })
    pc = peer
    guard = connectionGuard(peer, cleanup, onEnded)
    for (const track of stream.getAudioTracks()) peer.addTrack(track, stream)
    await peer.setLocalDescription(await peer.createOffer())
    await waitForIce(peer)
    const { token } = await getMediaToken('publish', 'talk')
    const response = await fetch(whipUrl(location), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/sdp',
        Authorization: `Bearer ${token}`,
      },
      body: peer.localDescription?.sdp ?? '',
    })
    if (!response.ok) throw new Error(`WHIP ${response.status}`)
    await peer.setRemoteDescription({ type: 'answer', sdp: await response.text() })
    return { close: guard.close }
  } catch (error) {
    if (guard) guard.abort()
    else {
      cleanup()
      pc?.close()
    }
    log.warn('audio:talk-connect-failed', errFields(error))
    throw error
  }
}

export async function startListenSession(
  location: Pick<Location, 'protocol' | 'hostname' | 'origin'> = window.location,
  onEnded?: SessionEnded,
): Promise<ListenSession> {
  let pc: RTCPeerConnection | null = null
  let audio: HTMLAudioElement | null = null
  let guard: ReturnType<typeof connectionGuard> | null = null
  const cleanup = () => {
    audio?.pause()
    if (audio) audio.srcObject = null
  }
  try {
    const peer = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] })
    const player = new Audio()
    pc = peer
    audio = player
    guard = connectionGuard(peer, cleanup, onEnded)
    player.autoplay = true
    peer.addTransceiver('audio', { direction: 'recvonly' })
    peer.ontrack = (event) => {
      player.srcObject = event.streams[0] ?? new MediaStream([event.track])
      void player.play().catch(() => {})
    }
    await peer.setLocalDescription(await peer.createOffer())
    await waitForIce(peer)
    const { token } = await getMediaToken('read', 'listen')
    const path = `${location.origin}/whep/listen/whep`
    const response = await fetch(path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/sdp',
        Authorization: `Bearer ${token}`,
      },
      body: peer.localDescription?.sdp ?? '',
    })
    if (!response.ok) throw new Error(`WHEP ${response.status}`)
    await peer.setRemoteDescription({ type: 'answer', sdp: await response.text() })
    return { close: guard.close }
  } catch (error) {
    if (guard) guard.abort()
    else {
      cleanup()
      pc?.close()
    }
    log.warn('audio:listen-connect-failed', errFields(error))
    throw error
  }
}

export function talkWhipUrlForTests(
  location: Pick<Location, 'protocol' | 'hostname' | 'origin'>,
): string {
  return whipUrl(location)
}
