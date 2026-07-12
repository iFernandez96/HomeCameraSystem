import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { drawBoxes } from '../lib/drawBoxes'
import { log, errFields } from '../lib/log'
import {
  DEFAULT_CAMERA_PATH,
  getStreamQuality,
  pathForQuality,
  resolveAutoQuality,
  setStreamQuality,
  whepUrlForPath,
  type StreamQuality,
} from '../lib/streamQuality'
import {
  advanceAdaptiveQuality,
  initialAdaptiveState,
  signalFromSnapshots,
  type InboundVideoSnapshot,
} from '../lib/adaptiveQuality'
import { connectWhep, type WhepConnection } from '../lib/webrtc'
import { subscribeEvents } from '../lib/ws'
import type { DetectionEvent } from '../lib/types'
import { OfflineState } from './states/OfflineState'
import { QualityMenu } from './QualityMenu'

type Status = 'connecting' | 'live' | 'error' | 'idle'

// Stable reference so the canvas effect's dep array can short-circuit when
// detection is paused — see comment in VideoTile.
const EMPTY_BOXES: DetectionEvent['boxes'] = []

function ControlsHost({
  target,
  controlsBottom,
  safeAreaBottom,
  dimControls,
  children,
}: {
  target?: HTMLElement | null
  controlsBottom?: string
  safeAreaBottom: boolean
  dimControls: boolean
  children: ReactNode
}) {
  if (target) {
    return createPortal(
      <div
        data-testid="video-tile-controls-below"
        className="flex w-full items-center justify-between gap-3"
      >
        {children}
      </div>,
      target,
    )
  }
  return (
    <div
      className="absolute inset-x-3 flex items-center justify-between gap-2 pointer-events-none"
      style={{
        bottom:
          controlsBottom ??
          (safeAreaBottom
            ? 'calc(0.75rem + env(safe-area-inset-bottom))'
            : '0.75rem'),
        ...(dimControls
          ? {
              opacity: 0,
              visibility: 'hidden' as const,
              transition: 'opacity 300ms ease, visibility 0ms linear 300ms',
            }
          : { opacity: 1, transition: 'opacity 300ms ease' }),
      }}
    >
      {children}
    </div>
  )
}

