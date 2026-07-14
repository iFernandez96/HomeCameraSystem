import { useEffect, useRef, useState, type ReactNode } from 'react'

// Speed multipliers offered in the strip (the user's set: .25× → 4×).
// Browsers cap playbackRate well above 4×, so all are valid.
export const SPEED_RATES: ReadonlyArray<number> = [
  0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 4,
]

export function speedLabel(rate: number): string {
  return rate === 1 ? 'Normal' : `${rate}×`
}

// NATIVE-CONTROLS player (2026-07-02, user escalation "is this the best
// viewer there is?" — honest answer: no, the hand-rolled one wasn't).
//
// History: the previous implementation was a custom YouTube-style
// control bar (own scrubber, auto-hiding chrome, custom fullscreen).
// It produced a stream of interaction bugs on touch — taps landing on
// a bar that had just gone pointer-events-none, a fullscreen button
// intercepted by the <video>, sub-44px targets — because it was
// re-implementing what the browser already does perfectly. Chrome
// Android's native controls ARE the premium native experience: instant
// tap response, drag scrubbing, double-tap seek, rock-solid fullscreen,
// PiP — all maintained by the browser.
//
// So: `controls` is ON, and this component is now a thin wrapper that
// preserves the two things the native bar can't do:
//   - a consumer overlay (bbox canvas / timelapse clock) painted over
//     the frame in a pointer-events-none layer, so it can never eat a
//     tap meant for the native controls;
//   - playback speed + repeat, as an always-visible strip UNDER the
//     video (mobile Chrome's native bar has no speed control).
//
// Known trade-off: the native fullscreen button fullscreens the VIDEO
// element itself, so the bbox overlay is not visible in fullscreen.
// Correct playback beats decorated playback.

// HTMLMediaElement.play() returns a promise in browsers (rejects on
// autoplay block) but `undefined` under jsdom — guard the .catch.
function safePlay(v: HTMLVideoElement): void {
  try {
    const p = v.play()
    if (p && typeof p.catch === 'function') p.catch(() => {})
  } catch {
    // jsdom and some locked-down WebViews can throw synchronously.
  }
}

