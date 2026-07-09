import { useEffect, useMemo, useState } from 'react'
import { Navigate } from 'react-router-dom'
import { getAdminAudit, type AdminAuditResponse } from '../lib/api'
import { useAuth } from '../lib/auth'
import { formatError } from '../lib/format'
import { isGodModeUser } from '../lib/roles'
import { useStatus } from '../lib/useStatus'
import { CrashCartPanels } from '../components/godview/CrashCartPanels'
import { ErrorState } from '../components/states/ErrorState'
import { LoadingState } from '../components/states/LoadingState'
import { Button } from '../components/primitives/Button'

function dayInputToEpoch(value: string, endOfDay: boolean): number | undefined {
  if (!value) return undefined
  const date = new Date(`${value}T${endOfDay ? '23:59:59' : '00:00:00'}`)
  const ts = Math.floor(date.getTime() / 1000)
  return Number.isFinite(ts) ? ts : undefined
}

function formatDateTime(ts: number): string {
  return new Date(ts * 1000).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

function formatDwell(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return `${minutes}m ${seconds}s`
  return `${seconds}s`
}

function defaultSince(): string {
  const d = new Date()
  d.setDate(d.getDate() - 7)
  return d.toISOString().slice(0, 10)
}

function defaultUntil(): string {
  return new Date().toISOString().slice(0, 10)
}

export function GodView() {
  const { user } = useAuth()
  const [sinceDay, setSinceDay] = useState(defaultSince)
  const [untilDay, setUntilDay] = useState(defaultUntil)
  // Request-lifecycle state (the textbook shape, replacing an earlier
  // boolean-loading + microtask-defer version): the ONLY state is the
  // last settled result, tagged with the request key it answered.
  // `loading` is DERIVED — true whenever the settled result doesn't
  // match the current key — so nothing ever needs a synchronous
  // setState inside the effect, and a stale response can't be mistaken
  // for the current one.
  const [result, setResult] = useState<{
    key: string
    audit: AdminAuditResponse | null
    error: unknown
  } | null>(null)
  const [reloadNonce, setReloadNonce] = useState(0)

  const canView = isGodModeUser(user)
  const status = useStatus()

  const bounds = useMemo(
    () => ({
      since: dayInputToEpoch(sinceDay, false),
      until: dayInputToEpoch(untilDay, true),
    }),
    [sinceDay, untilDay],
  )
  const requestKey = `${bounds.since}:${bounds.until}:${reloadNonce}`

  useEffect(() => {
    if (!canView) return
    let cancelled = false
    getAdminAudit(bounds)
      .then((res) => {
        if (cancelled) return
        setResult({ key: requestKey, audit: res, error: null })
      })
      .catch((e) => {
        if (cancelled) return
        setResult({ key: requestKey, audit: null, error: e })
      })
    return () => {
      cancelled = true
    }
  }, [bounds, requestKey, canView])

  const loading = result?.key !== requestKey
  const audit = loading ? null : result?.audit ?? null
  const error = loading ? null : result?.error ?? null

  if (!canView) return <Navigate to="/" replace />

  const byUser = audit?.summary.by_user ?? {}
  const userEntries = Object.entries(byUser).sort(([a], [b]) =>
    a.localeCompare(b),
  )
  const loginRows = audit?.logins ?? []
  const viewRows = audit?.views ?? []

  return (
    <section
      aria-labelledby="god-view-h1"
      className="p-4 space-y-5 max-w-6xl mx-auto"
    >
      <header className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h1 id="god-view-h1" className="page-title text-2xl text-[var(--color-text-primary)]">
            God View
          </h1>
          <p className="text-sm text-[var(--color-text-secondary)] mt-1">
            Account activity, page dwell, and event review history.
          </p>
        </div>
        <form
          aria-label="Audit date filters"
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault()
            setReloadNonce((n) => n + 1)
          }}
        >
          <label className="grid gap-1 text-sm font-medium text-[var(--color-text-secondary)]">
            Since
            <input
              type="date"
              value={sinceDay}
              onChange={(e) => setSinceDay(e.currentTarget.value)}
              className="min-h-[44px] rounded-full border-[1.5px] border-[var(--color-border)] bg-[var(--color-surface)] px-4 text-[var(--color-text-primary)] focus-visible:outline-2 focus-visible:outline-[var(--color-accent-default)] focus-visible:outline-offset-2"
            />
          </label>
          <label className="grid gap-1 text-sm font-medium text-[var(--color-text-secondary)]">
            Until
            <input
              type="date"
              value={untilDay}
              onChange={(e) => setUntilDay(e.currentTarget.value)}
              className="min-h-[44px] rounded-full border-[1.5px] border-[var(--color-border)] bg-[var(--color-surface)] px-4 text-[var(--color-text-primary)] focus-visible:outline-2 focus-visible:outline-[var(--color-accent-default)] focus-visible:outline-offset-2"
            />
          </label>
          <Button type="submit">Refresh</Button>
        </form>
      </header>

      <CrashCartPanels status={status} />

      {error ? (
        <ErrorState
          title="Could not load audit log"
          message="Check the server and try again."
          retry={() => setReloadNonce((n) => n + 1)}
          technicalDetail={formatError(error)}
        />
      ) : loading || !audit ? (
        <LoadingState shape="list" />
      ) : (
        <>
          <section aria-labelledby="sessions-heading" className="space-y-3">
            <h2 id="sessions-heading" className="text-lg font-semibold text-[var(--color-text-primary)]">
              Sessions Timeline
            </h2>
            <div className="overflow-x-auto rounded-lg border-[1.5px] border-[var(--color-border)] bg-[var(--color-surface)]">
              <table className="min-w-full text-sm">
                <caption className="sr-only">Recent login activity</caption>
                <thead className="text-left text-[var(--color-text-secondary)]">
                  <tr className="border-b border-[var(--color-border-subtle)]">
                    <th scope="col" className="px-4 py-3">Time</th>
                    <th scope="col" className="px-4 py-3">User</th>
                    <th scope="col" className="px-4 py-3">Action</th>
                    <th scope="col" className="px-4 py-3">Device</th>
                  </tr>
                </thead>
                <tbody>
                  {loginRows.map((row, idx) => (
                    <tr key={`${row.ts}-${row.username}-${idx}`} className="border-b border-[var(--color-border-subtle)] last:border-b-0">
                      <td className="px-4 py-3 whitespace-nowrap">{formatDateTime(row.ts)}</td>
                      <td className="px-4 py-3 font-medium">{row.username}</td>
                      <td className="px-4 py-3">{row.action}</td>
                      <td className="px-4 py-3 max-w-md truncate">{row.ua}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section aria-labelledby="users-heading" className="space-y-3">
            <h2 id="users-heading" className="text-lg font-semibold text-[var(--color-text-primary)]">
              Per User
            </h2>
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {userEntries.map(([username, summary]) => (
                <article
                  key={username}
                  aria-labelledby={`god-user-${username}`}
                  className="rounded-lg border-[1.5px] border-[var(--color-border)] bg-[var(--color-surface)] p-4 shadow-[var(--shadow-subtle)]"
                >
                  <h3 id={`god-user-${username}`} className="text-base font-semibold text-[var(--color-text-primary)]">
                    {username}
                  </h3>
                  <dl className="mt-3 grid grid-cols-3 gap-3 text-sm">
                    <div>
                      <dt className="text-[var(--color-text-secondary)]">Logins</dt>
                      <dd className="font-semibold text-[var(--color-text-primary)]">{summary.logins}</dd>
                    </div>
                    <div>
                      <dt className="text-[var(--color-text-secondary)]">Page dwell</dt>
                      <dd className="font-semibold text-[var(--color-text-primary)]">{formatDwell(summary.page_dwell_ms)}</dd>
                    </div>
                    <div>
                      <dt className="text-[var(--color-text-secondary)]">Events</dt>
                      <dd className="font-semibold text-[var(--color-text-primary)]">{summary.event_views}</dd>
                    </div>
                  </dl>
                  <div className="mt-4">
                    <h4 className="text-sm font-medium text-[var(--color-text-secondary)]">Top dwells</h4>
                    <ol className="mt-2 space-y-1 text-sm text-[var(--color-text-primary)]">
                      {summary.top.slice(0, 10).map(([name, dwell]) => (
                        <li key={name} className="flex justify-between gap-3">
                          <span className="truncate">{name}</span>
                          <span className="font-medium whitespace-nowrap">{formatDwell(dwell)}</span>
                        </li>
                      ))}
                    </ol>
                  </div>
                </article>
              ))}
            </div>
          </section>

          <section aria-labelledby="views-heading" className="space-y-3">
            <h2 id="views-heading" className="text-lg font-semibold text-[var(--color-text-primary)]">
              Views
            </h2>
            <div className="overflow-x-auto rounded-lg border-[1.5px] border-[var(--color-border)] bg-[var(--color-surface)]">
              <table className="min-w-full text-sm">
                <caption className="sr-only">Page and event view telemetry</caption>
                <thead className="text-left text-[var(--color-text-secondary)]">
                  <tr className="border-b border-[var(--color-border-subtle)]">
                    <th scope="col" className="px-4 py-3">Time</th>
                    <th scope="col" className="px-4 py-3">User</th>
                    <th scope="col" className="px-4 py-3">Kind</th>
                    <th scope="col" className="px-4 py-3">Name</th>
                    <th scope="col" className="px-4 py-3">Dwell</th>
                  </tr>
                </thead>
                <tbody>
                  {viewRows.map((row, idx) => (
                    <tr key={`${row.ts}-${row.username}-${row.name}-${idx}`} className="border-b border-[var(--color-border-subtle)] last:border-b-0">
                      <td className="px-4 py-3 whitespace-nowrap">{formatDateTime(row.ts)}</td>
                      <td className="px-4 py-3 font-medium">{row.username}</td>
                      <td className="px-4 py-3">{row.kind}</td>
                      <td className="px-4 py-3 max-w-md truncate">{row.name}</td>
                      <td className="px-4 py-3 whitespace-nowrap">{formatDwell(row.dwell_ms)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </section>
  )
}
