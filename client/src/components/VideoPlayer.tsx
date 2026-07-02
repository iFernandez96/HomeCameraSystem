import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'

// Speed multipliers in the settings menu (the user's set: .25× → 4×). Browsers
// cap playbackRate well above 4×, so all are valid.
export const SPEED_RATES: ReadonlyArray<number> = [
  0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 4,
]

// A custom, YouTube-style video player: the native <video> control bar can't
// host a settings menu, so we hide it (`controls` off) and render our own bar
// — play/pause, a seek scrubber + time, a SETTINGS → playback-speed menu, and
// fullscreen. Controls auto-hide while playing. The underlying <video> keeps
// the iOS-tuned props (playsInline / preload / loop) and fires onTimeUpdate so
// consumers (ClipModal's bbox overlay, the timelapse clock) keep working; pass
// those overlays via `overlay`.

function fmtTime(s: number): string {
  if (!Number.isFinite(s) || s < 0) s = 0
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return `${m}:${String(sec).padStart(2, '0')}`
}

function speedLabel(rate: number): string {
  return rate === 1 ? 'Normal' : `${rate}×`
}

// HTMLMediaElement.play() returns a promise in browsers (reject on autoplay
// block) but `undefined` under jsdom — guard the .catch so neither crashes.
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
  /** Painted absolutely over the video, beneath the controls (bbox canvas,
   *  timestamp clock, …). */
  overlay?: ReactNode
  onTimeUpdate?: (video: HTMLVideoElement) => void
  onPlay?: () => void
  onError?: (video: HTMLVideoElement) => void
  /** Hands the underlying <video> element to the consumer (called once it
   *  mounts, and with null on unmount), so existing element-bound logic
   *  (ClipModal's bbox overlay) keeps working. Memoize it to avoid re-fires. */
  onVideoEl?: (el: HTMLVideoElement | null) => void
}) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const [playing, setPlaying] = useState(false)
  const [current, setCurrent] = useState(0)
  const [duration, setDuration] = useState(0)
  const [rate, setRate] = useState(initialRate)
  const [loop, setLoop] = useState(initialLoop)
  const [menuOpen, setMenuOpen] = useState(false)
  const [fsActive, setFsActive] = useState(false)
  const [controlsVisible, setControlsVisible] = useState(true)
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Hand the <video> element to the consumer (ClipModal binds its bbox overlay
  // to it). Calling a callback prop is compiler-safe (unlike mutating a ref
  // prop); the consumer stores it in its own ref.
  useEffect(() => {
    onVideoEl?.(videoRef.current)
    return () => onVideoEl?.(null)
  }, [onVideoEl])

  // Apply the chosen playback speed to the element (no React prop for it).
  useEffect(() => {
    if (videoRef.current) videoRef.current.playbackRate = rate
  }, [rate])

  // Best-effort autoplay (iOS ignores the attribute on a React key-remount).
  useEffect(() => {
    if (autoPlay && videoRef.current) {
      safePlay(videoRef.current)
    }
  }, [autoPlay])

  // Track fullscreen so the button + icon reflect actual state.
  useEffect(() => {
    const onChange = () =>
      setFsActive(document.fullscreenElement === containerRef.current)
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])

  // Auto-hide controls while playing; always show when paused / on activity.
  const armHide = useCallback(() => {
    if (hideTimer.current) clearTimeout(hideTimer.current)
    setControlsVisible(true)
    if (!videoRef.current || videoRef.current.paused) return
    hideTimer.current = setTimeout(() => setControlsVisible(false), 4000)
  }, [])

  // Auto-hide: mouse activity over the player re-shows the controls and
  // re-arms the hide timer. Touch is handled by the tap handler below
  // (bug sweep 2026-07-02: a touchstart listener here revealed the bar
  // a moment before the tap's click hid it again — flicker — and the
  // click ALSO paused playback, so on phones the Fullscreen button was
  // effectively unreachable while playing). Attached imperatively (not
  // as JSX handlers on the roled container) to keep jsx-a11y clean.
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    el.addEventListener('mousemove', armHide)
    return () => {
      el.removeEventListener('mousemove', armHide)
      if (hideTimer.current) clearTimeout(hideTimer.current)
    }
  }, [armHide])

  const togglePlay = useCallback(() => {
    const v = videoRef.current
    if (!v) return
    if (v.paused) safePlay(v)
    else v.pause()
  }, [])

  // Mobile-YouTube tap model (bug sweep 2026-07-02): on coarse
  // pointers a tap on the video toggles the CONTROL CHROME, never
  // playback — pausing lives on the play button. Desktop keeps
  // click-to-pause (the hover already keeps controls visible there).
  const isCoarse = useRef(
    typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(pointer: coarse)').matches,
  )
  const onSurfaceTap = useCallback(() => {
    if (!isCoarse.current) {
      togglePlay()
      return
    }
    setControlsVisible((visible) => {
      if (hideTimer.current) clearTimeout(hideTimer.current)
      if (visible) return false
      if (videoRef.current && !videoRef.current.paused) {
        hideTimer.current = setTimeout(() => setControlsVisible(false), 4000)
      }
      return true
    })
  }, [togglePlay])

  const toggleFullscreen = useCallback(() => {
    const el = containerRef.current
    if (!el) return
    if (document.fullscreenElement === el) {
      document.exitFullscreen?.()
    } else {
      el.requestFullscreen?.().catch(() => {})
    }
  }, [])

  const pct = duration > 0 ? (current / duration) * 100 : 0

  return (
    <div
      ref={containerRef}
      className={`group relative bg-black overflow-hidden ${containerClassName ?? className ?? ''}`}
    >
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <video
        ref={videoRef}
        src={src}
        loop={loop}
        playsInline
        preload={preload}
        className={`block ${videoClassName ?? 'w-full'}`}
        aria-label={ariaLabel}
        onClick={onSurfaceTap}
        onPlay={() => {
          setPlaying(true)
          armHide()
          onPlay?.()
        }}
        onPause={() => {
          setPlaying(false)
          setControlsVisible(true)
        }}
        onTimeUpdate={(e) => {
          const v = e.currentTarget
          setCurrent(v.currentTime)
          onTimeUpdate?.(v)
        }}
        onLoadedMetadata={(e) => setDuration(e.currentTarget.duration || 0)}
        onDurationChange={(e) => setDuration(e.currentTarget.duration || 0)}
        onError={(e) => onError?.(e.currentTarget)}
      />

      {/* Consumer overlays (bbox canvas / timestamp clock). */}
      {overlay}

      {/* Speed menu (YouTube-style settings panel). */}
      {menuOpen && (
        <div
          role="menu"
          aria-label="Playback speed"
          className="absolute bottom-14 right-2 z-20 max-h-[60%] overflow-auto rounded-lg bg-black/90 py-1 text-white shadow-xl ring-1 ring-white/15"
        >
          <p className="px-3 py-1 text-[11px] uppercase tracking-wide text-white/60">
            Playback speed
          </p>
          {SPEED_RATES.map((r) => (
            <button
              key={r}
              type="button"
              role="menuitemradio"
              aria-checked={rate === r}
              onClick={() => {
                setRate(r)
                setMenuOpen(false)
              }}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-white/15 focus-visible:bg-white/15 focus-visible:outline-none"
            >
              <span className="w-4 text-[var(--color-accent-bright)]" aria-hidden="true">
                {rate === r ? '✓' : ''}
              </span>
              <span className="tabular-nums">{r === 1 ? 'Normal' : `${r}×`}</span>
            </button>
          ))}
        </div>
      )}

      {/* Control bar. */}
      <div
        onPointerDown={armHide}
        className={`absolute inset-x-0 bottom-0 z-10 bg-gradient-to-t from-black/80 to-transparent px-2 pb-1.5 pt-6 transition-opacity duration-150 ${
          controlsVisible || !playing ? 'opacity-100' : 'opacity-0 pointer-events-none'
        }`}
      >
        {/* Scrubber. */}
        <input
          type="range"
          min={0}
          max={duration || 0}
          step="any"
          value={current}
          onChange={(e) => {
            const v = videoRef.current
            if (v) v.currentTime = Number(e.target.value)
          }}
          aria-label="Seek"
          aria-valuetext={`${fmtTime(current)} of ${fmtTime(duration)}`}
          // Responsiveness fix (user-reported): the visible track stays
          // a thin bar (content-box paint) but the INPUT is 28px tall —
          // a scrub you can actually grab with a thumb.
          className="h-7 py-3 w-full cursor-pointer appearance-none rounded-full bg-white/30 accent-[var(--color-accent-bright)] bg-clip-content"
          style={{
            backgroundImage: `linear-gradient(to right, var(--color-accent-bright) ${pct}%, rgba(255,255,255,0.3) ${pct}%)`,
          }}
        />
        <div className="mt-1 flex items-center gap-3 text-white">
          <button
            type="button"
            onClick={togglePlay}
            aria-label={playing ? 'Pause' : 'Play'}
            className="flex h-11 w-11 items-center justify-center rounded-full hover:bg-white/15 focus-visible:outline-2 focus-visible:outline-white"
          >
            {playing ? (
              <svg viewBox="0 0 24 24" className="h-5 w-5 fill-current" aria-hidden="true">
                <path d="M6 5h4v14H6zM14 5h4v14h-4z" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" className="h-5 w-5 fill-current" aria-hidden="true">
                <path d="M8 5v14l11-7z" />
              </svg>
            )}
          </button>
          <span className="font-mono text-xs tabular-nums text-white/90">
            {fmtTime(current)} / {fmtTime(duration)}
          </span>
          <div className="ml-auto flex items-center gap-1">
            <button
              type="button"
              onClick={() => setMenuOpen((o) => !o)}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              aria-label={`Playback speed (${speedLabel(rate)})`}
              className={`flex h-11 min-w-11 items-center justify-center gap-1 rounded-full px-2.5 text-xs font-semibold hover:bg-white/15 focus-visible:outline-2 focus-visible:outline-white ${
                rate !== 1 ? 'text-[var(--color-accent-bright)]' : ''
              }`}
            >
              <svg viewBox="0 0 24 24" className="h-4 w-4 fill-current" aria-hidden="true">
                <path d="M12 8a4 4 0 100 8 4 4 0 000-8zm8.94 4a6.9 6.9 0 00-.14-1.36l2.03-1.58-2-3.46-2.39.96a7 7 0 00-2.35-1.36L13.7 1h-4l-.39 2.84a7 7 0 00-2.35 1.36l-2.39-.96-2 3.46 2.03 1.58a6.9 6.9 0 000 2.72L.18 15.6l2 3.46 2.39-.96a7 7 0 002.35 1.36L9.3 23h4l.39-2.84a7 7 0 002.35-1.36l2.39.96 2-3.46-2.03-1.58c.09-.45.14-.9.14-1.36z" />
              </svg>
              <span className="tabular-nums">{speedLabel(rate)}</span>
            </button>
            <button
              type="button"
              onClick={() => setLoop((v) => !v)}
              aria-pressed={loop}
              aria-label="Repeat"
              className={`flex h-11 w-11 items-center justify-center rounded-full hover:bg-white/15 focus-visible:outline-2 focus-visible:outline-white ${
                loop ? 'text-[var(--color-accent-bright)]' : ''
              }`}
            >
              <svg viewBox="0 0 24 24" className="h-5 w-5 fill-current" aria-hidden="true">
                <path d="M7 7h10v3l4-4-4-4v3H5v6h2zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2z" />
              </svg>
            </button>
            <button
              type="button"
              onClick={toggleFullscreen}
              aria-label={fsActive ? 'Exit fullscreen' : 'Fullscreen'}
              className="flex h-11 w-11 items-center justify-center rounded-full hover:bg-white/15 focus-visible:outline-2 focus-visible:outline-white"
            >
              {fsActive ? (
                <svg viewBox="0 0 24 24" className="h-5 w-5 fill-current" aria-hidden="true">
                  <path d="M5 16h3v3h2v-5H5zM5 8h3V5h2v5H5zm9 11h2v-3h3v-2h-5zm2-11V5h-2v5h5V8z" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" className="h-5 w-5 fill-current" aria-hidden="true">
                  <path d="M7 14H5v5h5v-2H7zM5 10h2V7h3V5H5zm12 7h-3v2h5v-5h-2zM14 5v2h3v3h2V5z" />
                </svg>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
