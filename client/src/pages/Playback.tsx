import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { VideoPlayer } from '../components/VideoPlayer'
import { Button } from '../components/primitives/Button'
import { CatEmptyState } from '../components/CatEmptyState'
import { ErrorState } from '../components/states/ErrorState'
import {
  downloadTimelineExport,
  getCameras,
  getDetectionConfig,
  getTimeline,
  getTimelineExport,
  startTimelineExport,
  type Camera,
  type TimelineExport,
  type TimelineBounds,
  type TimelineResponse,
  type TimelineSpan,
} from '../lib/api'
import { useToast } from '../lib/toast'

export const TIMELINE_MAX_RANGE_S = 24 * 60 * 60
export const TIMELINE_EXPORT_MAX_RANGE_S = 6 * 60 * 60

export function isValidDayKey(day: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false
  const [year, month, date] = day.split('-').map(Number)
  const parsed = new Date(year, month - 1, date)
  return (
    parsed.getFullYear() === year &&
    parsed.getMonth() === month - 1 &&
    parsed.getDate() === date
  )
}

export function localDayBounds(day: string): { since: number; until: number } {
  const [year, month, date] = day.split('-').map(Number)
  const start = new Date(year, month - 1, date)
  const end = new Date(year, month - 1, date + 1)
  return { since: start.getTime() / 1000, until: end.getTime() / 1000 }
}

/** Split a local calendar day at the server's inclusive maximum. Fall-back
 * DST days are 25 hours, so requesting the whole day in one call would 422. */
export function splitTimelineBounds(bounds: TimelineBounds): TimelineBounds[] {
  const windows: TimelineBounds[] = []
  for (let since = bounds.since_ts; since < bounds.until_ts; since += TIMELINE_MAX_RANGE_S) {
    windows.push({
      camera_id: bounds.camera_id,
      since_ts: since,
      until_ts: Math.min(bounds.until_ts, since + TIMELINE_MAX_RANGE_S),
    })
  }
  return windows
}

async function getTimelineRange(bounds: TimelineBounds): Promise<TimelineResponse> {
  const responses = await Promise.all(splitTimelineBounds(bounds).map(getTimeline))
  const seenMarkers = new Set<string>()
  return {
    v: 1,
    camera_id: bounds.camera_id,
    since_ts: bounds.since_ts,
    until_ts: bounds.until_ts,
    spans: responses.flatMap((response) => response.spans),
    gaps: responses.flatMap((response) => response.gaps),
    markers: responses
      .flatMap((response) => response.markers)
      .filter((marker) => {
        if (seenMarkers.has(marker.id)) return false
        seenMarkers.add(marker.id)
        return true
      }),
  }
}

function todayKey(): string {
  const date = new Date()
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function clock(ts: number): string {
  return new Date(ts * 1000).toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  })
}

function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}

