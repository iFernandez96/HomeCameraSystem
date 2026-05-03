export type WhepConnection = {
  pc: RTCPeerConnection
  close: () => void
}

/**
 * Connect to a MediaMTX WHEP endpoint and attach the inbound MediaStream to the given video element.
 * WHEP = WebRTC-HTTP Egress Protocol; MediaMTX exposes one per path at /<name>/whep.
 */
export async function connectWhep(
  url: string,
  video: HTMLVideoElement,
): Promise<WhepConnection> {
  // No STUN: this is a LAN-only deployment (Jetson on the same network as the
  // browser). Skipping STUN saves ~200-500ms of resolution time for the first
  // frame, and avoids leaking the LAN IP to a public server.
  const pc = new RTCPeerConnection({ iceServers: [] })

  // Video only — the camera has no audio. An audio transceiver costs ~50-100ms
  // of SDP/ICE negotiation for a track that never carries data.
  pc.addTransceiver('video', { direction: 'recvonly' })

  pc.ontrack = (e) => {
    if (video.srcObject !== e.streams[0]) {
      video.srcObject = e.streams[0]
    }
  }

  const offer = await pc.createOffer()
  await pc.setLocalDescription(offer)
  await iceGatheringComplete(pc)

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/sdp' },
    body: pc.localDescription!.sdp,
  })
  if (!res.ok) {
    pc.close()
    throw new Error(`WHEP ${res.status} ${await res.text()}`)
  }
  const answerSdp = await res.text()
  await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp })

  return {
    pc,
    close: () => {
      pc.getReceivers().forEach((r) => r.track?.stop())
      pc.close()
    },
  }
}

function iceGatheringComplete(pc: RTCPeerConnection): Promise<void> {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') return resolve()
    let done = false
    const finish = () => {
      if (done) return
      done = true
      pc.removeEventListener('icegatheringstatechange', onChange)
      clearTimeout(timer)
      resolve()
    }
    const onChange = () => {
      if (pc.iceGatheringState === 'complete') finish()
    }
    pc.addEventListener('icegatheringstatechange', onChange)
    // 250 ms is plenty on a LAN — host candidates gather in <50 ms with no
    // STUN. The fallback only fires if something is wrong; in normal cases
    // the icegatheringstatechange event resolves first. The previous 3 s
    // timeout meant a slow LAN could block first-frame for that long.
    const timer = setTimeout(finish, 250)
  })
}
