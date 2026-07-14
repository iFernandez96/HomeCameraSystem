import { Link, Navigate, useSearchParams } from 'react-router-dom'
import { ActivityNav } from '../components/ActivityNav'
import { VisitList } from './Visits'

export function Activity() {
  const [params] = useSearchParams()
  const eventId = params.get('event')
  if (eventId) {
    return <Navigate to={`/events/detections?event=${encodeURIComponent(eventId)}`} replace />
  }
  return (
    <section aria-labelledby="activity-h1" className="mx-auto max-w-4xl space-y-4 p-4">
      <header>
        <h1 id="activity-h1" className="page-title text-3xl text-[var(--color-text-primary)]">Activity</h1>
        <p className="mt-1 text-sm text-[var(--color-text-secondary)]">Arrivals, departures, and what happened between them.</p>
      </header>
      <ActivityNav />
      <VisitList showHeader={false} />
      <Link to="/events/detections" className="card-paper flex min-h-14 items-center justify-between gap-3 p-4 font-semibold text-[var(--color-accent-deep)]">
        <span>
          <span className="block">Individual detections</span>
          <span className="block text-xs font-normal text-[var(--color-text-secondary)]">Advanced timeline, thumbnails, calendar and exact filters</span>
        </span>
        <span aria-hidden="true">›</span>
      </Link>
    </section>
  )
}
