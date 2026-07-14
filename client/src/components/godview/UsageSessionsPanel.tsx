import { useState } from 'react'
import { Link } from 'react-router-dom'
import { CatEmptyState } from '../CatEmptyState'
import type { UsageSession } from '../../lib/api'

const LOCATION_LABELS: Record<UsageSession['ip_class'], string> = {
  lan: 'LAN',
  tailscale: 'Tailscale',
  cellular: 'Cellular / public',
  other: 'Unknown network',
}

function duration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

function dateTime(ts: number): string {
  return new Date(ts * 1000).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

function pageLabel(path: string): string {
  if (path === '/') return 'Live camera'
  if (path.startsWith('/events/visits')) return 'Visit history'
  if (path.startsWith('/events')) return 'Events'
  if (path.startsWith('/people')) return 'People'
  if (path.startsWith('/settings')) return 'Settings'
  if (path.startsWith('/god')) return 'God View'
  return path
}

function actionLabel(value: string): string {
  const [, path = value] = value.split(' ', 2)
  if (path === '/api/capture') return 'Took a snapshot'
  if (path.includes('/camera/exposure-presets')) {
    return value.startsWith('DELETE') ? 'Deleted an exposure preset' : 'Changed exposure presets'
  }
  if (path.includes('/camera/exposure')) return 'Changed camera exposure'
  if (path.includes('/detection/config')) return 'Changed detection settings'
  if (path.includes('/events/mark-seen')) return 'Marked events as seen'
  if (path.includes('/events/') && value.startsWith('DELETE')) return 'Deleted an event'
  if (path.includes('/security/mode')) return 'Changed security mode'
  if (path.includes('/privacy')) return 'Changed privacy settings'
  if (path.includes('/recover')) return 'Started camera recovery'
  if (path.includes('/timelapse')) return 'Changed a timelapse'
  if (path.includes('/backup')) return 'Ran a backup action'
  const readable = path
    .replace(/^\/api\//, '')
    .replaceAll('/:id', '')
    .replaceAll(/[-_/]+/g, ' ')
    .trim()
  return `${value.split(' ', 1)[0].toLowerCase()} ${readable}`
}

function timelineLabel(item: UsageSession['timeline'][number]): string {
  if (item.kind === 'page') return `Viewed ${pageLabel(item.name)} for ${duration(item.dwell_ms)}`
  if (item.kind === 'event') return `Opened event ${item.name} for ${duration(item.dwell_ms)}`
  return actionLabel(item.name)
}

function EventViewLink({ eventId, dwellMs }: { eventId: string; dwellMs?: number }) {
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <Link
        to={`/events?event=${encodeURIComponent(eventId)}`}
        className="inline-flex min-h-9 items-center rounded-full border border-[var(--color-accent-default)] px-3 py-1 text-sm font-semibold text-[var(--color-accent-default)] hover:bg-[var(--color-accent-subtle)] focus-visible:outline-2 focus-visible:outline-[var(--color-accent-default)] focus-visible:outline-offset-2"
      >
        View event
      </Link>
      {dwellMs != null ? <span className="text-[var(--color-text-secondary)]">Viewed for {duration(dwellMs)}</span> : null}
      <code className="text-xs text-[var(--color-text-tertiary)]" title="Exact event identifier">{eventId}</code>
    </span>
  )
}

function SessionCard({ session }: { session: UsageSession }) {
  const [trailOpen, setTrailOpen] = useState(false)
  const distinctScreens = session.pages.length
  return (
    <article
      aria-labelledby={`usage-session-${session.id}`}
      className="rounded-lg border-[1.5px] border-[var(--color-border)] bg-[var(--color-surface)] p-4 shadow-[var(--shadow-subtle)]"
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h3 id={`usage-session-${session.id}`} className="font-semibold text-[var(--color-text-primary)]">
            {session.username}
          </h3>
          <p className="text-sm text-[var(--color-text-secondary)]">
            {session.device_label} · {LOCATION_LABELS[session.ip_class]}
          </p>
        </div>
        <div className="text-left text-xs tabular-nums text-[var(--color-text-tertiary)] sm:text-right">
          <p>Started {dateTime(session.started_ts)}</p>
          <p>Last activity {dateTime(session.last_activity_ts)}</p>
        </div>
      </div>

      {session.legacy ? (
        <p className="mt-3 rounded-md bg-[var(--color-warning-bg)] px-3 py-2 text-xs text-[var(--color-warning)]">
          Older activity was recorded before device-session attribution; it is grouped by user without claiming a device.
        </p>
      ) : null}

      <dl className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <div className="rounded-md bg-[var(--color-surface-raised)] p-3">
          <dt className="text-xs text-[var(--color-text-secondary)]">Screen time</dt>
          <dd className="mt-1 font-semibold tabular-nums text-[var(--color-text-primary)]">{duration(session.screen_time_ms)}</dd>
        </div>
        <div className="rounded-md bg-[var(--color-surface-raised)] p-3">
          <dt className="text-xs text-[var(--color-text-secondary)]">Screens</dt>
          <dd className="mt-1 font-semibold tabular-nums text-[var(--color-text-primary)]">{distinctScreens}</dd>
        </div>
        <div className="rounded-md bg-[var(--color-surface-raised)] p-3">
          <dt className="text-xs text-[var(--color-text-secondary)]">Events opened</dt>
          <dd className="mt-1 font-semibold tabular-nums text-[var(--color-text-primary)]">{session.event_view_count}</dd>
        </div>
        <div className="rounded-md bg-[var(--color-surface-raised)] p-3">
          <dt className="text-xs text-[var(--color-text-secondary)]">Actions</dt>
          <dd className="mt-1 font-semibold tabular-nums text-[var(--color-text-primary)]">{session.action_count}</dd>
        </div>
      </dl>

      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <div>
          <h4 className="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-secondary)]">Looked at</h4>
          {session.pages.length ? (
            <ol className="mt-2 space-y-1.5 text-sm">
              {session.pages.slice(0, 5).map((page) => (
                <li key={page.name} className="flex justify-between gap-3 text-[var(--color-text-primary)]">
                  <span>{pageLabel(page.name)}</span>
                  <span className="shrink-0 tabular-nums text-[var(--color-text-secondary)]">{duration(page.dwell_ms)}</span>
                </li>
              ))}
            </ol>
          ) : <p className="mt-2 text-sm text-[var(--color-text-tertiary)]">No completed screen spans yet.</p>}
        </div>
        <div>
          <h4 className="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-secondary)]">Did</h4>
          {session.actions.length || session.event_view_count ? (
            <ul className="mt-2 space-y-1.5 text-sm text-[var(--color-text-primary)]">
              {session.events.slice(0, 5).map((event) => (
                <li key={event.name}><EventViewLink eventId={event.name} dwellMs={event.dwell_ms} /></li>
              ))}
              {session.actions.slice(0, 5).map((action) => (
                <li key={action.name}>{actionLabel(action.name)}{action.count > 1 ? ` ×${action.count}` : ''}</li>
              ))}
            </ul>
          ) : <p className="mt-2 text-sm text-[var(--color-text-tertiary)]">No recorded actions.</p>}
        </div>
      </div>

      <details
        className="mt-4 border-t border-[var(--color-border-subtle)] pt-3"
        onToggle={(event) => setTrailOpen(event.currentTarget.open)}
      >
        <summary className="min-h-11 cursor-pointer py-2 text-sm font-semibold text-[var(--color-accent-default)]">
          Show activity trail ({session.timeline.length})
        </summary>
        {trailOpen ? (
          <ol className="mt-2 space-y-2" aria-label={`${session.username} session activity`}>
            {session.timeline.map((item, index) => (
              <li key={`${item.ts}-${item.kind}-${item.name}-${index}`} className="grid gap-1 text-sm sm:grid-cols-[9rem_1fr]">
                <time className="tabular-nums text-[var(--color-text-tertiary)]" dateTime={new Date(item.ts * 1000).toISOString()}>{dateTime(item.ts)}</time>
                <span className="text-[var(--color-text-primary)]">
                  {item.kind === 'event'
                    ? <EventViewLink eventId={item.name} dwellMs={item.dwell_ms} />
                    : timelineLabel(item)}
                </span>
              </li>
            ))}
          </ol>
        ) : null}
      </details>
    </article>
  )
}

export function UsageSessionsPanel({ sessions }: { sessions: UsageSession[] }) {
  return (
    <section aria-labelledby="usage-sessions-heading" className="space-y-3">
      <div>
        <h2 id="usage-sessions-heading" className="text-lg font-semibold text-[var(--color-text-primary)]">App usage sessions</h2>
        <p className="mt-1 text-sm text-[var(--color-text-secondary)]">
          What each signed-in person looked at and did, grouped by device session rather than raw log rows.
        </p>
      </div>
      {sessions.length === 0 ? (
        <div className="rounded-lg border-[1.5px] border-[var(--color-border)] bg-[var(--color-surface)]">
          <CatEmptyState heading="No app activity in this range" body="Completed screen views and actions will appear here." mood="watching" />
        </div>
      ) : (
        <div className="space-y-3">
          {sessions.map((session) => <SessionCard key={session.id} session={session} />)}
        </div>
      )}
    </section>
  )
}
