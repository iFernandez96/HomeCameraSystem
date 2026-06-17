export type WhepConnection = {
  pc: RTCPeerConnection
  close: () => void
}

// iter cellular-ice (2026-06-17): ICE servers.
//
// Pre-iter-cellular-ice this was `[]` (no STUN) — fine on LAN/tailnet-wifi
// where a host candidate (10.0.0.9 or the Tailscale IP) is directly
// reachable. But on CELLULAR the phone has no LAN path, and an in-browser
// WebRTC media socket does NOT route through the Tailscale VPN tunnel
// (the WHEP control plane does, the media doesn't), so the only reachable
// host candidate (100.85.251.7) gets the media packets dropped by the
// carrier and MediaMTX logs "deadline exceeded while waiting connection".
// STUN gives both peers a server-reflexive (public) candidate so they can
// hole-punch directly over the public internet — standard mobile-WebRTC
// NAT traversal. TURN (a relay) is the fallback for symmetric-NAT carriers
// where the hole-punch fails; populated from VITE_TURN_* at build time so
// no relay credentials are committed. MediaMTX must mirror this server-side
// (webrtcICEServers2 in deploy/mediamtx.yml) so its side also gathers srflx.
const _TURN_URL = import.meta.env.VITE_TURN_URL as string | undefined
const _TURN_USER = import.meta.env.VITE_TURN_USERNAME as string | undefined
const _TURN_CRED = import.meta.env.VITE_TURN_CREDENTIAL as string | undefined
const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  ...(_TURN_URL && _TURN_USER && _TURN_CRED
    ? [{ urls: _TURN_URL, username: _TURN_USER, credential: _TURN_CRED }]
    : []),
]


// Premium-launch slice — pre-WHEP connection warmup.
//
// The WHEP handshake decomposes into:
//   1. Create RTCPeerConnection (LOCAL — no network)
//   2. Add recvonly video transceiver (LOCAL)
//   3. createOffer() (LOCAL — generate SDP)
//   4. setLocalDescription() (LOCAL — kicks ICE gathering)
//   5. Wait for ICE gathering to complete (LOCAL — host candidates only,
//      because iceServers: [] means we never hit STUN)
//   6. POST /whep/cam/whep with our SDP (NETWORK — auth-protected)
//   7. setRemoteDescription(answer) (LOCAL)
//
// Steps 1-5 are 100% local and safe to do at any time after auth has
// resolved (we don't warm pre-auth — see auth.tsx for the gate).
// They take ~5-50 ms total but on a slow phone the createOffer +
// setLocalDescription + ICE gathering chain serializes in front of
// the user-perceived "first frame" timer that starts at /live mount.
//
// By warming the PC during the brief window between auth-resolved
// and Live-route-mount (the user typing creds → submit → React
// navigates → Live lazy chunk loads → VideoTile mounts), we move
// those 5-50 ms off the critical path. When connectWhep is called
// post-mount, it claims the warmed PC instead of doing 1-5 itself.
//
// Safety:
//   - Warmup does not touch /whep/* (the auth-protected endpoint).
//   - Warmup does not bind to a video element (no `<video>` srcObject
//     change before the user lands on Live). That binding happens at
//     consume time, when we have the user's intended video element.
//   - iter cellular-ice: warmup now uses the same ICE_SERVERS (STUN, +
//     TURN if configured) as connectWhep so the warmed PC's pre-gathered
//     candidates include the srflx candidate cellular needs.
//   - The cached PC is invalidated on the `offline` window event so
//     a Wi-Fi → cellular swap doesn't re-use stale host candidates.
//   - TTL of WARM_TTL_MS (30 s) bounds memory if the user warms but
//     never reaches /live (e.g., logs in then closes the tab).

let _warmed: { pc: RTCPeerConnection; createdAt: number } | null = null
const WARM_TTL_MS = 30_000

/** Test-only helper: drop the warm cache between tests. */
export function _resetWhepWarmupForTests(): void {
  if (_warmed) {
    try {
      _warmed.pc.close()
    } catch {
      /* ignore — test mocks may not implement close fully */
    }
    _warmed = null
  }
}

/**
 * Warm a peer connection in advance. Idempotent: a second call
 * while a warmed PC exists is a no-op. Errors are swallowed —
 * warmup is best-effort; if it fails, connectWhep still works
 * via the cold path. Returns once the cache is primed (or once
 * the warmup attempt has resolved either way).
 *
 * Caller is responsible for gating this behind any preconditions
 * (e.g., only call after auth resolves to 'authed' — see
 * lib/auth.tsx for the wiring).
 */
