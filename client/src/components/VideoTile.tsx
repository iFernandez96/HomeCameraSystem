import { useEffect, useRef, useState } from 'react'
import { drawBoxes } from '../lib/drawBoxes'
import { log, errFields } from '../lib/log'
import {
  getStreamQuality,
  pathForQuality,
  setStreamQuality,
  whepUrlForPath,
  type StreamQuality,
} from '../lib/streamQuality'
import { connectWhep, type WhepConnection } from '../lib/webrtc'
import { subscribeEvents } from '../lib/ws'
import type { DetectionEvent } from '../lib/types'
import { OfflineState } from './states/OfflineState'
import { QualityMenu } from './QualityMenu'

type Status = 'connecting' | 'live' | 'error' | 'idle'

// Stable reference so the canvas effect's dep array can short-circuit when
// detection is paused — see comment in VideoTile.
const EMPTY_BOXES: DetectionEvent['boxes'] = []

export function VideoTile({
  src,
  detectionActive = null,
  workerAlive = null,
  lowMemory = null,
  thermal = null,
  streamStaleSeconds = null,
  fit = 'cover',
  showStatusPill = true,
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
   * is "unknown" (treated like `true`). When `false`, the OFFLINE pill takes
   * precedence over the PAUSED pill.
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
   * so when this exceeds ~60 we show a "STREAM STALE" pill that
   * takes precedence over OFFLINE/LOW-MEMORY/THERMAL/PAUSED
   * (because none of those describe the actual failure: video
   * isn't flowing).
   */
  streamStaleSeconds?: number | null
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
   * "Offline", top-12 left-3) is the ONE status pill Watch wants
   * docked. In fullscreen Watch already renders a combined
   * "{armed state} · {camera}" cluster plus the scrubber's red LIVE
   * pill, so this tile's pill would be a third, redundant "Live"
   * label crowding the back chevron (fuzz F7). Default true so
   * every other VideoTile consumer (tests, future multi-cam) keeps
   * the pill unless it opts out.
   */
  showStatusPill?: boolean
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
    if (typeof window === 'undefined') return
    window.localStorage.setItem('homecam:boxesVisible', boxesVisible ? '1' : '0')
  }, [boxesVisible])
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
  // `src` override (tests / future multi-cam wiring) wins; otherwise the
  // tile composes its own URL from the chosen quality.
  const effectiveSrc = src ?? whepUrlForPath(pathForQuality(quality))
  // Keep the latest quality in a ref so the connect effect can LOG it
  // without taking it as a reactive dependency. The effect re-runs on
  // `effectiveSrc` (which already changes in lockstep with quality in the
  // cellular case); making quality a dep would force a redundant reconnect
  // when a `src` override is supplied. The ref always reads current.
  const qualityRef = useRef(quality)
  // Sync the ref in an effect (NOT during render — react-hooks/refs) so the
  // connect effect can log the current quality without a reactive dep.
  useEffect(() => {
    qualityRef.current = quality
  }, [quality])
  const onSelectQuality = (q: StreamQuality) => {
    setStreamQuality(q)
    setQuality(q)
  }
  // iter-356.C (mobile-redesign Slice C — security clarity): the
  // single "Detection offline" pill split into three honest cases.
  // `cameraOffline`: worker has never heartbeated AND we've never
  //   seen a frame — the camera box itself is unreachable. RED. The
  //   user should restart the camera service (operator action).
  // `streamStale`: worker is heartbeating, but the stream has gone
  //   silent for >60s — iter-300 outage signature. YELLOW. The
  //   existing Retry button is the natural recovery (it tears down
  //   WHEP and reconnects).
  // `detectionPausedWorker`: worker is dead but we have a recent
  //   frame counter (server caches the last value across worker
  //   restarts). YELLOW. The video may still play from MediaMTX
  //   while detection is offline. Plain text only — no operator
  //   action recommended; the worker auto-recovers.
  const cameraOffline =
    workerAlive === false &&
    (streamStaleSeconds === null || streamStaleSeconds === undefined)
  const streamStale =
    workerAlive === true &&
    streamStaleSeconds !== null &&
    streamStaleSeconds !== undefined &&
    streamStaleSeconds > 60
  const detectionPausedWorker =
    workerAlive === false &&
    streamStaleSeconds !== null &&
    streamStaleSeconds !== undefined
  // Carry the legacy `offline` derivation for the bbox-clear logic
  // below — both cameraOffline AND detectionPausedWorker are
  // worker-dead scenarios where the boxes array is stale.
  const offline = cameraOffline || detectionPausedWorker
  const lowMem = !offline && !streamStale && lowMemory === true
  const therm = !offline && !streamStale && !lowMem && thermal === true
  const paused =
    !offline && !streamStale && !lowMem && !therm && detectionActive === false

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    let conn: WhepConnection | null = null
    let cancelled = false
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
    // with no actual video. Now 'live' requires either the <video>
    // element's `playing` event (real frames decoded) or the peer
    // connection's `connected` state. The `mediaTimer` fallback flips
    // to 'error' if neither fires within 8 s of WHEP resolve so the
    // user gets a Retry button instead of staring at a frozen
    // 'connecting' state forever.
    let mediaTimer: ReturnType<typeof setTimeout> | null = null
    const markLive = () => {
      if (cancelled) return
      if (mediaTimer !== null) {
        clearTimeout(mediaTimer)
        mediaTimer = null
      }
      setStatus('live')
    }
    const onPlaying = () => {
      if (stallTimer !== null) {
        clearTimeout(stallTimer)
        stallTimer = null
      }
      markLive()
    }
    video.addEventListener('error', onVideoError)
    video.addEventListener('stalled', onStallOrWaiting)
    video.addEventListener('waiting', onStallOrWaiting)
    video.addEventListener('playing', onPlaying)
    setStatus('connecting')
    connectWhep(effectiveSrc, video)
      .then((c) => {
        if (cancelled) {
          c.close()
          return
        }
        conn = c
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
          if (s === 'connected') {
            markLive()
          } else if (s === 'failed' || s === 'disconnected' || s === 'closed') {
            midStreamFail('pc-state-' + s)
            setStatus('error')
          }
        }
        c.pc.addEventListener('connectionstatechange', pcStateChange)
        // Cover the "already connected before listener registration"
        // race — the connectionstatechange event won't replay, so check
        // once at registration time. Common when WHEP turnaround is
        // very fast on LAN.
        if (c.pc.connectionState === 'connected') markLive()
      })
      .catch((e) => {
        // docs/logging_plan.md §2 (Live view): replace the generic
        // console.error('WHEP connect failed') with the express cause
        // + identifying ids (quality / effectiveSrc / retryNonce) so
        // the operator can correlate which rung + which retry failed.
        // Logged BEFORE the cancelled guard (§1.3). errFields pulls the
        // status off an HttpError-shaped reject if present.
        log.error('videoTile:whep-connect-failed', {
          quality: qualityRef.current,
          effectiveSrc,
          retryNonce,
          online: typeof navigator !== 'undefined' ? navigator.onLine : null,
          ...errFields(e),
        })
        if (!cancelled) setStatus('error')
      })
    return () => {
      cancelled = true
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
      // iter-177: explicit cleanup of the iter-162 pc listener.
      // `conn?.close()` below already invalidates it, but removing
      // first means a defer/skip of close (transition reuse, etc.)
      // can't leak the listener.
      if (conn !== null && pcStateChange !== null) {
        conn.pc.removeEventListener('connectionstatechange', pcStateChange)
        pcStateChange = null
      }
      conn?.close()
    }
  }, [effectiveSrc, retryNonce])

  useEffect(() => {
    return subscribeEvents((evt) => {
      if (evt.type === 'detection') {
        setBoxes(evt.boxes)
        setPersonName(evt.person_name ?? null)
      }
    })
  }, [])

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
  useEffect(() => {
    const onVisible = () => {
      if (
        document.visibilityState === 'visible' &&
        status === 'error'
      ) {
        setRetryNonce((n) => n + 1)
      }
    }
    const onOnline = () => {
      if (status === 'error') setRetryNonce((n) => n + 1)
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
      {showStatusPill && <StatusPill status={status} />}
      <div className="absolute bottom-3 left-3">
        <QualityMenu quality={quality} onSelect={onSelectQuality} />
      </div>
      <button
        type="button"
        onClick={() => setBoxesVisible((v) => !v)}
        aria-label={boxesVisible ? 'Hide detection boxes' : 'Show detection boxes'}
        aria-pressed={boxesVisible}
        // Premium-launch slice (Dana #13): bottom inset honors iOS
        // PWA standalone safe-area in landscape; without it the
        // overlay sits behind the home-indicator strip on iPhone
        // notched devices.
        style={{ bottom: 'calc(0.75rem + env(safe-area-inset-bottom))' }}
        // Sunroom redesign (2026-07-01): text-white replaces
        // text-[var(--color-text-primary)] — primary is now Panther
        // ink (#292013), near-invisible on the black/60 scrim (the
        // exact Dana E1 contrast bug class). White on the marmalade
        // active fill is the allowed colored-fill exception. Focus
        // ring uses accent-bright over the dark video for contrast.
        className={`absolute right-16 flex items-center justify-center w-11 h-11 backdrop-blur rounded-full text-white ring-1 ring-white/20 hover:bg-black/75 active:bg-black/85 focus-visible:outline-2 focus-visible:outline-[var(--color-accent-bright)] focus-visible:outline-offset-2 transition-colors ${
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
      </button>
      <button
        type="button"
        onClick={onFullscreen}
        aria-label={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
        // Premium-launch slice (Dana #13): same safe-area-inset
        // treatment as the bbox toggle so neither button hides
        // behind the iOS home indicator in landscape PWA mode.
        style={{ bottom: 'calc(0.75rem + env(safe-area-inset-bottom))' }}
        // Sunroom redesign (2026-07-01): same white-on-scrim fix +
        // shared over-video ring as the bbox toggle above.
        className="absolute right-3 flex items-center justify-center w-11 h-11 bg-black/60 backdrop-blur rounded-full text-white ring-1 ring-white/20 hover:bg-black/75 active:bg-black/85 focus-visible:outline-2 focus-visible:outline-[var(--color-accent-bright)] focus-visible:outline-offset-2 transition-colors"
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
        {/* iter-302: stream-stale takes precedence — see comment block
            on `streamStale` derivation above. The label is plain English
            so a non-technical user understands what's wrong: "no video
            from the camera".
            iter-302b (accessibility-auditor #1): seconds count moved
            into the visible text and aria-label dropped. Pre-iter-302b
            the aria-label said "No video for N seconds" while visible
            text said "No video — stream stalled" — VoiceOver read the
            label, NVDA read the text, two users got two different
            messages. One string for both channels. */}
        {/* iter-356.C: stream-stale = yellow (worker alive, video
            silent — Reconnect via the existing error-overlay Retry
            below). Visible text now reads "Stream stalled" with the
            Reconnect hint; the precise seconds count moves to the
            aria-label only so SR users still hear how long it's been
            stale, and the visible UI stays calm. */}
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
        {streamStale && status === 'live' && (
          <div
            className="flex flex-col items-end gap-0.5 bg-black/60 backdrop-blur ring-1 ring-white/20 px-2.5 py-1 rounded-lg text-xs font-medium text-white pointer-events-auto"
            aria-label={`Stream stalled — no video for ${Math.round((streamStaleSeconds ?? 0) / 10) * 10}s. Reconnect.`}
          >
            <span className="inline-flex items-center gap-2">
              <PillSeverityIcon kind="stream-stale" tone="warning" />
              <span className="w-2 h-2 rounded-full bg-[var(--color-warning)] animate-pulse" />
              Stream stalled
            </span>
            <span className="text-xs text-white/80 font-normal">
              Reconnect
            </span>
          </div>
        )}
        {/* iter-356.C: camera-offline = red. The Jetson + camera box
            isn't reachable; restart the camera service (an operator
            action; the suggestion is plain text — no in-app button
            because the recovery tool runs on the host). */}
        {cameraOffline && status === 'live' && (
          <div
            className="flex flex-col items-end gap-0.5 bg-black/60 backdrop-blur ring-1 ring-white/20 px-2.5 py-1 rounded-lg text-xs font-medium text-white pointer-events-auto"
            aria-label="Camera offline. Restart the camera service."
          >
            <span className="inline-flex items-center gap-2">
              <PillSeverityIcon kind="camera-offline" tone="danger" />
              <span className="w-2 h-2 rounded-full bg-[var(--color-danger-strong)]" />
              Camera offline
            </span>
            <span className="text-xs text-white/80 font-normal">
              Restart the camera service
            </span>
          </div>
        )}
        {/* iter-356.C: detection-paused (worker offline) = yellow,
            plain text. Worker died but the video stream is fine — the
            user is not blind. We don't recommend an action because
            the worker auto-recovers within a heartbeat cycle. */}
        {detectionPausedWorker && status === 'live' && (
          <div
            className="flex items-center gap-2 bg-black/60 backdrop-blur ring-1 ring-white/20 px-2.5 py-1 rounded-full text-xs font-medium text-white pointer-events-auto"
            aria-label="Detection paused — worker offline"
          >
            <PillSeverityIcon kind="worker-offline" tone="warning" />
            <span className="w-2 h-2 rounded-full bg-[var(--color-warning)]" />
            Detection paused — worker offline
          </div>
        )}
        {lowMem && status === 'live' && (
          <div
            className="flex items-center gap-2 bg-black/60 backdrop-blur ring-1 ring-white/20 px-2.5 py-1 rounded-full text-xs font-medium text-white pointer-events-auto"
            aria-label="Detection paused due to low memory"
          >
            <PillSeverityIcon kind="low-memory" tone="danger" />
            <span className="w-2 h-2 rounded-full bg-[var(--color-danger-strong)]" />
            Low memory — paused
          </div>
        )}
        {therm && status === 'live' && (
          <div
            className="flex items-center gap-2 bg-black/60 backdrop-blur ring-1 ring-white/20 px-2.5 py-1 rounded-full text-xs font-medium text-white pointer-events-auto"
            aria-label="Detection rate-limited by GPU thermal"
          >
            <PillSeverityIcon kind="thermal" tone="warning" />
            <span className="w-2 h-2 rounded-full bg-[var(--color-warning)]" />
            Camera too hot — slowed down
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
    // Structural overhaul (Watch): dropped from top-3 to top-12 — the
    // Watch scrim owns the top strip (armed state + camera + age) and
    // the connection pill was rendering directly behind its text.
    <div className="absolute top-12 left-3 flex items-center gap-2 bg-[var(--color-surface-scrim)] backdrop-blur ring-1 ring-[var(--color-border)] px-2.5 py-1 rounded-full text-xs font-medium text-[var(--color-text-primary)]">
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
 *  - stream-stale  → broken-signal (3 ascending bars, last one slashed)
 *  - camera-offline → camera body with a diagonal slash through it
 *  - worker-offline → eye with a diagonal slash through it
 *  - low-memory    → memory-chip outline with a center dot
 *  - thermal       → thermometer column with a bulb
 *  - paused        → two parallel pause bars
 */
type PillKind =
  | 'stream-stale'
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
        {kind === 'stream-stale' && (
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
