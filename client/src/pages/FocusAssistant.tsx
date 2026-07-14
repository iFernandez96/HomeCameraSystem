import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { connectWhep, type WhepConnection } from '../lib/webrtc'
import { DEFAULT_CAMERA_PATH, whepUrlForPath } from '../lib/streamQuality'
import { errFields, log } from '../lib/log'

type Point = { x: number; y: number }
type StreamState = 'connecting' | 'live' | 'error'

const SAMPLE_SIZE = 320
const ROI_FRACTION = 0.22

function sharpnessOf(data: Uint8ClampedArray, width: number, height: number): number {
  let count = 0
  let sum = 0
  let sumSquares = 0
  const gray = (index: number) =>
    data[index] * 0.299 + data[index + 1] * 0.587 + data[index + 2] * 0.114

  for (let y = 1; y < height - 1; y += 2) {
    for (let x = 1; x < width - 1; x += 2) {
      const i = (y * width + x) * 4
      const laplacian =
        gray(i - width * 4) + gray(i + width * 4) + gray(i - 4) + gray(i + 4) - 4 * gray(i)
      sum += laplacian
      sumSquares += laplacian * laplacian
      count += 1
    }
  }
  if (!count) return 0
  const variance = sumSquares / count - (sum / count) ** 2
  return Math.max(0, variance)
}

