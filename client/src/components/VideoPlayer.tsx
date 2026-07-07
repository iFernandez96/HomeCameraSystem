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
  const p = v.play()
  if (p && typeof p.catch === 'function') p.catch(() => {})
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
  poster,
  fillHeight = false,
  overlay,
  onTimeUpdate,
  onPlay,
  onError,
  onVideoEl,
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
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const [rate, setRate] = useState(initialRate)
  const [loop, setLoop] = useState(initialLoop)

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

  return (
    <div
      className={`flex flex-col bg-black overflow-hidden ${containerClassName ?? className ?? ''}`}
    >
      <div className={`relative min-h-0 ${fillHeight ? 'flex-1' : ''}`}>
        {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
        <video
          ref={videoRef}
          src={src}
          controls
          loop={loop}
          playsInline
          preload={preload}
          poster={poster}
          className={`block ${videoClassName ?? 'w-full'}`}
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
      </div>

      {/* Speed + repeat strip — the two controls the native bar lacks. */}
      <div className="flex items-center gap-3 bg-black px-3 py-1.5 text-xs text-white/85">
        <label className="flex items-center gap-1.5">
          <span className="text-white/60">Speed</span>
          <select
            aria-label="Playback speed"
            value={rate}
            onChange={(e) => setRate(Number(e.target.value))}
            className="min-h-[36px] rounded-lg bg-white/10 px-2 py-1 text-xs font-semibold text-white focus-visible:outline-2 focus-visible:outline-[var(--color-accent-bright)]"
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
          aria-pressed={loop}
          aria-label="Repeat"
          onClick={() => setLoop((l) => !l)}
          className={`ml-auto inline-flex min-h-[36px] items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-[var(--color-accent-bright)] ${
            loop ? 'bg-white/20 text-white' : 'text-white/60 hover:text-white'
          }`}
        >
          <RepeatIcon />
          Repeat
        </button>
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