export function VideoTile({
  src,
  detectionActive = null,
  workerAlive = null,
  lowMemory = null,
  thermal = null,
  detectionFrameAgeSeconds = null,
  fit = 'cover',
  showStatusPill = true,
  onPlayingChange,
  actions,
  showFullscreenButton = true,
  showQualityMenu = true,
  showBoxToggle = true,
  safeAreaBottom = false,
  controlsBottom,
  dimControls = false,
  streamPath = DEFAULT_CAMERA_PATH,
  controlsTarget,
}: {
  /**
   * Optional explicit WHEP URL override. When omitted, the tile composes
   * its own URL from the user's chosen stream quality (cellular-adaptive
   * streaming, 2026-06-16). Live no longer passes this — the quality
   * control inside the tile owns the URL — but it's kept as an override
   * for tests and any future multi-cam wiring.
   */
  src?: string
  /**
   * Whether the server is currently emitting detection events. `null` means
   * "unknown" (status hasn't loaded yet) and is treated like `true` to avoid
   * a flash of "PAUSED" before the first /api/status response.
   */
  detectionActive?: boolean | null
  /**
   * Whether the host-side detection worker has heartbeat'd recently. `null`
   * is "unknown" (treated like `true`). When `false`, the amber "Detection
   * paused" pill takes precedence over the PAUSED pill — NOT an "offline"
   * claim (status-truth fix, 2026-07-07): the worker dying doesn't mean the
   * camera/video path is down, so this never renders red "Camera offline"
   * copy while `status === 'live'`.
   */
  workerAlive?: boolean | null
  /**
   * Whether the worker has tripped its memory guard and is currently
   * skipping inference (gear === 'low-memory'). `null` is "unknown"
   * (treated as false). When true, the LOW MEMORY pill takes precedence
   * over PAUSED but not over OFFLINE — the user should know inference is
   * paused for system-pressure reasons even if they didn't toggle it.
   */
  lowMemory?: boolean | null
  /**
   * Whether the worker is in thermal-throttled mode (gear ===
   * 'thermal-throttled', iter-89). Yellow severity — inference is
   * still running but at a reduced rate to give the GPU thermal
   * headroom. Pill ladder precedence:
   * OFFLINE > LOW MEMORY > THERMAL > PAUSED.
   */
  thermal?: boolean | null
  /**
   * iter-302: seconds since the worker's last successful Capture()
   * (from `/api/status.seconds_since_last_frame`). null = unknown
   * or worker hasn't reported a frame yet. The iter-300 outage had
   * worker_alive=true while this would have climbed to 50,000 —
   * This measures the detector's RTSP intake, not WebRTC playback.
   * When it exceeds ~60s, warn that detection is stalled while the
   * independently confirmed live video remains visible.
   */
  detectionFrameAgeSeconds?: number | null
  /**
   * Structural overhaul (Watch): how the <video> fills the tile.
   * 'cover' (default) crops to fill — right when the WRAPPER owns a
   * 16:9 aspect box (docked Watch viewport). 'contain' letterboxes —
   * right in the full-bleed portrait mode where cropping a security
   * feed would hide the edges of the scene.
   */
  fit?: 'cover' | 'contain'
  /**
   * Fuzz F3/F7/F13 (docked/fullscreen chrome consolidation, Watch.tsx):
   * the tile's own connection-status pill ("Live"/"Connecting"/
   * "Offline", top-3 left-3) is the ONE status pill Watch wants
   * docked. In fullscreen Watch already renders a combined
   * "{armed state} · {camera}" cluster plus the scrubber's red LIVE
   * pill, so this tile's pill would be a third, redundant "Live"
   * label crowding the back chevron (fuzz F7). Default true so
   * every other VideoTile consumer (tests, future multi-cam) keeps
   * the pill unless it opts out.
   */
  showStatusPill?: boolean
  /**
   * Status-truth fix (server-restart contradiction, 2026-07-07): fires
   * `true` the moment this tile confirms real frames flowing (status ->
   * 'live') and `false` the moment it confirms the WHEP path itself
   * failed (status -> 'error'). Deliberately NOT called for
   * 'idle'/'connecting' — a caller (Watch's glance card) needs to tell
   * "confirmed not playing" apart from "hasn't resolved yet", so it
   * default-inits its own local state to unknown (null) rather than
   * treating "no callback yet" as a negative. This is a thin read of
   * state this component already computes — no new connection logic.
   */
  onPlayingChange?: (playing: boolean) => void
  /**
   * Control-overlap fix (docked live tile, 2026-07-07): the docked
   * corner used to have TWO owners independently absolute-positioning
   * over the same bottom-right corner — this tile's own bbox-toggle +
   * fullscreen buttons, and Watch.tsx's own Snapshot + CSS-expand
   * overlay on top of them. VideoTile is now the single owner of that
   * corner: it renders one flex row and callers slot their own
   * buttons in via `actions`, rendered between the bbox toggle and
   * the fullscreen button. `undefined` (the default) renders nothing
   * extra — every other VideoTile consumer is unaffected.
   */
  actions?: ReactNode
  /**
   * Control-overlap fix: Watch.tsx owns a single canonical fullscreen
   * affordance (its CSS docked↔full state toggle, which preserves the
   * WebRTC element and carries the scrubber) and doesn't want this
   * tile's separate native-Fullscreen-API button competing with it.
   * Default true so standalone consumers (tests, future multi-cam)
   * keep the button unless they opt out.
   */
  showFullscreenButton?: boolean
  /** Hide advanced stream-quality chrome when a compact caller owns it. */
  showQualityMenu?: boolean
  /** Hide the bbox toggle and its teaching hint in compact/docked views. */
  showBoxToggle?: boolean
  /**
   * Add the viewport's bottom safe-area inset to the control row's
   * offset. Only correct when the tile's bottom edge sits on the
   * viewport's bottom edge (fullscreen); leave false for a docked
   * mid-page tile or the row drifts when mobile browsers re-report
   * the inset on toolbar collapse / app resume.
   */
  safeAreaBottom?: boolean
  /**
   * Full override for the control row's bottom offset (CSS length).
   * Watch's fullscreen mode passes a value that clears its hour
   * scrubber overlay; when set it wins over `safeAreaBottom`.
   */
  controlsBottom?: string
  /**
   * Fade out the control row (quality pill + toggles) — the page's
   * fullscreen chrome auto-hide drives this so the tile's own
   * controls disappear together with the page-owned overlays.
   * `visibility: hidden` rides along after the fade so hidden
   * controls can't eat taps.
   */
  dimControls?: boolean
  /**
   * Multicam contract (docs/multicam_contract.md, 2026-07-07): the
   * selected camera's MediaMTX base path from the registry
   * (`Camera.path`). The quality tiers derive their rungs from it
   * (`<path>` / `<path>_lq` / `<path>_uq`). Defaults to `cam` — the
   * single-camera registry default — so every existing consumer
   * composes byte-identical URLs. Changing it recomputes
   * `effectiveSrc`, which re-runs the connect effect (same teardown/
   * reconnect path a quality switch uses).
   */
  streamPath?: string
  /** Optional docked toolbar target; controls render there instead of over video. */
  controlsTarget?: HTMLElement | null
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [status, setStatus] = useState<Status>('idle')
  // iter-246: user-toggleable bbox overlay. Default ON (the boxes
  // are the whole point of detection feedback). Persists in
  // localStorage so the user's choice survives reloads + PWA tab
  // re-mounts.
  const [boxesVisible, setBoxesVisible] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true
    const stored = window.localStorage.getItem('homecam:boxesVisible')
    return stored === null ? true : stored === '1'
  })
  useEffect(() => {
    if (typeof window === 'undefined' || !showBoxToggle) return
    window.localStorage.setItem('homecam:boxesVisible', boxesVisible ? '1' : '0')
  }, [boxesVisible, showBoxToggle])
  // Painfix wave B #2: the bbox-toggle button is glyph-only — its
  // meaning lives entirely in the aria-label, which a sighted mouse/
  // touch user never hears. A transient text hint teaches the icon on
  // first sight without permanently cluttering the video chrome.
  // Counted via localStorage (persists across mounts/reloads) so it
  // shows on the first TWO times this tile renders with the button
  // available, then never again.
  const [boxHintViewCount] = useState<number>(() => {
    if (typeof window === 'undefined') return 2
    return Number(window.localStorage.getItem('homecam:bboxHintViews') ?? '0')
  })
  useEffect(() => {
    if (typeof window === 'undefined' || !showBoxToggle) return
    if (boxHintViewCount >= 2) return
    window.localStorage.setItem('homecam:bboxHintViews', String(boxHintViewCount + 1))
  }, [showBoxToggle, boxHintViewCount])
  const [showBoxHint, setShowBoxHint] = useState(() => boxHintViewCount < 2)
  useEffect(() => {
    if (!showBoxToggle || !showBoxHint) return
    // Auto-hides on a timer regardless of prefers-reduced-motion — only
    // the FADE is skipped for reduced-motion users (via the
    // motion-reduce:transition-none class below), not the hide itself.
    const t = setTimeout(() => setShowBoxHint(false), 4000)
    return () => clearTimeout(t)
  }, [showBoxHint, showBoxToggle])
  const [boxes, setBoxes] = useState<DetectionEvent['boxes']>([])
  const [personName, setPersonName] = useState<string | null>(null)
  const [retryNonce, setRetryNonce] = useState(0)
  // Cellular-adaptive streaming (2026-06-16): the user picks a stream
  // tier (Auto / HQ / Data-saver / Ultra-low). `auto` reads
  // navigator.connection and downshifts on cellular/metered links. The
  // choice persists in localStorage and drives the WHEP path. Changing
  // it recomputes `effectiveSrc`, whose change re-runs the connect
  // effect (same dep that manual Retry's `retryNonce` bump relies on),
  // tearing down the old PeerConnection and connecting to the new path.
  const [quality, setQuality] = useState<StreamQuality>(() => getStreamQuality())
  const initialAutoQuality = resolveAutoQuality(
    typeof navigator === 'undefined'
      ? undefined
      : (navigator as Navigator & { connection?: Parameters<typeof resolveAutoQuality>[0] }).connection,
  )
  const [autoQuality, setAutoQuality] = useState(initialAutoQuality)
  const adaptiveStateRef = useRef(initialAdaptiveState(initialAutoQuality))
  const activePcRef = useRef<RTCPeerConnection | null>(null)
  // `src` override (tests / future multi-cam wiring) wins; otherwise the
  // tile composes its own URL from the chosen quality.
  const effectiveQuality = quality === 'auto' ? autoQuality : quality
  const effectiveSrc = src ?? whepUrlForPath(pathForQuality(effectiveQuality, undefined, streamPath))
  // Keep the latest quality in a ref so the connect effect can LOG it
  // without taking it as a reactive dependency. The effect re-runs on
  // `effectiveSrc` (which already changes in lockstep with quality in the
  // cellular case); making quality a dep would force a redundant reconnect
  // when a `src` override is supplied. The ref always reads current.
  const qualityRef = useRef(quality)
  const activeWhepAbortRef = useRef<AbortController | null>(null)
  // Sync the ref in an effect (NOT during render — react-hooks/refs) so the
  // connect effect can log the current quality without a reactive dep.
  useEffect(() => {
    qualityRef.current = quality
  }, [quality])
  const onSelectQuality = (q: StreamQuality) => {
    if (q === qualityRef.current) return
    activeWhepAbortRef.current?.abort()
    if (q === 'auto') {
      const base = resolveAutoQuality(
        (navigator as Navigator & { connection?: Parameters<typeof resolveAutoQuality>[0] }).connection,
      )
      adaptiveStateRef.current = initialAdaptiveState(base)
      setAutoQuality(base)
    }
    setStreamQuality(q)
    setQuality(q)
  }
  useEffect(() => {
    if (quality !== 'auto' || typeof navigator === 'undefined') return
    const connection = (navigator as Navigator & {
      connection?: Parameters<typeof resolveAutoQuality>[0] & EventTarget
    }).connection
    if (connection == null || typeof connection.addEventListener !== 'function') return
    const onConnectionChange = () => {
      const base = resolveAutoQuality(connection)
      adaptiveStateRef.current = initialAdaptiveState(base)
      setAutoQuality(base)
    }
    connection.addEventListener('change', onConnectionChange)
    return () => connection.removeEventListener('change', onConnectionChange)
  }, [quality])
  // Status-truth fix (server-restart contradiction, 2026-07-07):
  // `cameraOffline` and `detectionPausedWorker` used to be TWO pills
  // keyed on whether the server had ever cached a frame counter — but
  // both only render once `status === 'live'` (see the pill JSX
  // below), meaning real frames ARE flowing through the separate
  // MediaMTX/WebRTC pipeline at the exact moment the old
  // `cameraOffline` branch said "Camera offline. Restart the camera
  // service." — a live-caught user-reported contradiction. The
  // detection worker dying does not mean the CAMERA is down (they're
  // different processes); collapsed into one honest `workerDead`
  // state with amber, no-action-implied copy. "Camera offline" red
  // copy is reserved for when the VIDEO path itself is confirmed dead
  // (status === 'error', the OfflineState overlay further below).
  // A stale detector frame means the worker's intake is stuck. It does
  // not mean this component's separately observed WebRTC video is stuck.
  const workerDead = workerAlive === false
  const detectionFeedStalled =
    workerAlive === true &&
    detectionFrameAgeSeconds !== null &&
    detectionFrameAgeSeconds !== undefined &&
    detectionFrameAgeSeconds > 60
  // Clear boxes whenever detection cannot produce fresh results; stale
  // overlays must never remain painted over an otherwise-live feed.
  const detectionUnavailable = workerDead || detectionFeedStalled
  const offline = detectionUnavailable
  const lowMem = !offline && lowMemory === true
  const therm = !offline && !lowMem && thermal === true
  const paused =
    !offline && !lowMem && !therm && detectionActive === false

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    let conn: WhepConnection | null = null
    let cancelled = false
    // Defect-1 fix (WebRTC lifecycle audit): a per-attempt AbortController
    // so cleanup can actually close an in-flight connectWhep — the old
    // `cancelled` flag alone left a hung WHEP POST's RTCPeerConnection open
    // (nothing to close: `conn` is still null while the fetch is pending).
    // Abort any still-active attempt before this one supersedes it. React's
    // passive-effect cleanup also aborts below, but quality/retry transitions
    // need the old POST cancelled before the replacement attempt can start.
    activeWhepAbortRef.current?.abort()
    const controller = new AbortController()
    activeWhepAbortRef.current = controller
    // iter-174: <video>-element-level error / stall observability,
    // companion to iter-162's `connectionstatechange` listener on the
    // peer connection. The pc transitions only on negotiation-layer
    // events; the <video> element fires its own `error` / `stalled` /
    // `waiting` / `playing` events when the codec freezes or the
    // browser's playback buffer drains. Pre-iter-174, those went
    // unobserved — frozen frame + LIVE pill pulsing was still possible
    // even with iter-162 in place. Stall-debounce is 3 s because
    // browsers fire `stalled` / `waiting` aggressively during normal
    // buffer fills; flipping to error too fast would be jumpy on a
    // healthy connection. `playing` cancels the pending error so a
    // recovered stall doesn't surface a false negative.
    let stallTimer: ReturnType<typeof setTimeout> | null = null
    // iter-177: hoist the iter-162 connectionstatechange listener
    // reference to effect scope so cleanup can explicitly
    // `removeEventListener` it. Pre-iter-177 cleanup relied on
    // `pc.close()` to invalidate the listener — correct today but
    // fragile if the close is ever deferred or skipped (e.g. for
    // transition reuse). Defense-in-depth, ~3 lines.
    let pcStateChange: (() => void) | null = null
    // docs/logging_plan.md §2 (Live view): the four mid-stream error
    // paths (videoError / 3s stall / 8s media-timeout / pcState
    // failed-disconnected-closed) were 100% silent — the most
    // user-visible Live failure class with zero signal. Each logs the
    // express cause + the WebRTC connectionState + iceConnectionState
    // so an operator can tell a codec freeze from an ICE drop. Shared
    // helper reads the live pc off `conn` (null until WHEP resolves).
    const midStreamFail = (cause: string, extra: Record<string, unknown> = {}) => {
      log.warn('videoTile:mid-stream-error', {
        cause,
        quality: qualityRef.current,
        effectiveSrc,
        retryNonce,
        connectionState: conn?.pc.connectionState ?? null,
        iceConnectionState: conn?.pc.iceConnectionState ?? null,
        online: typeof navigator !== 'undefined' ? navigator.onLine : null,
        ...extra,
      })
    }
    const rvfcVideo = video as HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: () => void) => number
      cancelVideoFrameCallback?: (id: number) => void
    }
    const supportsRvfc = typeof rvfcVideo.requestVideoFrameCallback === 'function'
    let rvfcId: number | null = null
    const armFrameCallback = () => {
      if (!supportsRvfc || rvfcId !== null) return
      rvfcId = rvfcVideo.requestVideoFrameCallback?.(() => {
        rvfcId = null
        markLive()
      }) ?? null
    }
    const onVideoError = () => {
      // Log BEFORE the cancelled guard (§1.3) so a failure during
      // unmount is still recorded. The <video> error event carries the
      // MediaError code on the element when present.
      const code = videoRef.current?.error?.code ?? null
      midStreamFail('video-element-error', { mediaErrorCode: code })
      if (cancelled) return
      setStatus('error')
    }
    const onStallOrWaiting = () => {
      if (cancelled || stallTimer !== null) return
      // rVFC is one-shot. After a mid-stream stall, re-arm it so the
      // recovery Live signal is again a presented frame, not just 'playing'.
      armFrameCallback()
      stallTimer = setTimeout(() => {
        stallTimer = null
        midStreamFail('stall-3s')
        if (!cancelled) setStatus('error')
      }, 3000)
    }
    // iter-244d: gate 'live' on actual frames flowing, not on the WHEP
    // signaling handshake. Pre-iter-244d, status flipped to 'live' as
    // soon as `connectWhep` resolved (SDP exchange complete) — but
    // ICE/media could still fail (e.g., phone-on-tailnet → Jetson UDP
    // candidate not reachable) and the user saw a pulsing LIVE pill
    // with no actual video.
    // Overhaul follow-up (2026-07-07, user screenshot): pc
    // `connectionState === 'connected'` used to also mark live, but ICE
    // connects seconds before the first decodable keyframe arrives (the
    // encoder GOP is ~4 s), so the pill said "Live" over a pure black
    // box. 'live' now requires a real frame signal — the <video>
    // element's `playing`/`loadeddata` event or a presented frame via
    // requestVideoFrameCallback. The pc listener below only handles
    // FAILURE states. The `mediaTimer` fallback flips to 'error' if no
    // frame arrives within 8 s of WHEP resolve so the user gets a Retry
    // button instead of staring at a frozen 'connecting' state forever.
    let mediaTimer: ReturnType<typeof setTimeout> | null = null
    const markLive = () => {
      if (cancelled) return
      if (mediaTimer !== null) {
        clearTimeout(mediaTimer)
        mediaTimer = null
      }
      // Frames are flowing again — re-arm the one-shot silent reconnect
      // for the next mid-stream drop (see pcStateChange below).
      silentRetryUsedRef.current = false
      setStatus('live')
    }
    const onPlaying = () => {
      if (stallTimer !== null) {
        clearTimeout(stallTimer)
        stallTimer = null
      }
      // Real camera measurement on the ~4 s GOP stream showed 'playing'
      // firing ~2.1 s before first decoded frame. Use it only as the
      // no-rVFC fallback; rVFC/loadeddata remain frame-truth signals.
      if (!supportsRvfc) markLive()
    }
    const onFirstFrameDecoded = () => markLive()
    // Frame-presentation truth where the API exists (Chrome/Safari, and
    // Firefox 130+): fires only after a frame actually hit the screen,
    // which is the exact thing the pill is promising.
    armFrameCallback()
    video.addEventListener('error', onVideoError)
    video.addEventListener('stalled', onStallOrWaiting)
    video.addEventListener('waiting', onStallOrWaiting)
    video.addEventListener('playing', onPlaying)
    video.addEventListener('loadeddata', onFirstFrameDecoded)
    setStatus('connecting')
    connectWhep(effectiveSrc, video, { signal: controller.signal })
      .then((c) => {
        if (cancelled) {
          c.close()
          return
        }
        conn = c
        activePcRef.current = c.pc
        // Stay 'connecting' until media starts. The 8 s media-timeout
        // covers the case where WHEP signaling succeeds but ICE never
        // produces a usable path (typical when the SDP advertises a
        // candidate the client can't reach).
        mediaTimer = setTimeout(() => {
          mediaTimer = null
          // WHEP signaling resolved but no frames in 8s — almost always
          // ICE produced no usable path (the documented cellular /
          // unreachable-candidate failure). The ice state is the tell.
          midStreamFail('media-timeout-8s')
          if (!cancelled) setStatus('error')
        }, 8000)
        // Mid-stream connection observability (iter-162). Without this, a
        // MediaMTX restart, Wi-Fi blip, or NVENC stall leaves the user
        // staring at a frozen frame while the LIVE pill keeps pulsing —
        // status only changed on the initial handshake. Surfacing the
        // error state lets the existing Retry button (which bumps
        // retryNonce and re-runs this effect) be the recovery path.
        // We don't auto-retry: a persistent network outage would loop
        // tightly, and the WebRTC spec lets 'disconnected' transition
        // back to 'connected' on its own — manual recovery is the right
        // bound for now.
        pcStateChange = () => {
          if (cancelled) return
          const s = c.pc.connectionState
          // 'connected' deliberately does NOT mark live — ICE up is not
          // frames on screen (see the frame-gating comment above). The
          // listener exists for mid-stream FAILURE observability only.
          if (s === 'failed' || s === 'disconnected' || s === 'closed') {
            midStreamFail('pc-state-' + s)
            // Resume-drop fix (2026-07-07, user report): backgrounding
            // the tab kills the transport, and the failure lands a beat
            // AFTER the resume visibilitychange (which only reconnects
            // when status is ALREADY 'error'), so every app switch
            // ended at the manual-Retry screen. One SILENT reconnect
            // per live episode: bounded (the flag re-arms only after
            // real frames flow again, so a dead server goes
            // retry → connect fails → error, no loop), and gated on the
            // tab being visible (a hidden tab can't win — the existing
            // resume handler owns that case). Manual-Retry-only stays
            // the rule for everything past this single attempt.
            if (
              !silentRetryUsedRef.current &&
              document.visibilityState === 'visible'
            ) {
              silentRetryUsedRef.current = true
              setRetryNonce((n) => n + 1)
              return
            }
            setStatus('error')
          }
        }
        c.pc.addEventListener('connectionstatechange', pcStateChange)
      })
      .catch((e) => {
        // Defect-1 fix: cleanup now aborts the in-flight attempt (see
        // `controller.abort()` below), so a `cancelled` rejection here is
        // an EXPECTED teardown, not a real failure — skip both the log
        // noise and the error-state flip. Any other rejection (a genuine
        // WHEP failure) still logs the express cause + identifying ids
        // (quality / effectiveSrc / retryNonce) so the operator can
        // correlate which rung + which retry failed. errFields pulls the
        // status off an HttpError-shaped reject if present.
        if (cancelled) return
        log.error('videoTile:whep-connect-failed', {
          quality: qualityRef.current,
          effectiveSrc,
          retryNonce,
          online: typeof navigator !== 'undefined' ? navigator.onLine : null,
          ...errFields(e),
        })
        setStatus('error')
      })
    return () => {
      cancelled = true
      // Defect-1 fix: actually close an in-flight connectWhep. Pre-fix,
      // `conn` was still null while the WHEP POST was pending, so nothing
      // closed the pc — a hung request leaked it, and rapid rung changes
      // (e.g. quality switches) could stack several open PeerConnections.
      controller.abort()
      if (activeWhepAbortRef.current === controller) {
        activeWhepAbortRef.current = null
      }
      if (stallTimer !== null) {
        clearTimeout(stallTimer)
        stallTimer = null
      }
      if (mediaTimer !== null) {
        clearTimeout(mediaTimer)
        mediaTimer = null
      }
      video.removeEventListener('error', onVideoError)
      video.removeEventListener('stalled', onStallOrWaiting)
      video.removeEventListener('waiting', onStallOrWaiting)
      video.removeEventListener('playing', onPlaying)
      video.removeEventListener('loadeddata', onFirstFrameDecoded)
      if (rvfcId !== null && typeof rvfcVideo.cancelVideoFrameCallback === 'function') {
        rvfcVideo.cancelVideoFrameCallback(rvfcId)
        rvfcId = null
      }
      // iter-177: explicit cleanup of the iter-162 pc listener.
      // `conn?.close()` below already invalidates it, but removing
      // first means a defer/skip of close (transition reuse, etc.)
      // can't leak the listener.
      if (conn !== null && pcStateChange !== null) {
        conn.pc.removeEventListener('connectionstatechange', pcStateChange)
        pcStateChange = null
      }
      conn?.close()
      if (activePcRef.current === conn?.pc) activePcRef.current = null
    }
  }, [effectiveSrc, retryNonce])

  useEffect(() => {
    if (quality !== 'auto' || src != null || status !== 'live') return
    const pc = activePcRef.current
    if (pc == null || typeof pc.getStats !== 'function') return
    let cancelled = false
    let previous: InboundVideoSnapshot | null = null

    const sample = async () => {
      try {
        const report = await pc.getStats()
        if (cancelled) return
        let current: InboundVideoSnapshot | null = null
        report.forEach((item) => {
          if (item.type !== 'inbound-rtp' || item.kind !== 'video') return
          current = {
            packetsLost: Number(item.packetsLost ?? 0),
            packetsReceived: Number(item.packetsReceived ?? 0),
            jitterSeconds: Number(item.jitter ?? 0),
            framesDropped: Number(item.framesDropped ?? 0),
            framesDecoded: Number(item.framesDecoded ?? 0),
            freezeCount: Number(item.freezeCount ?? 0),
          }
        })
        if (current == null) return
        if (previous != null) {
          const signal = signalFromSnapshots(previous, current)
          if (signal != null) {
            const next = advanceAdaptiveQuality(adaptiveStateRef.current, signal, Date.now())
            adaptiveStateRef.current = next
            setAutoQuality((active) => active === next.quality ? active : next.quality)
          }
        }
        previous = current
      } catch (error) {
        log.debug('videoTile:adaptive-stats-unavailable', errFields(error))
      }
    }
    const timer = window.setInterval(() => { void sample() }, 5_000)
    void sample()
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [quality, src, status])

  useEffect(() => {
    return subscribeEvents((evt) => {
      if (evt.type === 'live_detection') {
        setBoxes(evt.boxes)
        setPersonName(null)
      } else if (evt.type === 'detection') {
        setBoxes(evt.boxes)
        setPersonName(evt.person_name ?? null)
      }
    })
  }, [])

  // Status-truth fix: tell the caller when we've CONFIRMED frames are
  // (or aren't) flowing. Only 'live'/'error' are confirmations —
  // 'idle'/'connecting' say nothing yet, so we stay silent rather than
  // report a false negative while a fresh connect attempt is still in
  // flight.
  useEffect(() => {
    if (status === 'live') onPlayingChange?.(true)
    else if (status === 'error') onPlayingChange?.(false)
  }, [status, onPlayingChange])

  // iter-277 (functionality-auditor #3): when the user comes back to
  // a tab that's been backgrounded long enough for the iter-244d
  // 8 s media-timeout to have fired, auto-retry the WHEP handshake
  // instead of leaving them staring at the "We can't reach your
  // camera" error screen. The timer ticks while the tab is hidden
  // (browsers throttle but don't pause setTimeout), so a phone that
  // was backgrounded for 30 s + the iter-? video-element-pauses-on-
  // hidden behavior together flip status to 'error' silently. This
  // listener does NOT auto-retry while still 'connecting' or 'live'
  // — those states are recoverable on their own. Mirrors the iter-
  // 158 ConnectionBanner pattern (visibility-aware reconnect)
  // documented in CLAUDE.md sharp edges.
  //
  // We also reset on `online` so a Wi-Fi → cellular swap (or vice
  // versa) recovers without manual tap.
  // Defect-4 fix (WebRTC lifecycle audit): mobile resume can fire
  // `visibilitychange` AND `online` back-to-back in the same JS turn (phone
  // unlocks + radio reassociates at once) while status is still 'error' in
  // both handlers' closures — pre-fix each bumped `retryNonce`
  // independently, so one resume produced TWO concurrent WHEP attempts
  // (feeding defect 1's leak surface). `resumeInFlightRef` coalesces both
  // signals through one guarded requestReconnect(): the first caller wins,
  // the second is a no-op until the ref is cleared (which happens once
  // `status` leaves 'error' — i.e. the coalesced attempt actually started).
  // Manual-retry-only semantics are preserved: one resume, at most one new
  // attempt, never a retry loop.
  const resumeInFlightRef = useRef(false)
  // One-shot guard for the silent mid-stream reconnect (see
  // pcStateChange): true = this live episode already spent its free
  // retry; re-armed only by markLive (real frames).
  const silentRetryUsedRef = useRef(false)
  useEffect(() => {
    if (status !== 'error') {
      resumeInFlightRef.current = false
    }
  }, [status])
  useEffect(() => {
    const requestReconnect = () => {
      if (status !== 'error') return
      if (resumeInFlightRef.current) return
      resumeInFlightRef.current = true
      setRetryNonce((n) => n + 1)
    }
    const onVisible = () => {
      if (document.visibilityState === 'visible') requestReconnect()
    }
    const onOnline = () => {
      requestReconnect()
    }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('online', onOnline)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('online', onOnline)
    }
  }, [status])

  // When detection is paused or the worker is offline, the server stops
  // broadcasting events but we may still have the last set of boxes in
  // state. Hide them at render time via a stable empty-array reference so
  // the canvas effect re-runs once and clears the overlay. (Setting state
  // from inside an effect trips the react-hooks/set-state-in-effect rule.)
  const visibleBoxes =
    paused || offline || lowMem || !boxesVisible ? EMPTY_BOXES : boxes
  const visibleName = paused || offline || lowMem || !boxesVisible ? null : personName

  useEffect(() => {
    const canvas = canvasRef.current
    const video = videoRef.current
    if (!canvas || !video) return
    const ctx = canvas.getContext('2d')

    // Bail in jsdom (where 2D context isn't implemented). The
    // ResizeObserver setup below still runs so tests can assert on
    // its lifecycle.
    const draw = () => {
      if (!ctx) return
      drawBoxes(ctx, canvas, video, visibleBoxes, visibleName)
    }
    draw()

    // Re-draw on viewport / video resize. Without this, rotating a phone
    // or resizing the window leaves boxes scaled to the previous
    // dimensions until the next detection event arrives — a multi-second
    // visible misalignment at the default 5 s detect cooldown.
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(draw)
    observer.observe(video)
    return () => observer.disconnect()
  }, [visibleBoxes, visibleName])

  // iter-244c: fullscreen toggle. Prefer container (bbox overlay
  // scales); fall back to the <video> element on iOS Safari, which
  // only supports webkitEnterFullscreen on media elements (overlay
  // lost there but video kept).
  //
  // iter-244d: actual TOGGLE (enter ↔ exit). Pre-iter-244d the
  // button only entered; pressing in fullscreen was a no-op
  // (browsers reject double-request). User-reported: "The icon to
  // get out of full-screen is not working." Now reads
  // `document.fullscreenElement` and routes to `exitFullscreen` when
  // already fullscreen.
  const [isFullscreen, setIsFullscreen] = useState(false)
  useEffect(() => {
    // iter-244e: also lock orientation to landscape on fullscreen
    // entry, restore portrait on exit. Phone-in-portrait → landscape
    // video is the natural mobile-first flow (camera frames are
    // 16:9). Screen Orientation API only works while in fullscreen
    // (browser security model), so we hook the lock/unlock here.
    // Chromium-based mobile (Android Chrome) supports it; iOS Safari
    // doesn't — `.lock()` rejects, we swallow the error and the user
    // just sees the unrotated fullscreen.
    const onChange = () => {
      const fs = document.fullscreenElement != null
      setIsFullscreen(fs)
      const so = screen.orientation as
        | (ScreenOrientation & { lock?: (o: string) => Promise<void> })
        | undefined
      if (fs) {
        // docs/logging_plan.md §2 (Live view): orientation-lock
        // fallback DEBUG. iOS Safari rejects screen.orientation.lock;
        // the swallow is intentional but a DEBUG breadcrumb makes an
        // unexpectedly-always-failing lock diagnosable under triage.
        so?.lock?.('landscape').catch((e) =>
          log.debug('videoTile:orientation-lock-failed', errFields(e)),
        )
      } else {
        so?.unlock?.()
      }
    }
    document.addEventListener('fullscreenchange', onChange)
    // iter-356.x (mobile audit C3): iOS Safari's webkitEnterFullscreen
    // uses the native player instead of the standard fullscreen API.
    // The standard `fullscreenchange` event never fires when iOS exits,
    // leaving `isFullscreen` stuck at true and the toggle button stuck
    // showing the "exit" icon. Bind to the webkit-specific events on
    // the <video> element so state stays in sync.
    const v = videoRef.current
    const onWebkitBegin = () => setIsFullscreen(true)
    const onWebkitEnd = () => setIsFullscreen(false)
    v?.addEventListener('webkitbeginfullscreen', onWebkitBegin)
    v?.addEventListener('webkitendfullscreen', onWebkitEnd)
    return () => {
      document.removeEventListener('fullscreenchange', onChange)
      v?.removeEventListener('webkitbeginfullscreen', onWebkitBegin)
      v?.removeEventListener('webkitendfullscreen', onWebkitEnd)
    }
  }, [])

  const onFullscreen = () => {
    if (document.fullscreenElement != null) {
      // docs/logging_plan.md §2 (Live view): fullscreen fallbacks DEBUG.
      document.exitFullscreen?.().catch((e) =>
        log.debug('videoTile:exit-fullscreen-failed', errFields(e)),
      )
      return
    }
    const container = containerRef.current
    if (container && container.requestFullscreen) {
      container.requestFullscreen().catch((e) => {
        log.debug('videoTile:container-fullscreen-failed', errFields(e))
        videoRef.current
          ?.requestFullscreen?.()
          .catch((e2) => {
            log.debug('videoTile:video-fullscreen-failed', errFields(e2))
            const v = videoRef.current as
              | (HTMLVideoElement & { webkitEnterFullscreen?: () => void })
              | null
            v?.webkitEnterFullscreen?.()
          })
      })
      return
    }
    const v = videoRef.current as
      | (HTMLVideoElement & { webkitEnterFullscreen?: () => void })
      | null
    v?.webkitEnterFullscreen?.()
  }

  return (
    <div
      ref={containerRef}
      // Sunroom redesign (2026-07-01): the video field stays black —
      // the frame's chrome gets the paper-card treatment (warm shadow +
      // strong border) so the tile reads as a framed window on the
      // linen page rather than a floating dark slab.
      // Structural overhaul (Watch home): the tile is FLUSH — no
      // rounding/border/shadow, fills whatever box the parent gives
      // it. The old card chrome belonged to the retired Live page
      // grid; on Watch the video is the screen's top edge.
      className="relative w-full h-full bg-black overflow-hidden"
    >
      <video
        ref={videoRef}
        className={`w-full h-full ${fit === 'contain' ? 'object-contain' : 'object-cover'}`}
        autoPlay
        playsInline
        muted
        aria-label="Live camera feed"
      />
      <canvas ref={canvasRef} className="absolute inset-0 pointer-events-none" />
      {/* First-frame gap treatment (2026-07-07, user screenshot): while
          WHEP negotiates and the encoder walks to the next keyframe
          (~4 s GOP) the video field used to be raw black under a "Live"
          pill — read as broken. The pill now stays "Connecting" until a
          real frame renders (see the frame-gating effect), and this
          shimmer makes the wait read as deliberate. Video field is
          always black regardless of theme, so white-alpha tones are
          safe. Removed from the DOM the moment frames flow. */}
      {status === 'connecting' && (
        <div className="absolute inset-0 pointer-events-none" aria-hidden="true">
          <div className="absolute inset-0 bg-white/[0.04] animate-pulse" />
          <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 flex justify-center">
            <span className="w-10 h-10 rounded-full border-[1.5px] border-white/15 border-t-white/50 animate-spin motion-reduce:animate-none" />
          </div>
        </div>
      )}
      {showStatusPill && <StatusPill status={status} />}
      {/* Control-overlap fix (2026-07-07): single-owner flex row for
          the docked corner. Was three independently absolute-
          positioned pieces (bbox hint at right-28, bbox toggle at
          right-16, fullscreen button at right-3, all duplicating the
          same bottom safe-area calc) — the layering rule was implicit
          in three separate `right-N` magic numbers, easy to collide
          with a caller's own overlay (Watch.tsx did exactly that).
          Now ONE positioned row; every child is a plain flex item, so
          new slots (like `actions`) just take their place in the row
          instead of guessing an unclaimed `right-N`.
          Baseline fix (2026-07-07, user screenshot): the quality pill
          used to sit in its own `bottom-3 left-3` box while this row
          carried the safe-area calc — on a phone with a gesture bar
          the two clusters rode different baselines. The quality menu
          now lives in the SAME row (justify-between pushes it left),
          so every bottom overlay shares one baseline in docked AND
          fullscreen modes. The row itself is pointer-events-none so
          the strip between the clusters doesn't swallow touches.
          Safe-area gating (2026-07-07, user report "buttons move
          upwards when I leave and come back"): env(safe-area-inset-
          bottom) is a VIEWPORT inset — mid-page it must be zero for
          this row, but Firefox Android re-reports a nonzero inset when
          its dynamic toolbar collapses on app resume, floating the row
          up the tile by the gesture-bar height. The inset only makes
          sense when the tile's bottom edge IS the viewport's bottom
          edge, so the page opts in via `safeAreaBottom` (Watch passes
          its fullscreen state). Docked: plain 0.75rem, immune to
          toolbar/visibility churn. */}
      <ControlsHost
        target={controlsTarget}
        controlsBottom={controlsBottom}
        safeAreaBottom={safeAreaBottom}
        dimControls={dimControls}
      >
        {showQualityMenu && (
          <div className={controlsTarget ? 'flex flex-1 justify-center pointer-events-auto' : 'pointer-events-auto'}>
            <QualityMenu quality={quality} onSelect={onSelectQuality} />
          </div>
        )}
        <div className={`flex items-center gap-2 pointer-events-auto ${controlsTarget ? 'flex-[2] justify-around' : ''}`}>
        {showBoxToggle && showBoxHint && (
          // Painfix wave B #2: purely visual reinforcement — the
          // button's aria-label already carries the meaning for
          // assistive tech, so this transient label is hidden from
          // the accessibility tree.
          <span
            aria-hidden="true"
            data-testid="bbox-hint"
            className="flex items-center h-11 px-3 rounded-full bg-black/70 backdrop-blur ring-1 ring-white/15 text-white text-xs font-medium whitespace-nowrap pointer-events-none opacity-100 transition-opacity duration-500 motion-reduce:transition-none"
          >
            Detection boxes
          </span>
        )}
        {showBoxToggle && <button
          type="button"
          onClick={() => setBoxesVisible((v) => !v)}
          aria-label={boxesVisible ? 'Hide detection boxes' : 'Show detection boxes'}
          aria-pressed={boxesVisible}
          // Sunroom redesign (2026-07-01): text-white replaces
          // text-[var(--color-text-primary)] — primary is now Panther
          // ink (#292013), near-invisible on the black/60 scrim (the
          // exact Dana E1 contrast bug class). White on the marmalade
          // active fill is the allowed colored-fill exception. Focus
          // ring uses accent-bright over the dark video for contrast.
          className={`flex items-center justify-center gap-2 h-11 backdrop-blur text-white ring-1 ring-white/20 hover:bg-black/75 active:bg-black/85 focus-visible:outline-2 focus-visible:outline-[var(--color-accent-bright)] focus-visible:outline-offset-2 transition-colors ${controlsTarget ? 'min-w-[6.5rem] rounded-xl px-3' : 'w-11 rounded-full'} ${
            boxesVisible ? 'bg-[var(--color-accent-deep)]' : 'bg-black/60'
          }`}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            {/* Square outline = "show box overlay" affordance. */}
            <rect x="3" y="3" width="18" height="18" rx="2" />
            {boxesVisible ? null : <path d="M4 4l16 16" />}
          </svg>
          {controlsTarget && <span className="text-sm font-semibold">Boxes</span>}
        </button>}
        {actions}
        {showFullscreenButton && (
          <button
            type="button"
            onClick={onFullscreen}
            aria-label={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
            // Sunroom redesign (2026-07-01): same white-on-scrim fix +
            // shared over-video ring as the bbox toggle above.
            className="flex items-center justify-center w-11 h-11 bg-black/60 backdrop-blur rounded-full text-white ring-1 ring-white/20 hover:bg-black/75 active:bg-black/85 focus-visible:outline-2 focus-visible:outline-[var(--color-accent-bright)] focus-visible:outline-offset-2 transition-colors"
          >
            {isFullscreen ? (
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M9 4H5a1 1 0 0 0-1 1v4" />
                <path d="M15 4h4a1 1 0 0 1 1 1v4" />
                <path d="M9 20H5a1 1 0 0 1-1-1v-4" />
                <path d="M15 20h4a1 1 0 0 0 1-1v-4" />
              </svg>
            ) : (
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M4 9V5a1 1 0 0 1 1-1h4" />
                <path d="M20 9V5a1 1 0 0 0-1-1h-4" />
                <path d="M4 15v4a1 1 0 0 0 1 1h4" />
                <path d="M20 15v4a1 1 0 0 1-1 1h-4" />
              </svg>
            )}
          </button>
        )}
        </div>
      </ControlsHost>
      {/* iter-259: pill labels in plain English per ux-grandpa.
          Internal state names ("THERMAL", "OFFLINE") replaced with
          phrases that say what's happening to the user.

          iter-271 (accessibility-auditor C): wrapped in a single
          aria-live region so SR users HEAR the state transition
          (offline → online, low-memory → recovered, etc.). Pre-iter-271
          each pill had aria-label only; that's read on focus but
          NOT on visibility change, so the entire detection-status
          channel was silent for screen-readers. aria-atomic="true"
          ensures the whole region re-announces on any mutation. */}
      {/* iter-302b (accessibility-auditor #2): dropped aria-atomic="true".
          With it, ANY mutation in this region re-announces ALL pills,
          so a fast offline→stale→thermal transition queues 3 SR
          announcements. Without it, only the newly-inserted pill is
          announced — exactly what iter-271 intended. The pills are
          mutually exclusive by guard, so there's never more than one
          DOM child to mis-announce.

          Premium-launch slice (Dana #3 critical): pre-fix this wrapper
          carried `className="contents"` which strips the element from
          the box tree. WebKit + Blink both treat `display: contents`
          elements as if they had no role for accessibility — the
          live-region announcement was dropped on iOS VoiceOver and on
          NVDA + Chrome on Android. Now a real positioned <div> hosts
          the role; pill children stack inside via absolute positioning
          relative to the same top-right anchor they always used.
          pointer-events:none on the wrapper preserves click-through to
          the video element underneath when no pill is rendered. */}
      <div
        role="status"
        aria-live="polite"
        className="absolute top-3 right-3 pointer-events-none"
      >
        {/* Premium-launch slice (Dana #2 partial-sight redundancy):
            each precedence-ladder pill carries a distinctive glyph
            in addition to its severity color. Pre-fix all five pills
            shared one shell shape (rounded-* + colored 8 px dot) and
            differed only by hue + copy. Tritan-deficient and low-
            vision users couldn't reliably distinguish red-on-black
            from amber-on-black on the colored dot at that size.
            Now: glyph distinguishes the kind regardless of color
            perception, and the colored dot is reused at 8 px so the
            pre-existing iter-356.C visual contract is preserved. */}
        {detectionFeedStalled && status === 'live' && (
          <div
            className="flex flex-col items-end gap-0.5 bg-black/60 backdrop-blur ring-1 ring-white/20 px-2.5 py-1 rounded-full text-xs font-medium text-white pointer-events-auto"
            aria-label={`Detection feed stalled for ${Math.round((detectionFrameAgeSeconds ?? 0) / 10) * 10} seconds. Live video is still on.`}
          >
            <span className="inline-flex items-center gap-2">
              <PillSeverityIcon kind="detection-stale" tone="warning" />
              <span className="w-2 h-2 rounded-full bg-[var(--color-warning)] animate-pulse" />
              Detection delayed
            </span>
            <span className="text-xs text-white/80 font-normal">
              Live video is on
            </span>
          </div>
        )}
        {/* Status-truth fix (server-restart contradiction, 2026-07-07):
            single honest pill for "the detection worker isn't
            heartbeating" — amber, plain text, and distinct from an
            intentional user pause. This ONLY renders while status === 'live', i.e.
            real frames ARE flowing through the separate MediaMTX/
            WebRTC pipeline, so it must never claim the camera itself
            is offline — that copy is reserved for the status==='error'
            overlay further below, the one case where the video path
            is actually confirmed dead. Replaces the old two-pill split
            (cameraOffline red vs detectionPausedWorker yellow) that
            let the red "Camera offline. Restart the camera service."
            copy render at the same time the video was visibly live. */}
        {workerDead && status === 'live' && (
          <div
            className="flex items-center gap-2 bg-black/60 backdrop-blur ring-1 ring-white/20 px-2.5 py-1 rounded-full text-xs font-medium text-white pointer-events-auto"
            aria-label="Detection unavailable. Live video is still on."
          >
            <PillSeverityIcon kind="worker-offline" tone="warning" />
            <span className="w-2 h-2 rounded-full bg-[var(--color-warning)]" />
            Detection unavailable · Live video is on
          </div>
        )}
        {lowMem && status === 'live' && (
          // Painfix wave B #3: one plain-guidance line under the pill so
          // a non-technical user isn't left wondering whether THEY need
          // to do something — this state self-clears.
          <div
            className="flex flex-col items-end gap-0.5 bg-black/60 backdrop-blur ring-1 ring-white/20 px-2.5 py-1 rounded-full text-xs font-medium text-white pointer-events-auto"
            aria-label="Detection paused due to low memory. The camera is freeing up memory. Back to normal soon."
          >
            <span className="inline-flex items-center gap-2">
              <PillSeverityIcon kind="low-memory" tone="danger" />
              <span className="w-2 h-2 rounded-full bg-[var(--color-danger-strong)]" />
              Low memory — paused
            </span>
            <span className="text-xs text-white/80 font-normal">
              The camera is freeing up memory. Back to normal soon.
            </span>
          </div>
        )}
        {therm && status === 'live' && (
          // Painfix wave B #3: same plain-guidance addition for the
          // thermal pill.
          <div
            className="flex flex-col items-end gap-0.5 bg-black/60 backdrop-blur ring-1 ring-white/20 px-2.5 py-1 rounded-full text-xs font-medium text-white pointer-events-auto"
            aria-label="Detection rate-limited by GPU thermal. This clears on its own as the camera cools. No action needed."
          >
            <span className="inline-flex items-center gap-2">
              <PillSeverityIcon kind="thermal" tone="warning" />
              <span className="w-2 h-2 rounded-full bg-[var(--color-warning)]" />
              Camera too hot — slowed down
            </span>
            <span className="text-xs text-white/80 font-normal">
              This clears on its own as the camera cools. No action needed.
            </span>
          </div>
        )}
        {paused && status === 'live' && (
          <div
            className="flex items-center gap-2 bg-black/60 backdrop-blur ring-1 ring-white/20 px-2.5 py-1 rounded-full text-xs font-medium text-white pointer-events-auto"
            aria-label="Detection paused"
          >
            <PillSeverityIcon kind="paused" tone="warning" />
            <span className="w-2 h-2 rounded-full bg-[var(--color-warning)]" />
            Detection paused
          </div>
        )}
      </div>
      {status === 'error' && (
        // Premium-launch slice (Maya Critical #4): use the new
        // `compact` size so the camera-offline overlay fits inside
        // a 16:9 video tile without overflowing on landscape phones.
        // The full-size variant is sized for full-page error
        // surfaces and pushed the Retry button below the fold on a
        // 16:9 tile at typical mobile heights.
        <div className="absolute inset-0 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <OfflineState
            kind="camera"
            size="compact"
            retry={() => setRetryNonce((n) => n + 1)}
          />
        </div>
      )}
    </div>
  )
}