export function FocusAssistant() {
  const navigate = useNavigate()
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const sampleCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const magnifierRef = useRef<HTMLCanvasElement | null>(null)
  const frameRef = useRef<HTMLDivElement | null>(null)
  const bestRawRef = useRef(0)
  const smoothedRef = useRef<number | null>(null)
  const previousRef = useRef<number | null>(null)
  const [target, setTarget] = useState<Point>({ x: 0.5, y: 0.5 })
  const targetRef = useRef(target)
  const [streamState, setStreamState] = useState<StreamState>('connecting')
  const [retry, setRetry] = useState(0)
  const [score, setScore] = useState(0)
  const [bestScore, setBestScore] = useState(0)
  const [trend, setTrend] = useState<'Improving' | 'Getting worse' | 'Hold steady'>('Hold steady')
  const [frozen, setFrozen] = useState(false)
  const frozenRef = useRef(frozen)

  useEffect(() => {
    targetRef.current = target
  }, [target])
  useEffect(() => {
    frozenRef.current = frozen
  }, [frozen])

  const finishAndBack = () => navigate('/settings')

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    const controller = new AbortController()
    let connection: WhepConnection | null = null
    let cancelled = false
    setStreamState('connecting')
    connectWhep(whepUrlForPath(`${DEFAULT_CAMERA_PATH}_uhq`), video, { signal: controller.signal })
      .then((next) => {
        if (cancelled) return next.close()
        connection = next
      })
      .catch((error) => {
        if (cancelled) return
        log.error('focusAssistant:whep-connect-failed', errFields(error))
        setStreamState('error')
      })
    const onPlaying = () => setStreamState('live')
    video.addEventListener('playing', onPlaying)
    video.addEventListener('loadeddata', onPlaying)
    return () => {
      cancelled = true
      controller.abort()
      video.removeEventListener('playing', onPlaying)
      video.removeEventListener('loadeddata', onPlaying)
      connection?.close()
    }
  }, [retry])

  useEffect(() => {
    const video = videoRef.current
    const sample = sampleCanvasRef.current
    const magnifier = magnifierRef.current
    if (!video || !sample || !magnifier) return
    const sampleContext = sample.getContext('2d', { willReadFrequently: true })
    const magnifierContext = magnifier.getContext('2d')
    if (!sampleContext || !magnifierContext) return

    let animation = 0
    let lastSample = 0
    const measure = (now: number) => {
      animation = requestAnimationFrame(measure)
      if (frozenRef.current || video.readyState < 2 || now - lastSample < 180) return
      lastSample = now
      const videoWidth = video.videoWidth
      const videoHeight = video.videoHeight
      if (!videoWidth || !videoHeight) return
      const side = Math.min(videoWidth, videoHeight) * ROI_FRACTION
      const x = Math.max(0, Math.min(videoWidth - side, targetRef.current.x * videoWidth - side / 2))
      const y = Math.max(0, Math.min(videoHeight - side, targetRef.current.y * videoHeight - side / 2))

      sampleContext.drawImage(video, x, y, side, side, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE)
      const pixels = sampleContext.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE)
      const raw = sharpnessOf(pixels.data, SAMPLE_SIZE, SAMPLE_SIZE)
      bestRawRef.current = Math.max(bestRawRef.current, raw)
      const smoothed = smoothedRef.current === null ? raw : smoothedRef.current * 0.72 + raw * 0.28
      smoothedRef.current = smoothed
      const normalized = bestRawRef.current > 0 ? Math.round((smoothed / bestRawRef.current) * 100) : 0
      const prior = previousRef.current
      if (prior !== null) {
        const change = smoothed - prior
        const threshold = Math.max(prior * 0.025, 0.5)
        setTrend(change > threshold ? 'Improving' : change < -threshold ? 'Getting worse' : 'Hold steady')
      }
      previousRef.current = smoothed
      setScore(Math.min(100, normalized))
      setBestScore((value) => Math.max(value, Math.min(100, normalized)))

      magnifierContext.imageSmoothingEnabled = false
      magnifierContext.drawImage(sample, 0, 0, magnifier.width, magnifier.height)
      const edgePixels = sampleContext.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE)
      for (let py = 1; py < SAMPLE_SIZE - 1; py += 2) {
        for (let px = 1; px < SAMPLE_SIZE - 1; px += 2) {
          const i = (py * SAMPLE_SIZE + px) * 4
          const left = edgePixels.data[i - 4]
          const right = edgePixels.data[i + 4]
          const up = edgePixels.data[i - SAMPLE_SIZE * 4]
          const down = edgePixels.data[i + SAMPLE_SIZE * 4]
          if (Math.abs(right - left) + Math.abs(down - up) > 75) {
            magnifierContext.fillStyle = 'rgba(255, 107, 47, .82)'
            magnifierContext.fillRect(
              (px / SAMPLE_SIZE) * magnifier.width,
              (py / SAMPLE_SIZE) * magnifier.height,
              3,
              3,
            )
          }
        }
      }
    }
    animation = requestAnimationFrame(measure)
    return () => cancelAnimationFrame(animation)
  }, [])

  const chooseTarget = (event: ReactPointerEvent<HTMLDivElement>) => {
    const rect = frameRef.current?.getBoundingClientRect()
    if (!rect) return
    setTarget({
      x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)),
    })
  }

  const resetBest = () => {
    bestRawRef.current = 0
    smoothedRef.current = null
    previousRef.current = null
    setScore(0)
    setBestScore(0)
    setTrend('Hold steady')
  }

  return (
    <section aria-labelledby="focus-heading" className="mx-auto max-w-5xl px-4 py-4 md:px-6 md:py-6">
      <header className="mb-4 flex items-center gap-3">
        <button
          type="button"
          onClick={finishAndBack}
          aria-label="Back to Settings"
          className="grid min-h-11 min-w-11 place-items-center rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] text-2xl text-[var(--color-text-primary)] focus-visible:outline-2 focus-visible:outline-[var(--color-accent-default)]"
        >
          ‹
        </button>
        <div>
          <h1 id="focus-heading" className="text-2xl font-semibold text-[var(--color-text-primary)]">Focus Assistant</h1>
          <p className="text-sm text-[var(--color-text-secondary)]">Tap the detail you want sharp, then slowly turn the lens.</p>
        </div>
      </header>

      <div className="mb-4 rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
        <p className="font-semibold text-[var(--color-text-primary)]">1080p precision preview</p>
        <p className="mt-1 text-sm text-[var(--color-text-secondary)]">
          Focus analysis uses a larger 320×320 sample on this phone. Detection remains on its separate 720p stream.
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.5fr)_minmax(280px,.7fr)]">
        <div
          ref={frameRef}
          onPointerDown={chooseTarget}
          className="relative aspect-video touch-none overflow-hidden rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-black"
        >
          <video ref={videoRef} autoPlay muted playsInline className="h-full w-full object-contain" />
          <div
            aria-hidden="true"
            className="pointer-events-none absolute h-[22%] w-[22%] -translate-x-1/2 -translate-y-1/2 rounded-xl border-2 border-[var(--color-accent-default)] shadow-[0_0_0_9999px_rgba(0,0,0,.15)]"
            style={{ left: `${target.x * 100}%`, top: `${target.y * 100}%` }}
          />
          {streamState !== 'live' && (
            <div className="absolute inset-0 grid place-items-center bg-black/65 text-center text-white">
              {streamState === 'connecting' ? (
                <p>Connecting to the camera…</p>
              ) : (
                <div>
                  <p className="mb-3">Camera preview unavailable.</p>
                  <button type="button" onClick={() => setRetry((value) => value + 1)} className="min-h-11 rounded-full bg-white px-5 font-semibold text-black">Retry</button>
                </div>
              )}
            </div>
          )}
        </div>

        <aside className="card-paper overflow-hidden">
          <div className="border-b border-[var(--color-border-subtle)] p-4">
            <div className="mb-2 flex items-baseline justify-between">
              <h2 className="font-semibold text-[var(--color-text-primary)]">Magnified target</h2>
              <span className="text-xs font-medium uppercase tracking-wider text-[var(--color-accent-default)]">Focus peaking</span>
            </div>
            <canvas ref={magnifierRef} width={480} height={300} className="aspect-[8/5] w-full rounded-xl bg-black object-cover" />
          </div>
          <div className="space-y-4 p-4">
            <div>
              <div className="flex items-end justify-between gap-3">
                <div>
                  <p className="text-sm text-[var(--color-text-secondary)]">Relative sharpness</p>
                  <p className="text-4xl font-semibold tabular-nums text-[var(--color-text-primary)]">{score}</p>
                </div>
                <div className="text-right">
                  <p className={`font-semibold ${trend === 'Improving' ? 'text-emerald-500' : trend === 'Getting worse' ? 'text-[var(--color-danger)]' : 'text-[var(--color-text-secondary)]'}`}>{trend}</p>
                  <p className="text-sm text-[var(--color-text-secondary)]">Best {bestScore}</p>
                </div>
              </div>
              <div className="mt-2 h-3 overflow-hidden rounded-full bg-[var(--color-border)]">
                <div className="h-full rounded-full bg-[var(--color-accent-default)] transition-[width] duration-150" style={{ width: `${score}%` }} />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <button type="button" onClick={() => setFrozen((value) => !value)} className="min-h-11 rounded-full border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-4 font-semibold text-[var(--color-text-primary)]">{frozen ? 'Resume' : 'Freeze'}</button>
              <button type="button" onClick={resetBest} className="min-h-11 rounded-full bg-[var(--color-ink)] px-4 font-semibold text-[var(--color-on-ink)]">Reset best</button>
            </div>
            <p className="text-xs leading-5 text-[var(--color-text-tertiary)]">The number is relative to this target and lighting—not a universal camera score. Aim for the highest stable reading.</p>
          </div>
        </aside>
      </div>
      <canvas ref={sampleCanvasRef} width={SAMPLE_SIZE} height={SAMPLE_SIZE} className="hidden" aria-hidden="true" />
    </section>
  )
}
