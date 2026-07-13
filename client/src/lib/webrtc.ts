import { log, errFields } from './log'
import { getMediaToken } from './api'

export type WhepConnection = {
  pc: RTCPeerConnection
  close: () => void
}

export type WhepAttemptOutcome =
  | 'connected'
  | `http-${number}`
  | 'set-remote-failed'
  | 'aborted'
  | 'ice-failed'
  // pre-response throws (fetch network error, createOffer reject) — NOT an
  // ICE verdict; keep distinct so parity diffs vs mediamtx logs stay honest
  | 'error'

export type WhepAttemptLedgerEntry = Readonly<{
  attemptId: number
  rungPath: string
  startedAt: number
  settledAt?: number
  outcome?: WhepAttemptOutcome
  msToFirstTrack?: number
  offerCandidates?: ReturnType<typeof summarizeCandidates>
  answerCandidates?: ReturnType<typeof summarizeCandidates>
}>

const WHEP_ATTEMPT_LEDGER_CAP = 20
let _nextWhepAttemptId = 1
const _whepAttemptLedger: WhepAttemptLedgerEntry[] = []

function whepRungPath(url: string): string {
  try {
    const base = typeof window !== 'undefined' ? window.location.href : 'http://local.invalid/'
    return new URL(url, base).pathname
  } catch {
    return '<invalid-url>'
  }
}

function mediaPathFromWhepUrl(url: string): string {
  const base = typeof window !== 'undefined' ? window.location.href : 'http://local.invalid/'
  const parts = new URL(url, base).pathname.split('/').filter(Boolean)
  if (parts.length < 2 || parts[parts.length - 1] !== 'whep') {
    throw new Error('Invalid WHEP URL')
  }
  const path = parts[parts.length - 2]
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(path)) {
    throw new Error('Invalid WHEP media path')
  }
  return path
}

function appendWhepAttempt(entry: WhepAttemptLedgerEntry): void {
  _whepAttemptLedger.push(entry)
  while (_whepAttemptLedger.length > WHEP_ATTEMPT_LEDGER_CAP) {
    _whepAttemptLedger.shift()
  }
}

function upsertWhepAttempt(entry: WhepAttemptLedgerEntry): void {
  const idx = _whepAttemptLedger.findIndex((existing) => existing.attemptId === entry.attemptId)
  if (idx === -1) {
    appendWhepAttempt(entry)
    return
  }
  _whepAttemptLedger[idx] = entry
}

export function getWhepAttemptLedger(): readonly WhepAttemptLedgerEntry[] {
  return _whepAttemptLedger.map((entry) => ({
    ...entry,
    offerCandidates: entry.offerCandidates ? { ...entry.offerCandidates } : undefined,
    answerCandidates: entry.answerCandidates ? { ...entry.answerCandidates } : undefined,
  }))
}
if (typeof window !== 'undefined') (window as unknown as { __homecamWhepLedgerDump?: typeof getWhepAttemptLedger }).__homecamWhepLedgerDump = getWhepAttemptLedger

/** Test-only helper: reset the WHEP attempt ledger between tests. */
export function _resetWhepAttemptLedgerForTests(): void {
  _nextWhepAttemptId = 1
  _whepAttemptLedger.length = 0
}

/**
 * Summarize an SDP's ICE candidates WITHOUT leaking private IPs. Returns the
 * count plus per-type counts (host / srflx / relay / prflx) derived from the
 * `a=candidate:` lines' `typ` token. `srflx` present is the load-bearing
 * signal for cellular NAT traversal (see ICE_SERVERS note). NEVER log the
 * full SDP — `m=`/`a=candidate` lines carry LAN + Tailscale IPs.
 */