function StatusPill({ status }: { status: Status }) {
  // iter-355ac (Maya Major): "LIVE" all-caps + pulsing red dot reads
  // cliché-CCTV. Premium apps (Ring, Nest) use lowercase "Live" with
  // a solid (not pulsing) dot. Reserve animate-pulse for actual error
  // states — those already get attention via the precedence-ladder
  // overlays above this pill. The pulse was also burning a compositor
  // layer on the first thing the user sees, every load.
  // Task 5 (Playroom Modern, 2026-07-07): pill grammar swapped from
  // an over-video black/60 glass chip (white text, iter-356.56's
  // contrast fix) to the surface-scrim pill used by the rest of the
  // Playroom system — a light-in-light-theme / dark-in-dark-theme
  // glass card rather than a permanently-dark chip. "Live" gets the
  // alarm-adjacent --color-danger dot (a broadcast-style red dot is
  // an intentional, allowed exception to the no-danger-color-outside-
  // danger-states rule — it signals "recording", not "something's
  // wrong"). text-primary now carries correct contrast on the new
  // (theme-aware) surface-scrim background, replacing the old
  // hardcoded text-white.
  const dot =
    status === 'live'
      ? 'bg-[var(--color-danger)]'
      : status === 'connecting'
        ? 'bg-[var(--color-warning)] animate-pulse'
        : 'bg-[var(--color-text-tertiary)]'
  const label =
    status === 'live'
      ? 'Live'
      : status === 'connecting'
        ? 'Connecting'
        : status === 'error'
          ? 'Offline'
          : 'Idle'
  return (
    <div className="absolute top-3 left-3 flex items-center gap-2 bg-[var(--color-surface-scrim)] backdrop-blur ring-1 ring-[var(--color-border)] px-2.5 py-1 rounded-full text-xs font-medium text-[var(--color-text-primary)]">
      <span className={`w-2 h-2 rounded-full ${dot}`} />
      {label}
    </div>
  )
}

