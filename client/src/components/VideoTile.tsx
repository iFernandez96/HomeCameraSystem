import { useEffect, useRef, useState } from 'react'
import { drawBoxes } from '../lib/drawBoxes'
import { connectWhep, type WhepConnection } from '../lib/webrtc'
import { subscribeEvents } from '../lib/ws'
import type { DetectionEvent } from '../lib/types'
import { OfflineState } from './states/OfflineState'

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
}: {
  src: string
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
    const onVideoError = () => {
      if (cancelled) return
      setStatus('error')
    }
    const onStallOrWaiting = () => {
      if (cancelled || stallTimer !== null) return
      stallTimer = setTimeout(() => {
        stallTimer = null
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
    connectWhep(src, video)
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
        console.error('WHEP connect failed', e)
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
  }, [src, retryNonce])

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
        so?.lock?.('landscape').catch(() => {})
      } else {
        so?.unlock?.()
      }
    }
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])

  const onFullscreen = () => {
    if (document.fullscreenElement != null) {
      document.exitFullscreen?.().catch(() => {})
      return
    }
    const container = containerRef.current
    if (container && container.requestFullscreen) {
      container.requestFullscreen().catch(() => {
        videoRef.current
          ?.requestFullscreen?.()
          .catch(() => {
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
      className="relative aspect-video bg-black overflow-hidden rounded-2xl border border-[var(--color-border)]"
    >
      <video
        ref={videoRef}
        className="w-full h-full object-cover"
        autoPlay
        playsInline
        muted
        aria-label="Live camera feed"
      />
      <canvas ref={canvasRef} className="absolute inset-0 pointer-events-none" />
      <StatusPill status={status} />
      <button
        type="button"
        onClick={() => setBoxesVisible((v) => !v)}
        aria-label={boxesVisible ? 'Hide detection boxes' : 'Show detection boxes'}
        aria-pressed={boxesVisible}
        className={`absolute bottom-3 right-16 flex items-center justify-center w-11 h-11 backdrop-blur rounded-full text-[var(--color-text-primary)] hover:bg-black/75 active:bg-black/85 focus-visible:outline-2 focus-visible:outline-[var(--color-accent-default)] focus-visible:outline-offset-2 ${
          boxesVisible ? 'bg-[var(--color-accent-default)]/70' : 'bg-black/60'
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
        className="absolute bottom-3 right-3 flex items-center justify-center w-11 h-11 bg-black/60 backdrop-blur rounded-full text-[var(--color-text-primary)] hover:bg-black/75 active:bg-black/85 focus-visible:outline-2 focus-visible:outline-[var(--color-accent-default)] focus-visible:outline-offset-2"
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
          DOM child to mis-announce. */}
      <div
        role="status"
        aria-live="polite"
        className="contents"
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
        {streamStale && status === 'live' && (
          <div
            className="absolute top-3 right-3 flex flex-col items-end gap-0.5 bg-black/60 backdrop-blur px-2.5 py-1 rounded-lg text-xs font-medium text-white"
            aria-label={`Stream stalled — no video for ${Math.round((streamStaleSeconds ?? 0) / 10) * 10}s. Reconnect.`}
          >
            <span className="inline-flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-yellow-500 animate-pulse" />
              Stream stalled
            </span>
            <span className="text-[10px] text-white/80 font-normal">
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
            className="absolute top-3 right-3 flex flex-col items-end gap-0.5 bg-black/60 backdrop-blur px-2.5 py-1 rounded-lg text-xs font-medium text-white"
            aria-label="Camera offline. Restart the camera service."
          >
            <span className="inline-flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-[var(--color-danger)]" />
              Camera offline
            </span>
            <span className="text-[10px] text-white/80 font-normal">
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
            className="absolute top-3 right-3 flex items-center gap-2 bg-black/60 backdrop-blur px-2.5 py-1 rounded-full text-xs font-medium text-white"
            aria-label="Detection paused — worker offline"
          >
            <span className="w-2 h-2 rounded-full bg-yellow-500" />
            Detection paused — worker offline
          </div>
        )}
        {lowMem && status === 'live' && (
          <div
            className="absolute top-3 right-3 flex items-center gap-2 bg-black/60 backdrop-blur px-2.5 py-1 rounded-full text-xs font-medium text-white"
            aria-label="Detection paused due to low memory"
          >
            <span className="w-2 h-2 rounded-full bg-red-500" />
            Low memory — paused
          </div>
        )}
        {therm && status === 'live' && (
          <div
            className="absolute top-3 right-3 flex items-center gap-2 bg-black/60 backdrop-blur px-2.5 py-1 rounded-full text-xs font-medium text-white"
            aria-label="Detection rate-limited by GPU thermal"
          >
            <span className="w-2 h-2 rounded-full bg-yellow-500" />
            Camera too hot — slowed down
          </div>
        )}
        {paused && status === 'live' && (
          <div
            className="absolute top-3 right-3 flex items-center gap-2 bg-black/60 backdrop-blur px-2.5 py-1 rounded-full text-xs font-medium text-white"
            aria-label="Detection paused"
          >
            <span className="w-2 h-2 rounded-full bg-yellow-500" />
            Detection paused
          </div>
        )}
      </div>
      {status === 'error' && (
        // iter-356.63 (mobile redesign Slice F): swap inline overlay
        // copy for the shared <OfflineState kind="camera"> primitive
        // so the camera-offline surface matches the one used on
        // EventList / People / etc. The dim backdrop wrapper stays —
        // it’s a video-overlay specific affordance.
        <div className="absolute inset-0 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <OfflineState
            kind="camera"
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
  const dot =
    status === 'live'
      ? 'bg-red-500'
      : status === 'connecting'
        ? 'bg-yellow-500 animate-pulse'
        : 'bg-neutral-500'
  const label =
    status === 'live'
      ? 'Live'
      : status === 'connecting'
        ? 'Connecting'
        : status === 'error'
          ? 'Offline'
          : 'Idle'
  return (
    // iter-356.56 (Dana E1+E2): pill text was inheriting near-black
    // --color-text-primary on bg-black/60 — measured 1.05:1 contrast,
    // catastrophic WCAG fail. text-white is ~10:1 on the same backdrop.
    <div className="absolute top-3 left-3 flex items-center gap-2 bg-black/60 backdrop-blur px-2.5 py-1 rounded-full text-xs font-medium text-white">
      <span className={`w-2 h-2 rounded-full ${dot}`} />
      {label}
    </div>
  )
}