export function summarizeCandidates(sdp: string | null | undefined): {
  total: number
  host: number
  srflx: number
  relay: number
  prflx: number
  srflxPresent: boolean
} {
  const out = { total: 0, host: 0, srflx: 0, relay: 0, prflx: 0, srflxPresent: false }
  if (!sdp) return out
  const lines = sdp.split('\n')
  for (const line of lines) {
    if (line.indexOf('a=candidate:') === -1) continue
    out.total++
    const m = line.match(/ typ (host|srflx|relay|prflx)/)
    if (m) {
      const typ = m[1] as 'host' | 'srflx' | 'relay' | 'prflx'
      out[typ]++
    }
  }
  out.srflxPresent = out.srflx > 0
  return out
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
  } catch (e) {
    // Warmup is best-effort. A transient failure here must not
    // poison subsequent connectWhep calls — but log at DEBUG so an
    // ALWAYS-failing warmup (which silently forces every connect onto the
    // slow cold path) is visible during triage.
    log.debug('webrtc:warmup-failed', { ...errFields(e) })
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
  opts?: { signal?: AbortSignal },
): Promise<WhepConnection> {
  const signal = opts?.signal
  const mediaPath = mediaPathFromWhepUrl(url)
  const attemptId = _nextWhepAttemptId++
  const attempt: WhepAttemptLedgerEntry = {
    attemptId,
    rungPath: whepRungPath(url),
    startedAt: Date.now(),
  }
  appendWhepAttempt(attempt)
  let settled = false
  const settleAttempt = (
    outcome: WhepAttemptOutcome,
    extra: Partial<Pick<WhepAttemptLedgerEntry, 'msToFirstTrack' | 'offerCandidates' | 'answerCandidates'>> = {},
  ) => {
    if (settled) return
    settled = true
    const entry: WhepAttemptLedgerEntry = {
      ...attempt,
      settledAt: Date.now(),
      outcome,
      ...extra,
    }
    upsertWhepAttempt(entry)
    const fields = {
      attemptId: entry.attemptId,
      rungPath: entry.rungPath,
      startedAt: entry.startedAt,
      settledAt: entry.settledAt,
      outcome: entry.outcome,
      msToFirstTrack: entry.msToFirstTrack,
      offerCandidates: entry.offerCandidates,
      answerCandidates: entry.answerCandidates,
    }
    if (outcome === 'connected') {
      log.info('webrtc:whep-attempt-settled', fields)
    } else {
      log.warn('webrtc:whep-attempt-settled', fields)
    }
  }
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

  // Defect-1 fix (WebRTC lifecycle audit): unmount / rung-change mid-connect
  // must actually close THIS pc, not just abandon it — pre-fix, VideoTile's
  // cleanup only had a `cancelled` flag; if the WHEP POST was still in
  // flight, `conn` was still null so nothing closed the pc, leaking its ICE
  // agent + sockets (and rapid rung changes could stack several open PCs).
  // `signal` is checked eagerly — covers "already aborted before we even
  // reach fetch" (cleanup ran during the local offer/ICE phase) — and
  // threaded into `fetch` below to cover "aborted mid-POST".
  const throwIfAborted = () => {
    if (!signal?.aborted) return
    try {
      pc.close()
    } catch {
      /* ignore — mock / already-closed */
    }
    settleAttempt('aborted', {
      offerCandidates: summarizeCandidates(pc.localDescription?.sdp),
    })
    throw new DOMException('Aborted', 'AbortError')
  }
  throwIfAborted()

  // Defect-2 fix: track the MediaStream THIS connection bound to the video
  // element (if any) so `close()` below only clears `video.srcObject` when
  // it still points at this connection's stream — a superseded connection's
  // close() must not blank a NEWER connection's live video.
  let ownStream: MediaStream | null = null
  let msToFirstTrack: number | undefined
  pc.ontrack = (e) => {
    // Breadcrumb: ontrack can fire as soon as setRemoteDescription applies the
    // answer. It records first-track timing, but the ledger does not call the
    // attempt media-connected until RTCPeerConnection.connectionState does.
    log.debug('webrtc:ontrack', { streams: e.streams.length })
    // Defect-2 fix: stale ontrack race — quality A connecting, user switches
    // to B; A's ontrack can still fire (async) after A was aborted. Guard
    // against writing a dead connection's stream into the shared element.
    if (signal?.aborted) return
    ownStream = e.streams[0]
    if (video.srcObject !== e.streams[0]) {
      video.srcObject = e.streams[0]
    }
    msToFirstTrack = msToFirstTrack ?? Date.now() - attempt.startedAt
  }
  const onConnectionStateChange = () => {
    const statefulPc = pc as RTCPeerConnection & {
      connectionState?: RTCPeerConnectionState
      iceConnectionState?: RTCIceConnectionState
    }
    if (statefulPc.connectionState === 'connected') {
      settleAttempt('connected', {
        msToFirstTrack,
        offerCandidates: summarizeCandidates(pc.localDescription?.sdp),
        answerCandidates: summarizeCandidates(pc.remoteDescription?.sdp),
      })
      return
    }
    if (statefulPc.connectionState !== 'failed' && statefulPc.iceConnectionState !== 'failed') {
      return
    }
    settleAttempt('ice-failed', {
      msToFirstTrack,
      offerCandidates: summarizeCandidates(pc.localDescription?.sdp),
      answerCandidates: summarizeCandidates(pc.remoteDescription?.sdp),
    })
  }
  pc.addEventListener('connectionstatechange', onConnectionStateChange)
  pc.addEventListener('iceconnectionstatechange', onConnectionStateChange)

  // PC-LEAK FIX (iter logging): pc.close() previously ran ONLY in the
  // `!res.ok` branch, so a reject from createOffer / setLocalDescription /
  // setRemoteDescription / the fetch itself returned through the await with
  // the RTCPeerConnection (and its ICE agent + sockets) still open. Wrap the
  // whole negotiation in try/finally and close on EVERY error path.
  let succeeded = false
  try {
    // Cold path (no warmup): generate offer + gather ICE now.
    // Warm path: pc.localDescription is already populated with the
    // pre-baked host-candidate SDP — skip straight to the network
    // round-trip.
    if (!pc.localDescription) {
      let offer: RTCSessionDescriptionInit
      try {
        offer = await pc.createOffer()
        await pc.setLocalDescription(offer)
      } catch (e) {
        // Local SDP generation failed — a browser/codec fault, NOT network.
        log.error('webrtc:offer-failed', { url, ...errFields(e) })
        throw e
      }
      await iceGatheringComplete(pc)
    }
    throwIfAborted()

    const { token } = await getMediaToken('read', mediaPath)
    throwIfAborted()
    let res: Response
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/sdp',
          Authorization: `Bearer ${token}`,
        },
        body: pc.localDescription!.sdp,
        signal,
      })
    } catch (e) {
      // WHEP POST network reject (MediaMTX unreachable / offline). Distinct
      // from an HTTP error response below.
      log.error('webrtc:whep-network-fail', {
        url,
        online: typeof navigator !== 'undefined' ? navigator.onLine : null,
        ...errFields(e),
      })
      throw e
    }
    if (!res.ok) {
      const bodyText = await res.text().catch(() => '')
      // status disambiguates the failure mode: 404 → wrong/absent rung,
      // 503 → MediaMTX cold/no-publisher. Log the body TAIL only (never the
      // full SDP answer, which carries private candidate IPs).
      log.error('webrtc:whep-failed', {
        url,
        status: res.status,
        bodyTail: bodyText.slice(-200),
      })
      settleAttempt(`http-${res.status}`, {
        offerCandidates: summarizeCandidates(pc.localDescription?.sdp),
      })
      throw new Error(`WHEP ${res.status} ${bodyText}`)
    }
    const answerSdp = await res.text()
    try {
      await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp })
    } catch (e) {
      // Answer rejected — the classic transcode-rung B-frame / H264-profile
      // failure (see CLAUDE.md). Log candidate COUNTS from the answer, never
      // the SDP itself.
      log.error('webrtc:set-remote-failed', {
        url,
        answerCandidates: summarizeCandidates(answerSdp),
        ...errFields(e),
      })
      settleAttempt('set-remote-failed', {
        offerCandidates: summarizeCandidates(pc.localDescription?.sdp),
        answerCandidates: summarizeCandidates(answerSdp),
      })
      throw e
    }

    succeeded = true
    return {
      pc,
      close: () => {
        pc.removeEventListener('connectionstatechange', onConnectionStateChange)
        pc.removeEventListener('iceconnectionstatechange', onConnectionStateChange)
        settleAttempt('aborted', {
          msToFirstTrack,
          offerCandidates: summarizeCandidates(pc.localDescription?.sdp),
          answerCandidates: summarizeCandidates(pc.remoteDescription?.sdp),
        })
        pc.getReceivers().forEach((r) => r.track?.stop())
        // Defect-2 fix: only clear srcObject if it still points at THIS
        // connection's stream — closing a superseded connection must not
        // blank a newer connection's already-live video.
        if (ownStream !== null && video.srcObject === ownStream) {
          video.srcObject = null
        }
        pc.close()
      },
    }
  } finally {
    if (!succeeded) {
      if (!settled) {
        settleAttempt(signal?.aborted ? 'aborted' : 'error', {
          msToFirstTrack,
          offerCandidates: summarizeCandidates(pc.localDescription?.sdp),
          answerCandidates: summarizeCandidates(pc.remoteDescription?.sdp),
        })
      }
      pc.removeEventListener('connectionstatechange', onConnectionStateChange)
      pc.removeEventListener('iceconnectionstatechange', onConnectionStateChange)
      // Any error path above leaks the PC unless we close it here.
      try {
        pc.close()
      } catch {
        /* ignore — mock / already-closed */
      }
    }
  }
}

function iceGatheringComplete(pc: RTCPeerConnection): Promise<void> {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') return resolve()
    let done = false
    const finish = (timedOut: boolean) => {
      if (done) return
      done = true
      pc.removeEventListener('icegatheringstatechange', onChange)
      clearTimeout(timer)
      if (timedOut) {
        // THE documented cellular root cause, 100% silent until now. Hitting
        // the 2500ms cap means gathering did NOT reach `complete` — most
        // critically, if the STUN srflx candidate hasn't arrived yet, the
        // WHEP POST goes out with host-only candidates and cellular media
        // silently never connects. Log the gathering state + candidate
        // breakdown (counts only, NO IPs) so srflx-absent is greppable.
        log.warn('webrtc:ice-gathering-timeout', {
          gatheringState: pc.iceGatheringState,
          ...summarizeCandidates(pc.localDescription?.sdp),
          timeoutMs: 2500,
        })
      }
      resolve()
    }
    const onChange = () => {
      if (pc.iceGatheringState === 'complete') finish(false)
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
    const timer = setTimeout(() => finish(true), 2500)
  })
}