/**
 * Premium-launch slice (Dana #2) — distinctive glyph per pill kind so
 * partial-sight + colorblind users get a redundant signal alongside
 * the colored severity dot. Pre-fix the five precedence-ladder pills
 * shared one shell shape and differed only by hue + copy.
 *
 * Each glyph is a 12 px outlined SVG drawn with currentColor so the
 * `tone` className on the wrapper picks the right severity color
 * (warning amber or danger red). Aria-hidden because the pill's
 * parent element already carries an accessible name (aria-label) and
 * the glyph is purely visual reinforcement.
 *
 * Glyph vocabulary, picked to read at 12 px on a glassy dark backdrop:
 *  - detection-stale → broken-signal (3 ascending bars, last one slashed)
 *  - camera-offline → camera body with a diagonal slash through it
 *  - worker-offline → eye with a diagonal slash through it
 *  - low-memory    → memory-chip outline with a center dot
 *  - thermal       → thermometer column with a bulb
 *  - paused        → two parallel pause bars
 */
type PillKind =
  | 'detection-stale'
  | 'camera-offline'
  | 'worker-offline'
  | 'low-memory'
  | 'thermal'
  | 'paused'

function PillSeverityIcon({
  kind,
  tone,
}: {
  kind: PillKind
  tone: 'warning' | 'danger'
}) {
  // Sunroom redesign (2026-07-01): over the black scrim, the light-bg
  // danger token (#b3372e brick) drops below 3.5:1 — danger-strong is
  // the bright fill red and keeps the glyph legible over video.
  const colorClass =
    tone === 'danger'
      ? 'text-[var(--color-danger-strong)]'
      : 'text-[var(--color-warning)]'
  return (
    <span
      aria-hidden="true"
      data-testid={`pill-icon-${kind}`}
      className={`flex-shrink-0 inline-flex ${colorClass}`}
    >
      <svg
        width="12"
        height="12"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.25"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {kind === 'detection-stale' && (
          // Three ascending bars + a slash — "signal interrupted".
          <>
            <line x1="6" y1="20" x2="6" y2="16" />
            <line x1="12" y1="20" x2="12" y2="11" />
            <line x1="18" y1="20" x2="18" y2="6" />
            <line x1="3" y1="3" x2="21" y2="21" />
          </>
        )}
        {kind === 'camera-offline' && (
          // Camera body + slash — "the camera is unreachable".
          <>
            <path d="M23 7l-7 5 7 5V7z" />
            <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
            <line x1="3" y1="3" x2="21" y2="21" />
          </>
        )}
        {kind === 'worker-offline' && (
          // Eye + slash — "the watcher is offline" (worker is the
          // detection eye on the camera; iter-356 idiom).
          <>
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
            <circle cx="12" cy="12" r="3" />
            <line x1="3" y1="3" x2="21" y2="21" />
          </>
        )}
        {kind === 'low-memory' && (
          // Memory-chip outline with a center dot — "system pressure".
          <>
            <rect x="4" y="4" width="16" height="16" rx="2" />
            <line x1="9" y1="2" x2="9" y2="4" />
            <line x1="15" y1="2" x2="15" y2="4" />
            <line x1="9" y1="20" x2="9" y2="22" />
            <line x1="15" y1="20" x2="15" y2="22" />
            <line x1="2" y1="9" x2="4" y2="9" />
            <line x1="2" y1="15" x2="4" y2="15" />
            <line x1="20" y1="9" x2="22" y2="9" />
            <line x1="20" y1="15" x2="22" y2="15" />
          </>
        )}
        {kind === 'thermal' && (
          // Thermometer with bulb — "running too hot".
          <>
            <path d="M14 14.76V3.5a2.5 2.5 0 0 0-5 0v11.26a4 4 0 1 0 5 0z" />
          </>
        )}
        {kind === 'paused' && (
          // Pair of pause bars — "deliberately paused" (distinct
          // from the slashed glyphs above which all signal failure).
          <>
            <line x1="9" y1="6" x2="9" y2="18" />
            <line x1="15" y1="6" x2="15" y2="18" />
          </>
        )}
      </svg>
    </span>
  )
}