export function Playback() {
  const [searchParams] = useSearchParams()
  const { showToast } = useToast()
  const [cameras, setCameras] = useState<Camera[]>([])
  const [cameraId, setCameraId] = useState(searchParams.get('camera') ?? 'front_door')
  const requestedDay = searchParams.get('day')
  const [day, setDay] = useState(
    requestedDay && isValidDayKey(requestedDay) ? requestedDay : todayKey(),
  )
  const bounds = useMemo(() => localDayBounds(day), [day])
  const initialAt = Number(searchParams.get('at'))
  const [cursorTs, setCursorTs] = useState(() =>
    Number.isFinite(initialAt) && initialAt > 0
      ? Math.max(bounds.since, Math.min(bounds.until - 1, initialAt))
      : bounds.since,
  )
  const [rangeStart, setRangeStart] = useState(bounds.since)
  const [rangeEnd, setRangeEnd] = useState(
    Math.min(bounds.until, bounds.since + TIMELINE_EXPORT_MAX_RANGE_S),
  )
  const [timeline, setTimeline] = useState<TimelineResponse | null>(null)
  const [privacyMode, setPrivacyMode] = useState<boolean | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<unknown>(null)
  const [exportJob, setExportJob] = useState<TimelineExport | null>(null)
  const [exportBusy, setExportBusy] = useState(false)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const cursorRef = useRef(cursorTs)
  const seekTargetRef = useRef(cursorTs)
  const [seekVersion, setSeekVersion] = useState(0)

  const seekCursor = useCallback((target: number) => {
    const clamped = Math.max(bounds.since, Math.min(bounds.until - 1, target))
    seekTargetRef.current = clamped
    setCursorTs(clamped)
    setSeekVersion((version) => version + 1)
  }, [bounds.since, bounds.until])

  useEffect(() => {
    cursorRef.current = cursorTs
  }, [cursorTs])

  useEffect(() => {
    let cancelled = false
    Promise.all([getCameras(), getDetectionConfig()])
      .then(([cameraResult, config]) => {
        if (cancelled) return
        setCameras(cameraResult.cameras)
        if (!cameraResult.cameras.some((camera) => camera.id === cameraId)) {
          setCameraId(cameraResult.cameras[0]?.id ?? 'front_door')
        }
        setPrivacyMode(config.operating_mode === 'privacy')
      })
      .catch((reason) => {
        if (!cancelled) setError(reason)
      })
    return () => {
      cancelled = true
    }
  }, [cameraId])

  useEffect(() => {
    if (privacyMode === null) return
    if (privacyMode) {
      Promise.resolve().then(() => {
        setTimeline(null)
        setLoading(false)
      })
      return
    }
    let cancelled = false
    Promise.resolve().then(() => {
      if (!cancelled) setLoading(true)
    })
    getTimelineRange({ camera_id: cameraId, since_ts: bounds.since, until_ts: bounds.until })
      .then((value) => {
        if (cancelled) return
        setTimeline(value)
        const firstSpan = value.spans[0]
        const lastSpan = value.spans[value.spans.length - 1]
        if (firstSpan && lastSpan) {
          const availableEnd = Math.min(bounds.until, lastSpan.end_ts)
          const availableStart = Math.max(
            bounds.since,
            firstSpan.start_ts,
            availableEnd - TIMELINE_EXPORT_MAX_RANGE_S,
          )
          const currentCursor = cursorRef.current
          const nextCursor =
            currentCursor >= firstSpan.start_ts && currentCursor < availableEnd
              ? currentCursor
              : lastSpan.start_ts
          seekCursor(nextCursor)
          setRangeStart(availableStart)
          setRangeEnd(availableEnd)
        } else {
          seekCursor(bounds.since)
          setRangeStart(bounds.since)
          setRangeEnd(
            Math.min(bounds.until, bounds.since + TIMELINE_EXPORT_MAX_RANGE_S),
          )
        }
        setError(null)
      })
      .catch((reason) => {
        if (!cancelled) setError(reason)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [cameraId, bounds.since, bounds.until, privacyMode, seekCursor])

  useEffect(() => {
    if (!exportJob || !['pending', 'running'].includes(exportJob.status)) return
    let cancelled = false
    const poll = () => {
      getTimelineExport(exportJob.id)
        .then((job) => {
          if (!cancelled) setExportJob(job)
        })
        .catch(() => {
          if (!cancelled) {
            setExportJob((current) =>
              current
                ? {
                    ...current,
                    status: 'failed',
                    error: 'Could not check export progress.',
                  }
                : current,
            )
          }
        })
    }
    const timer = window.setInterval(poll, 1500)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [exportJob])

  const activeSpan = useMemo(
    () => timeline?.spans.find((span) => cursorTs >= span.start_ts && cursorTs < span.end_ts) ?? null,
    [cursorTs, timeline],
  )

  const bindVideo = useCallback((video: HTMLVideoElement | null) => {
    videoRef.current = video
  }, [])

  useEffect(() => {
    const video = videoRef.current
    if (!video || !activeSpan) return
    const target = seekTargetRef.current
    const seek = () => {
      video.currentTime = Math.max(0, target - activeSpan.start_ts)
    }
    if (video.readyState >= HTMLMediaElement.HAVE_METADATA) seek()
    else video.addEventListener('loadedmetadata', seek, { once: true })
    return () => video.removeEventListener('loadedmetadata', seek)
  }, [activeSpan, seekVersion])

  const moveCursor = (delta: number) => {
    seekCursor(cursorRef.current + delta)
  }

  const beginExport = async () => {
    const safeStart = Math.max(bounds.since, Math.min(rangeStart, bounds.until - 1))
    const safeEnd = Math.min(
      bounds.until,
      rangeEnd,
      safeStart + TIMELINE_EXPORT_MAX_RANGE_S,
    )
    if (exportBusy || safeEnd <= safeStart) return
    setRangeStart(safeStart)
    setRangeEnd(safeEnd)
    setExportBusy(true)
    try {
      const job = await startTimelineExport({
        camera_id: cameraId,
        since_ts: safeStart,
        until_ts: safeEnd,
      })
      setExportJob(job)
      showToast('Timeline export started', 'success')
    } catch {
      showToast('Could not start timeline export', 'error')
    } finally {
      setExportBusy(false)
    }
  }

  const downloadExport = async () => {
    if (!exportJob || exportJob.status !== 'ready') return
    try {
      saveBlob(await downloadTimelineExport(exportJob.id), `homecam-${cameraId}-${day}.mp4`)
    } catch {
      showToast('Could not download timeline export', 'error')
    }
  }

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="page-title text-2xl text-[var(--color-text-primary)]">Playback</h1>
          <p className="mt-1 text-sm text-[var(--color-text-secondary)]">Review recorded spans and visible gaps.</p>
        </div>
        <Link to="/events" className="inline-flex min-h-11 items-center rounded-full px-3 text-sm font-semibold text-[var(--color-accent-deep)] focus-visible:outline-2 focus-visible:outline-[var(--color-accent-default)]">
          Back to events
        </Link>
      </header>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm font-medium text-[var(--color-text-secondary)]">
          Camera
          <select value={cameraId} onChange={(event) => setCameraId(event.target.value)} className="mt-1 min-h-11 w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-base text-[var(--color-text-primary)]">
            {cameras.length === 0 ? <option value={cameraId}>{cameraId}</option> : null}
            {cameras.map((camera) => <option key={camera.id} value={camera.id}>{camera.name}</option>)}
          </select>
        </label>
        <label className="text-sm font-medium text-[var(--color-text-secondary)]">
          Day
          <input type="date" value={day} onChange={(event) => {
            const nextDay = event.target.value
            if (!isValidDayKey(nextDay)) return
            const nextBounds = localDayBounds(nextDay)
            setDay(nextDay)
            seekTargetRef.current = nextBounds.since
            setCursorTs(nextBounds.since)
            setSeekVersion((version) => version + 1)
            setRangeStart(nextBounds.since)
            setRangeEnd(Math.min(nextBounds.until, nextBounds.since + TIMELINE_EXPORT_MAX_RANGE_S))
          }} className="mt-1 min-h-11 w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-base text-[var(--color-text-primary)]" />
        </label>
      </div>

      {error ? (
        <ErrorState title="Could not load playback" message="Check the camera connection and try again." technicalDetail={error instanceof Error ? error.message : String(error)} />
      ) : privacyMode ? (
        <section className="flex aspect-video items-center justify-center rounded-[var(--radius-2xl)] bg-black px-6 text-center text-white" aria-label="Playback unavailable in privacy mode">
          <div>
            <p className="font-semibold">Privacy mode is on</p>
            <p className="mt-1 text-sm text-white/70">History is unavailable while the camera is private. This is not a quiet-footage gap.</p>
          </div>
        </section>
      ) : privacyMode === null || loading ? (
        <div className="aspect-video animate-pulse rounded-[var(--radius-2xl)] bg-[var(--color-surface-raised)]" role="status" aria-label="Loading playback" />
      ) : timeline === null || timeline.spans.length === 0 ? (
        <CatEmptyState heading="No recording spans" body="This day contains no stored continuous footage. Gaps are shown as unavailable, not as quiet video." />
      ) : (
        <>
          <section aria-label="Timeline player" className="space-y-3">
            {activeSpan ? (
              <VideoPlayer
                key={activeSpan.id}
                src={activeSpan.url}
                ariaLabel={`Recorded video at ${clock(cursorTs)}`}
                controlsList="nofullscreen"
                showPlaybackSettings
                showFullscreenButton
                onVideoEl={bindVideo}
                onTimeUpdate={(video) => setCursorTs(Math.min(activeSpan.end_ts, activeSpan.start_ts + video.currentTime))}
                containerClassName="aspect-video w-full rounded-[var(--radius-2xl)] border border-[var(--color-border)] shadow-[var(--shadow-overlay)]"
                videoClassName="h-full w-full object-contain"
                fillHeight
              />
            ) : (
              <div className="flex aspect-video items-center justify-center rounded-[var(--radius-2xl)] bg-black px-4 text-center text-white" role="status">
                No recording at {clock(cursorTs)}
              </div>
            )}
            <div className="flex items-center justify-center gap-3">
              <Button variant="secondary" onClick={() => moveCursor(-10)} aria-label="Back 10 seconds">−10 s</Button>
              <span className="min-w-24 text-center text-sm font-semibold tabular-nums">{clock(cursorTs)}</span>
              <Button variant="secondary" onClick={() => moveCursor(10)} aria-label="Forward 10 seconds">+10 s</Button>
            </div>
            <label className="block text-xs font-medium text-[var(--color-text-secondary)]">
              Playback time
              <input
                type="range"
                min={bounds.since}
                max={bounds.until - 1}
                step="1"
                value={cursorTs}
                onChange={(event) => seekCursor(Number(event.target.value))}
                aria-valuetext={clock(cursorTs)}
                className="slider mt-2 w-full"
              />
            </label>
            <div className="relative h-8 overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-raised)]" aria-label="Recording spans and event markers">
              {timeline.spans.map((span) => <TimelineBlock key={span.id} span={span} since={bounds.since} until={bounds.until} />)}
              {timeline.markers.map((marker) => {
                const left = ((marker.ts - bounds.since) / (bounds.until - bounds.since)) * 100
                return <span key={marker.id} title={marker.person_name ?? marker.label} className="absolute top-0 h-full w-0.5 bg-[var(--color-accent-default)]" style={{ left: `${left}%` }} />
              })}
            </div>
          </section>

          <section className="card-paper space-y-3 p-4" aria-labelledby="range-export-h2">
            <h2 id="range-export-h2" className="text-lg font-semibold">Export a time range</h2>
            <p className="text-xs text-[var(--color-text-secondary)]">Exports are capped at six hours and skip unrecorded gaps.</p>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="text-xs text-[var(--color-text-secondary)]">Start: {clock(rangeStart)}<input type="range" min={bounds.since} max={Math.max(bounds.since, rangeEnd - 1)} value={rangeStart} onChange={(event) => {
                const nextStart = Number(event.target.value)
                setRangeStart(nextStart)
                setRangeEnd((current) => Math.min(current, bounds.until, nextStart + TIMELINE_EXPORT_MAX_RANGE_S))
              }} className="slider mt-2 w-full" /></label>
              <label className="text-xs text-[var(--color-text-secondary)]">End: {clock(rangeEnd)}<input type="range" min={rangeStart + 1} max={Math.min(bounds.until, rangeStart + TIMELINE_EXPORT_MAX_RANGE_S)} value={rangeEnd} onChange={(event) => setRangeEnd(Number(event.target.value))} className="slider mt-2 w-full" /></label>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <Button onClick={() => void beginExport()} loading={exportBusy} loadingText="Starting…">Export range</Button>
              {exportJob ? <span role="status" className="text-sm text-[var(--color-text-secondary)]">Export {exportJob.status}{exportJob.error ? `: ${exportJob.error}` : ''}</span> : null}
              {exportJob?.status === 'ready' ? <Button variant="secondary" onClick={() => void downloadExport()}>Download video</Button> : null}
            </div>
          </section>
        </>
      )}
    </div>
  )
}

function TimelineBlock({ span, since, until }: { span: TimelineSpan; since: number; until: number }) {
  const left = ((span.start_ts - since) / (until - since)) * 100
  const width = ((span.end_ts - span.start_ts) / (until - since)) * 100
  return <span aria-hidden="true" className="absolute inset-y-0 bg-[var(--color-id-person-soft)]" style={{ left: `${left}%`, width: `${Math.max(width, 0.15)}%` }} />
}