export function VideoPlayer({
  src,
  ariaLabel,
  className,
  containerClassName,
  videoClassName,
  initialLoop = false,
  preload = 'metadata',
  initialRate = 1,
  autoPlay = false,
  nativeControls = true,
  controlsList,
  showPlaybackSettings = true,
  showFullscreenButton = true,
  fullscreenActive,
  poster,
  fillHeight = false,
  overlay,
  onTimeUpdate,
  onPlay,
  onError,
  onVideoEl,
  onFullscreenToggle,
}: {
  src: string
  ariaLabel: string
  className?: string
  containerClassName?: string
  videoClassName?: string
  initialLoop?: boolean
  preload?: 'none' | 'metadata' | 'auto'
  initialRate?: number
  autoPlay?: boolean
  nativeControls?: boolean
  controlsList?: string
  showPlaybackSettings?: boolean
  showFullscreenButton?: boolean
  fullscreenActive?: boolean
  /** Still frame shown before playback starts / while the clip is
   *  loading (2026-07-07 fix: an unstarted <video> has no intrinsic
   *  size, so without a poster the frame is blank until metadata
   *  loads). */
  poster?: string
  /** When true, the video area stretches to fill the parent's height
   *  (flex-1) instead of sizing to the video's own intrinsic aspect
   *  ratio. Opt-in so existing consumers (TimelapsesSection) that rely
   *  on content-based sizing are unaffected. ClipModal sets this so the
   *  player fills its aspect-video frame. */
  fillHeight?: boolean
  /** Painted absolutely over the video in a pointer-events-none layer
   *  (bbox canvas, timestamp clock, …). */
  overlay?: ReactNode
  onTimeUpdate?: (video: HTMLVideoElement) => void
  onPlay?: () => void
  onError?: (video: HTMLVideoElement) => void
  /** Hands the underlying <video> element to the consumer (called once
   *  it mounts, and with null on unmount). Memoize it. */
  onVideoEl?: (el: HTMLVideoElement | null) => void
  /** Lets a parent own the fullscreen surface while this player owns
   *  the in-player fullscreen command. ClipModal uses this so event
   *  fullscreen keeps its pinch-to-zoom layer. */
  onFullscreenToggle?: (active: boolean) => void
}) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const [rate, setRate] = useState(initialRate)
  const [loop, setLoop] = useState(initialLoop)
  const [fullscreen, setFullscreen] = useState(false)
  const [appFullscreen, setAppFullscreen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)

  useEffect(() => {
    onVideoEl?.(videoRef.current)
    return () => onVideoEl?.(null)
  }, [onVideoEl])

  // playbackRate has no React attribute — apply imperatively.
  useEffect(() => {
    if (videoRef.current) videoRef.current.playbackRate = rate
  }, [rate])

  // Best-effort autoplay (iOS ignores the attribute on a React
  // key-remount).
  useEffect(() => {
    if (autoPlay && videoRef.current) safePlay(videoRef.current)
  }, [autoPlay])

  useEffect(() => {
    const onChange = () => {
      const active = document.fullscreenElement === containerRef.current
      setFullscreen(active)
      if (!active && document.fullscreenElement == null) setAppFullscreen(false)
    }
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])

  const toggleFullscreen = () => {
    const expanded = fullscreen || appFullscreen
    if (onFullscreenToggle) {
      setMenuOpen(false)
      onFullscreenToggle(!(fullscreenActive ?? false))
      return
    }
    const webkitVideo = videoRef.current as
      | (HTMLVideoElement & { webkitEnterFullscreen?: () => void })
      | null
    if (expanded || document.fullscreenElement) {
      setMenuOpen(false)
      setAppFullscreen(false)
      document.exitFullscreen?.().catch(() => {})
      return
    }
    // Own the visual state immediately. The browser/API fullscreen
    // request below is an enhancement; Android WebView can silently
    // refuse it, but the user still gets a real full-player view.
    setAppFullscreen(true)
    const target = containerRef.current
    if (target?.requestFullscreen) {
      target.requestFullscreen({ navigationUI: 'hide' }).catch(() => {
        webkitVideo?.webkitEnterFullscreen?.()
      })
      return
    }
    webkitVideo?.webkitEnterFullscreen?.()
  }
  const expanded = fullscreen || appFullscreen
  const fullscreenControlActive = onFullscreenToggle ? !!fullscreenActive : expanded
  const speedButtonLabel = rate === 1 ? '1×' : speedLabel(rate)
  const rootClassName = expanded
    ? 'fixed inset-0 z-[1000] h-[100dvh] w-screen rounded-none border-0 shadow-none'
    : (containerClassName ?? className ?? '')
  const innerVideoClassName = expanded
    ? 'w-full h-full object-contain'
    : (videoClassName ?? 'w-full')

  return (
    <div
      ref={containerRef}
      data-app-fullscreen={expanded ? 'true' : undefined}
      className={`flex flex-col bg-black overflow-hidden ${rootClassName}`}
    >
      <div className={`relative min-h-0 ${fillHeight || expanded ? 'flex-1' : ''}`}>
        {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
        <video
          ref={videoRef}
          src={src}
          controls={nativeControls}
          controlsList={controlsList}
          loop={loop}
          playsInline
          preload={preload}
          poster={poster}
          className={`block ${innerVideoClassName}`}
          aria-label={ariaLabel}
          onPlay={onPlay}
          onTimeUpdate={(e) => onTimeUpdate?.(e.currentTarget)}
          onError={(e) => onError?.(e.currentTarget)}
        />
        {/* pointer-events-none here so overlays can't eat native-control
            taps; an interactive overlay child (ClipModal's boxes toggle)
            opts back in with its own pointer-events-auto. NOT aria-
            hidden — those children must stay in the a11y tree. */}
        {overlay && (
          <div className="pointer-events-none absolute inset-0">
            {overlay}
          </div>
        )}

        {showPlaybackSettings && (
          <button
            type="button"
            aria-label="Playback settings"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((open) => !open)}
            className="pointer-events-auto absolute left-3 top-3 z-20 inline-flex h-10 min-w-10 items-center justify-center rounded-full bg-black/60 px-2 text-xs font-semibold tabular-nums text-white shadow-[var(--shadow-overlay)] ring-1 ring-white/15 backdrop-blur transition-colors hover:bg-black/75 active:bg-black/85 focus-visible:outline-2 focus-visible:outline-[var(--color-accent-bright)] landscape-phone:left-2 landscape-phone:top-2 landscape-phone:h-9 landscape-phone:min-w-9"
          >
            {speedButtonLabel}
          </button>
        )}

        {showFullscreenButton && (
          <button
            type="button"
            aria-label={fullscreenControlActive ? 'Exit fullscreen' : 'Enter fullscreen'}
            onClick={toggleFullscreen}
            className="pointer-events-auto absolute right-3 top-3 z-20 inline-flex h-10 w-10 items-center justify-center rounded-full bg-black/60 text-white shadow-[var(--shadow-overlay)] ring-1 ring-white/15 backdrop-blur transition-colors hover:bg-black/75 active:bg-black/85 focus-visible:outline-2 focus-visible:outline-[var(--color-accent-bright)] landscape-phone:right-2 landscape-phone:top-2 landscape-phone:h-9 landscape-phone:w-9"
          >
            {fullscreenControlActive ? <CollapseIcon /> : <ExpandIcon />}
          </button>
        )}

        {showPlaybackSettings && menuOpen && (
          <div
            role="menu"
            aria-label="Playback settings"
            className="absolute left-3 top-14 z-30 w-56 rounded-xl bg-black/85 p-2 text-sm text-white shadow-[var(--shadow-overlay)] ring-1 ring-white/15 backdrop-blur landscape-phone:left-2 landscape-phone:top-12 landscape-phone:w-52"
          >
            <label className="flex min-h-[44px] items-center justify-between gap-3 rounded-lg px-2 py-1">
              <span className="text-white/70">Speed</span>
              <select
                aria-label="Playback speed"
                value={rate}
                onChange={(e) => setRate(Number(e.target.value))}
                className="min-h-[44px] rounded-lg bg-white/10 px-2 py-1 text-xs font-semibold text-white focus-visible:outline-2 focus-visible:outline-[var(--color-accent-bright)]"
              >
                {SPEED_RATES.map((r) => (
                  <option key={r} value={r} className="text-black">
                    {speedLabel(r)}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              role="menuitemcheckbox"
              aria-checked={loop}
              aria-label="Repeat"
              onClick={() => setLoop((l) => !l)}
              className={`flex min-h-[44px] w-full items-center gap-2 rounded-lg px-2 text-left text-sm font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-[var(--color-accent-bright)] ${
                loop ? 'bg-white/15 text-white' : 'text-white/70 hover:bg-white/10 hover:text-white'
              }`}
            >
              <RepeatIcon />
              Repeat
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

function RepeatIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="17 1 21 5 17 9" />
      <path d="M3 11V9a4 4 0 0 1 4-4h14" />
      <polyline points="7 23 3 19 7 15" />
      <path d="M21 13v2a4 4 0 0 1-4 4H3" />
    </svg>
  )
}

function ExpandIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M15 3h6v6" />
      <path d="M9 21H3v-6" />
      <path d="M21 3l-7 7" />
      <path d="M3 21l7-7" />
    </svg>
  )
}

function CollapseIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9 3v6H3" />
      <path d="M15 21v-6h6" />
      <path d="M3 9l6-6" />
      <path d="M21 15l-6 6" />
    </svg>
  )
}
