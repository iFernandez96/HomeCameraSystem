import { useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ClipModal } from '../components/ClipModal'
import { EventRow } from '../components/EventRow'
import { EventVideoStatusIcon } from '../components/EventVideoStatusIcon'
import { CatEmptyState } from '../components/CatEmptyState'
import { ErrorState } from '../components/states/ErrorState'
import { getCameras, getVisitStory, type Camera, type VisitStory } from '../lib/api'
import type { DetectionEvent } from '../lib/types'

function duration(story: VisitStory): string {
  const seconds = Math.max(0, Math.round(story.end_ts - story.start_ts))
  const minutes = Math.floor(seconds / 60)
  return minutes ? `${minutes}m ${seconds % 60}s` : `${seconds}s`
}

export function VisitViewer() {
  const { id = '' } = useParams()
  const [story, setStory] = useState<VisitStory | null>(null)
  const [cameras, setCameras] = useState<Camera[]>([])
  const [cameraId, setCameraId] = useState<string | null>(null)
  const [selected, setSelected] = useState<DetectionEvent | null>(null)
  const [error, setError] = useState<unknown>(null)

  useEffect(() => {
    let cancelled = false
    Promise.all([getVisitStory(id), getCameras()])
      .then(([visit, cameraResult]) => {
        if (cancelled) return
        setStory(visit)
        setCameras(cameraResult.cameras)
        setCameraId(visit.camera_ids[0] ?? null)
      })
      .catch((reason) => {
        if (!cancelled) setError(reason)
      })
    return () => {
      cancelled = true
    }
  }, [id])

  const visibleEvents = useMemo(
    () => story?.events.filter((event) => cameraId === null || event.camera_id === cameraId) ?? [],
    [cameraId, story],
  )
  const cameraName = (value: string) => cameras.find((camera) => camera.id === value)?.name ?? value

  if (error) return <div className="p-4"><ErrorState title="Could not load visit" message="The visit may no longer be available." technicalDetail={error instanceof Error ? error.message : String(error)} /></div>
  if (!story) return <div className="p-4" role="status">Loading visit…</div>

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-4">
      <header className="flex items-start justify-between gap-3">
        <div>
          <h1 className="page-title text-2xl text-[var(--color-text-primary)]">Visit story</h1>
          <p className="mt-1 text-sm text-[var(--color-text-secondary)]">
            {new Date(story.start_ts * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}–{new Date(story.end_ts * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} · {duration(story)} · {story.people.length ? story.people.join(', ') : story.labels.join(', ')}
          </p>
        </div>
        <Link to="/events/visits" className="inline-flex min-h-11 items-center rounded-full px-3 text-sm font-semibold text-[var(--color-accent-deep)]">All visits</Link>
      </header>

      <section aria-labelledby="visit-coverage-h2" className="card-paper space-y-3 p-4">
        <div>
          <h2 id="visit-coverage-h2" className="font-semibold">Visit coverage</h2>
          <p className="text-xs text-[var(--color-text-secondary)]">{story.camera_ids.length} {story.camera_ids.length === 1 ? 'camera' : 'cameras'} · {story.events.length} recorded {story.events.length === 1 ? 'moment' : 'moments'}</p>
        </div>
        <ol className="flex gap-2 overflow-x-auto pb-1" aria-label="Chronological video coverage">
          {story.events.map((event) => (
            <li key={event.id}>
              <button type="button" onClick={() => setSelected(event)} className="flex min-h-14 min-w-24 flex-col items-start justify-center rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-3 text-left">
                <span className="flex items-center gap-1.5 text-xs font-semibold">
                  <EventVideoStatusIcon status={event.video_status ?? 'unknown'} />
                  {new Date(event.ts * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                </span>
                <span className="mt-1 max-w-28 truncate text-[10px] text-[var(--color-text-secondary)]">{cameraName(event.camera_id)}</span>
              </button>
            </li>
          ))}
        </ol>
      </section>

      {story.camera_ids.length > 1 ? (
        <div role="radiogroup" aria-label="Visit camera" className="flex gap-2 overflow-x-auto pb-1">
          {story.camera_ids.map((idValue) => (
            <button
              key={idValue}
              type="button"
              role="radio"
              aria-checked={cameraId === idValue}
              onClick={() => setCameraId(idValue)}
              className={`min-h-11 shrink-0 rounded-full border px-4 text-sm font-semibold ${cameraId === idValue ? 'border-[var(--color-ink)] bg-[var(--color-ink)] text-[var(--color-on-ink)]' : 'border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-primary)]'}`}
            >
              {cameraName(idValue)}
            </button>
          ))}
        </div>
      ) : null}

      <section aria-labelledby="visit-events-h2" className="space-y-3">
        <h2 id="visit-events-h2" className="text-lg font-semibold">Recorded moments</h2>
        {visibleEvents.length === 0 ? (
          <CatEmptyState heading="No clip from this camera" body="Another camera may have recorded this part of the visit." />
        ) : (
          <ol className="space-y-2">
            {visibleEvents.map((event) => (
              <li key={event.id}>
                <EventRow event={event} subline={cameraName(event.camera_id)} onOpen={() => setSelected(event)} />
              </li>
            ))}
          </ol>
        )}
      </section>
      {selected ? <ClipModal event={selected} onClose={() => setSelected(null)} /> : null}
    </div>
  )
}