export async function warmWhepConnection(): Promise<void> {
  if (typeof window === 'undefined') return
  if (typeof RTCPeerConnection === 'undefined') return
  if (_warmed) return
  let pc: RTCPeerConnection | null = null
  try {
    pc = new RTCPeerConnection({ iceServers: ICE_SERVERS })
    pc.addTransceiver('video', { direction: 'recvonly' })
    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    await iceGatheringComplete(pc)
    if (_warmed) {
      // Lost a race with another warmup call (StrictMode dev double-
      // mount, double-submit). Keep the existing one, drop ours.
      pc.close()
      return
    }
    _warmed = { pc, createdAt: Date.now() }
  } catch {
    // Warmup is best-effort. A transient failure here must not
    // poison subsequent connectWhep calls.
    if (pc) {
      try {
        pc.close()
      } catch {
        /* swallow */
      }
    }
    _warmed = null
  }
}

/** Pop the cached PC if one exists and hasn't aged out. Returns
 *  null if no warm PC available (or if it aged past TTL). */
function _claimWarmed(): RTCPeerConnection | null {
  if (!_warmed) return null
  const aged = Date.now() - _warmed.createdAt > WARM_TTL_MS
  if (aged) {
    try {
      _warmed.pc.close()
    } catch {
      /* swallow */
    }
    _warmed = null
    return null
  }
  const pc = _warmed.pc
  _warmed = null
  return pc
}

// Invalidate the warmed cache when the network drops — host
// candidates would resolve to the previous interface's IP after
// resume. Test environments without `window` skip this branch.
if (typeof window !== 'undefined') {
  window.addEventListener('offline', () => {
    if (_warmed) {
      try {
        _warmed.pc.close()
      } catch {
        /* swallow */
      }
      _warmed = null
    }
  })
}

/**
 * Connect to a MediaMTX WHEP endpoint and attach the inbound
 * MediaStream to the given video element. WHEP = WebRTC-HTTP
 * Egress Protocol; MediaMTX exposes one per path at /<name>/whep.
 *
 * If a warmed peer connection is available (see warmWhepConnection
 * above), we reuse it — saving the local SDP generation + ICE
 * gathering phase. The warmed PC's localDescription already has
 * its host candidates baked in. Otherwise we do the full cold
 * sequence.
 *
 * Connection retry + failure semantics are unchanged from pre-
 * warmup: a non-2xx WHEP response throws and closes the PC; a
 * mid-stream connection failure is surfaced via VideoTile's
 * connectionstatechange listener (iter-162) and recovered via the
 * manual Retry button.
 */
export async function connectWhep(
  url: string,
  video: HTMLVideoElement,
): Promise<WhepConnection> {
  const claimed = _claimWarmed()
  let pc: RTCPeerConnection
  if (claimed) {
    pc = claimed
  } else {
    // No STUN: this is a LAN-only deployment (Jetson on the same
    // network as the browser). Skipping STUN saves ~200-500 ms of
    // resolution time for the first frame, and avoids leaking the
    // LAN IP to a public server.
    pc = new RTCPeerConnection({ iceServers: ICE_SERVERS })
    // Video only — the camera has no audio. An audio transceiver
    // costs ~50-100 ms of SDP/ICE negotiation for a track that never
    // carries data.
    pc.addTransceiver('video', { direction: 'recvonly' })
  }

  pc.ontrack = (e) => {
    if (video.srcObject !== e.streams[0]) {
      video.srcObject = e.streams[0]
    }
  }

  // Cold path (no warmup): generate offer + gather ICE now.
  // Warm path: pc.localDescription is already populated with the
  // pre-baked host-candidate SDP — skip straight to the network
  // round-trip.
  if (!pc.localDescription) {
    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    await iceGatheringComplete(pc)
  }

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
    // iter cellular-ice: this cap was 250 ms when iceServers was `[]`
    // (host-only gathering completes in <50 ms). With STUN enabled
    // (ICE_SERVERS), `icegatheringstatechange → complete` only fires
    // AFTER the STUN round-trip that produces the server-reflexive
    // candidate — and on cellular that candidate is the ONLY one that
    // can connect, so cutting gathering off at 250 ms would drop it and
    // guarantee the cellular failure we're fixing. The `complete` event
    // still resolves as soon as gathering actually finishes (≈ STUN RTT,
    // ~tens of ms on a good link), so on LAN/wifi this rarely waits the
    // full cap; the cap is just the upper bound if STUN is slow/blocked.
    const timer = setTimeout(finish, 2500)
  })
}
