import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Button } from '../components/primitives/Button'
import { CatEmptyState } from '../components/CatEmptyState'
import { ErrorState } from '../components/states/ErrorState'
import { createIncident, listIncidents, type IncidentSummary } from '../lib/api'
import { useToast } from '../lib/toast'
import { useAuth } from '../lib/auth'
import { isOwner } from '../lib/roles'

function dateLabel(ts: number): string {
  return new Date(ts * 1000).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

export function Incidents() {
  const [items, setItems] = useState<IncidentSummary[] | null>(null)
  const [title, setTitle] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const navigate = useNavigate()
  const { user } = useAuth()
  const canManage = isOwner(user)
  const { showToast } = useToast()

  useEffect(() => {
    let cancelled = false
    listIncidents()
      .then((result) => {
        if (!cancelled) setItems(result.items)
      })
      .catch((reason) => {
        if (!cancelled) setError(reason)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const create = async () => {
    const normalized = title.trim()
    if (!canManage) return
    if (!normalized || busy) return
    setBusy(true)
    try {
      const incident = await createIncident(normalized)
      setItems((current) => [incident, ...(current ?? [])])
      setTitle('')
      navigate(`/events/incidents/${encodeURIComponent(incident.id)}`)
    } catch {
      showToast('Could not create incident', 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-4">
      <header className="flex items-start justify-between gap-3">
        <div>
          <h1 className="page-title text-2xl text-[var(--color-text-primary)]">Incidents</h1>
          <p className="mt-1 text-sm text-[var(--color-text-secondary)]">Keep related evidence, notes, and exports together.</p>
        </div>
        <Link to="/events" className="inline-flex min-h-11 items-center rounded-full px-3 text-sm font-semibold text-[var(--color-accent-deep)]">Back</Link>
      </header>

      {canManage ? (
      <form
        className="card-paper flex flex-col gap-2 p-3 sm:flex-row"
        onSubmit={(event) => {
          event.preventDefault()
          void create()
        }}
      >
        <label className="min-w-0 flex-1">
          <span className="sr-only">New incident title</span>
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Porch package incident"
            maxLength={120}
            className="min-h-11 w-full rounded-full border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-4 text-base"
          />
        </label>
        <Button type="submit" loading={busy} loadingText="Creating…" disabled={!title.trim()}>New incident</Button>
      </form>
      ) : (
        <p role="status" className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3 text-sm text-[var(--color-text-secondary)]">
          Read-only access. An owner can create and organize incidents.
        </p>
      )}

      {error ? (
        <ErrorState title="Could not load incidents" message="Check the connection and try again." technicalDetail={error instanceof Error ? error.message : String(error)} />
      ) : items?.length === 0 ? (
        <CatEmptyState heading="No incidents yet" body="Select events from history and add them to an incident when something needs a closer look." />
      ) : (
        <ol className="grid gap-3 sm:grid-cols-2">
          {(items ?? []).map((item) => (
            <li key={item.id}>
              <Link
                to={`/events/incidents/${encodeURIComponent(item.id)}`}
                className="card-paper flex min-h-28 h-full items-center gap-3 p-3 focus-visible:outline-2 focus-visible:outline-[var(--color-accent-default)] focus-visible:outline-offset-2"
                aria-label={`Open ${item.title}, ${item.event_count} events`}
              >
                {item.thumb_url ? <img src={item.thumb_url} alt="" className="h-20 w-20 rounded-xl object-cover" /> : null}
                <span className="min-w-0 flex-1">
                  <span className="block font-semibold text-[var(--color-text-primary)]">{item.title}</span>
                  <span className="mt-1 block text-xs text-[var(--color-text-secondary)]">{item.event_count} events · updated {dateLabel(item.updated_ts)}</span>
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
