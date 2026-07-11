import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { CatEmptyState } from '../components/CatEmptyState'
import { ErrorState } from '../components/states/ErrorState'
import { listVisitStories, type VisitStory } from '../lib/api'

function visitDuration(visit: VisitStory): string {
  const seconds = Math.max(0, Math.round(visit.end_ts - visit.start_ts))
  const minutes = Math.floor(seconds / 60)
  return minutes > 0 ? `${minutes}m ${seconds % 60}s` : `${seconds}s`
}

function visitTitle(visit: VisitStory): string {
  if (visit.people.length > 0) return visit.people.join(', ')
  if (visit.labels.length > 0) return visit.labels.join(', ').replaceAll('_', ' ')
  return 'Unidentified visit'
}

export function Visits() {
  const [visits, setVisits] = useState<VisitStory[] | null>(null)
  const [error, setError] = useState<unknown>(null)

  useEffect(() => {
    let cancelled = false
    listVisitStories()
      .then((result) => {
        if (!cancelled) setVisits(result.items)
      })
      .catch((reason) => {
        if (!cancelled) setError(reason)
      })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-4">
      <header className="flex items-start justify-between gap-3">
        <div>
          <h1 className="page-title text-2xl text-[var(--color-text-primary)]">Visits</h1>
          <p className="mt-1 text-sm text-[var(--color-text-secondary)]">
            Related moments grouped into one arrival-to-departure story.
          </p>
        </div>
        <Link to="/events" className="inline-flex min-h-11 items-center rounded-full px-3 text-sm font-semibold text-[var(--color-accent-deep)]">
          Back
        </Link>
      </header>

      {error ? (
        <ErrorState
          title="Could not load visits"
          message="Check the connection and try again."
          technicalDetail={error instanceof Error ? error.message : String(error)}
        />
      ) : visits === null ? (
        <p role="status" className="py-8 text-center text-sm text-[var(--color-text-secondary)]">
          Loading visits…
        </p>
      ) : visits.length === 0 ? (
        <CatEmptyState
          mood="watching"
          heading="No visit stories yet"
          body="Related events will appear here after someone or something moves through the camera view."
        />
      ) : (
        <ol className="space-y-3">
          {visits.map((visit) => (
            <li key={visit.id}>
              <Link
                to={`/events/visits/${encodeURIComponent(visit.id)}`}
                className="card-paper flex min-h-16 items-center gap-3 p-4 focus-visible:outline-2 focus-visible:outline-[var(--color-accent-default)] focus-visible:outline-offset-2"
                aria-label={`Open visit: ${visitTitle(visit)}`}
              >
                <span className="min-w-0 flex-1">
                  <span className="block font-semibold capitalize text-[var(--color-text-primary)]">
                    {visitTitle(visit)}
                  </span>
                  <span className="block text-xs text-[var(--color-text-secondary)]">
                    {new Date(visit.start_ts * 1000).toLocaleString()} · {visitDuration(visit)} · {visit.events.length} {visit.events.length === 1 ? 'moment' : 'moments'}
                  </span>
                </span>
                <span aria-hidden="true">›</span>
              </Link>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}
