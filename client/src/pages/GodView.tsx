import { useEffect, useMemo, useRef, useState } from 'react'
import { Navigate } from 'react-router-dom'
import {
  getAdminAudit,
  fetchLogs,
  getLogsResult,
  getRecoverStatus,
  recoverHost,
  type AdminAuditResponse,
  type LogResult,
  type LogUnit,
  type RecoverAction,
  type RecoverStatus,
} from '../lib/api'
import { useConfirm } from '../lib/confirm'
import { useAuth } from '../lib/auth'
import { isGodModeUser } from '../lib/roles'
import { formatError } from '../lib/format'
import { useStatus } from '../lib/useStatus'
import { CrashCartPanels } from '../components/godview/CrashCartPanels'
import { SessionsPanel } from '../components/godview/SessionsPanel'
import { WedgePanel } from '../components/godview/WedgePanel'
import { CatEmptyState } from '../components/CatEmptyState'
import { ErrorState } from '../components/states/ErrorState'
import { LoadingState } from '../components/states/LoadingState'
import { Button } from '../components/primitives/Button'
import { OutageTimelinePanel } from '../components/godview/OutageTimelinePanel'
import { UsageSessionsPanel } from '../components/godview/UsageSessionsPanel'

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

const RECOVERY_ACTIONS: {
  action: RecoverAction
  label: string
  title: string
  body: string
  destructive?: boolean
}[] = [
  {
    action: 'mediamtx',
    label: 'Restart camera feed',
    title: 'Restart camera feed?',
    body: 'The live feed may drop for a few seconds while MediaMTX restarts.',
  },
  {
    action: 'nvargus',
    label: 'Reset camera daemon',
    title: 'Reset camera daemon?',
    body: 'This restarts nvargus and the camera feed. Use it when the feed stays stuck after a feed restart.',
  },
  {
    action: 'reboot',
    label: 'Reboot Jetson',
    title: 'Reboot Jetson?',
    body: 'The camera and app will go offline while the Jetson reboots. Use this only as the last recovery step.',
    destructive: true,
  },
]

function recoveryCopy(status: RecoverStatus | null): string {
  if (!status) return 'Ready'
  if (status.status === 'none') return 'No recovery request'
  if (status.status === 'pending') {
    return status.worker_online ? 'Queued' : 'Worker offline, queued'
  }
  if (status.status === 'running') {
    if (status.action === 'nvargus') return 'Restarting nvargus'
    if (status.action === 'mediamtx') return 'Restarting camera feed'
    return 'Rebooting Jetson'
  }
  if (status.status === 'done') return 'Done'
  if (status.status === 'expired') return 'Timed out. Worker never picked it up.'
  return status.detail ? `Failed: ${status.detail}` : 'Failed'
}

function RecoveryPanel() {
  const confirm = useConfirm()
  const [requestId, setRequestId] = useState<string | null>(null)
  const [status, setStatus] = useState<RecoverStatus | null>(null)
  const [busyAction, setBusyAction] = useState<RecoverAction | null>(null)
  const [error, setError] = useState<string | null>(null)

  const terminal =
    status?.status === 'done' ||
    status?.status === 'failed' ||
    status?.status === 'expired'

  useEffect(() => {
    if (!requestId || terminal) return
    let cancelled = false
    const poll = () => {
      getRecoverStatus(requestId)
        .then((next) => {
          if (cancelled) return
          setStatus(next)
        })
        .catch((e) => {
          if (cancelled) return
          setError(formatError(e))
        })
    }
    poll()
    const id = window.setInterval(poll, 2000)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [requestId, terminal])

  const startRecovery = (entry: (typeof RECOVERY_ACTIONS)[number]) => {
    confirm({
      title: entry.title,
      body: entry.body,
      confirmLabel: entry.destructive ? 'Reboot Jetson' : 'Start recovery',
      destructive: entry.destructive,
    }).then((ok) => {
      if (!ok) return
      setBusyAction(entry.action)
      setError(null)
      recoverHost(entry.action)
        .then((res) => {
          setRequestId(res.request_id)
          setStatus({
            request_id: res.request_id,
            action: entry.action,
            status: res.status,
            detail: null,
            requested_by: '',
            requested_at: Date.now() / 1000,
            result_at: null,
            worker_online: res.worker_online,
          })
        })
        .catch((e) => setError(formatError(e)))
        .finally(() => setBusyAction(null))
    })
  }

  const isFailure = status?.status === 'failed'

  return (
    <section
      aria-labelledby="recovery-heading"
      className="rounded-lg border-[1.5px] border-[var(--color-border)] bg-[var(--color-surface)] p-4 shadow-[var(--shadow-subtle)]"
    >
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div>
          <h2 id="recovery-heading" className="text-lg font-semibold text-[var(--color-text-primary)]">
            Recovery
          </h2>
          <p className="mt-1 text-sm text-[var(--color-text-secondary)]">
            Manual ladder for host-side camera recovery.
          </p>
        </div>
        <div
          role="status"
          aria-label="Recovery status"
          className={`inline-flex min-h-9 items-center rounded-full border-[1.5px] px-3 text-sm font-semibold ${
            isFailure
              ? 'border-[var(--color-danger)] bg-[var(--color-danger-muted)] text-[var(--color-danger)]'
              : 'border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-text-primary)]'
          }`}
        >
          {recoveryCopy(status)}
        </div>
      </div>
      <div className="mt-4 grid gap-2 sm:grid-cols-3">
        {RECOVERY_ACTIONS.map((entry) => (
          <Button
            key={entry.action}
            type="button"
            variant={entry.destructive ? 'destructive' : 'secondary'}
            onClick={() => startRecovery(entry)}
            disabled={busyAction !== null}
          >
            {busyAction === entry.action ? 'Queuing' : entry.label}
          </Button>
        ))}
      </div>
      {error && (
        <p className="mt-3 text-sm font-medium text-[var(--color-danger)]">
          {error}
        </p>
      )}
    </section>
  )
}

const LOG_UNITS: { unit: LogUnit; label: string }[] = [
  { unit: 'homecam-detect', label: 'Detection worker' },
  { unit: 'mediamtx', label: 'Camera server (MediaMTX)' },
  { unit: 'nvargus-daemon', label: 'Camera daemon (nvargus)' },
  { unit: 'homecam-server', label: 'API server' },
]

function LogViewerPanel() {
  const [unit, setUnit] = useState<LogUnit>('homecam-detect')
  const [lineCount, setLineCount] = useState(200)
  const [requestId, setRequestId] = useState<string | null>(null)
  const [result, setResult] = useState<LogResult | null>(null)
  const [fetching, setFetching] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const logRef = useRef<HTMLPreElement | null>(null)

  const terminal =
    result?.status === 'done' ||
    result?.status === 'failed' ||
    result?.status === 'expired'

  useEffect(() => {
    if (!requestId || terminal) return
    let cancelled = false
    const poll = () => {
      getLogsResult(requestId)
        .then((next) => {
          if (cancelled) return
          setResult(next)
        })
        .catch((e) => {
          if (cancelled) return
          setError(formatError(e))
        })
    }
    poll()
    const id = window.setInterval(poll, 1500)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [requestId, terminal])

  useEffect(() => {
    const el = logRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [result?.lines])

  const refresh = () => {
    setFetching(true)
    setError(null)
    setResult(null)
    fetchLogs(unit, { lines: lineCount })
      .then((res) => {
        setRequestId(res.request_id)
        setResult({
          request_id: res.request_id,
          unit,
          status: res.status,
          lines: null,
          detail: null,
        })
      })
      .catch((e) => setError(formatError(e)))
      .finally(() => setFetching(false))
  }

  const lines = result?.lines ?? []
  const statusText = result
    ? result.status === 'done'
      ? `${lines.length} lines`
      : result.status
    : 'Not loaded'

  return (
    <section
      aria-labelledby="logs-heading"
      className="rounded-lg border-[1.5px] border-[var(--color-border)] bg-[var(--color-surface)] p-4 shadow-[var(--shadow-subtle)]"
    >
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h2 id="logs-heading" className="text-lg font-semibold text-[var(--color-text-primary)]">
            Logs
          </h2>
          <p className="mt-1 text-sm text-[var(--color-text-secondary)]">
            Read-only host journal tail.
          </p>
        </div>
        <form
          aria-label="Log controls"
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault()
            refresh()
          }}
        >
          <label className="grid gap-1 text-sm font-medium text-[var(--color-text-secondary)]">
            Unit
            <select
              value={unit}
              onChange={(e) => setUnit(e.currentTarget.value as LogUnit)}
              className="min-h-[44px] rounded-full border-[1.5px] border-[var(--color-border)] bg-[var(--color-bg)] px-4 text-[var(--color-text-primary)] focus-visible:outline-2 focus-visible:outline-[var(--color-accent-default)] focus-visible:outline-offset-2"
            >
              {LOG_UNITS.map((entry) => (
                <option key={entry.unit} value={entry.unit}>
                  {entry.label}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-1 text-sm font-medium text-[var(--color-text-secondary)]">
            Lines
            <input
              type="number"
              min={1}
              max={1000}
              value={lineCount}
              onChange={(e) => setLineCount(Number(e.currentTarget.value))}
              className="min-h-[44px] w-28 rounded-full border-[1.5px] border-[var(--color-border)] bg-[var(--color-bg)] px-4 text-[var(--color-text-primary)] focus-visible:outline-2 focus-visible:outline-[var(--color-accent-default)] focus-visible:outline-offset-2"
            />
          </label>
          <Button type="submit" disabled={fetching || (!!result && !terminal)}>
            {fetching || (!!result && !terminal) ? 'Loading' : 'Refresh'}
          </Button>
        </form>
      </div>
      <div className="mt-3 flex items-center justify-between gap-3 text-sm text-[var(--color-text-secondary)]">
        <span>{statusText}</span>
        {result?.detail && <span className="text-[var(--color-danger)]">{result.detail}</span>}
      </div>
      {error && (
        <p className="mt-3 text-sm font-medium text-[var(--color-danger)]">
          {error}
        </p>
      )}
      <div className="mt-4 rounded-lg border-[1.5px] border-[var(--color-border)] bg-[var(--color-bg)]">
        {lines.length === 0 ? (
          <CatEmptyState
            heading="No logs loaded"
            body="Fetch a unit to read recent host journal lines."
          />
        ) : (
          <pre
            ref={logRef}
            aria-label="System logs"
            className="max-h-96 overflow-auto whitespace-pre-wrap break-words p-4 font-mono text-xs leading-5 text-[var(--color-text-primary)]"
          >
            {lines.join('\n')}
          </pre>
        )}
      </div>
    </section>
  )
}

export function GodView() {
  const { user } = useAuth()
  const canView = isGodModeUser(user)
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

      {error ? (
        <ErrorState
          title="Could not load app activity"
          message="Check the server and try again."
          retry={() => setReloadNonce((n) => n + 1)}
          technicalDetail={formatError(error)}
        />
      ) : loading || !audit ? (
        <LoadingState shape="list" />
      ) : (
        <UsageSessionsPanel sessions={audit.sessions} />
      )}

      <CrashCartPanels status={status} />
      <WedgePanel metrics={status?.worker_metrics ?? null} />
      <OutageTimelinePanel />
      <RecoveryPanel />
      <LogViewerPanel />
      <SessionsPanel user={user} />

      {!error && !loading && audit ? (
        <details className="rounded-lg border-[1.5px] border-[var(--color-border)] bg-[var(--color-surface)] p-4">
          <summary className="min-h-11 cursor-pointer py-2 text-base font-semibold text-[var(--color-text-primary)]">
            Raw audit tables
          </summary>
          <div className="mt-4 space-y-5">
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
                  <dl className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
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
                    <div>
                      <dt className="text-[var(--color-text-secondary)]">Actions</dt>
                      <dd className="font-semibold text-[var(--color-text-primary)]">{summary.actions}</dd>
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
          </div>
        </details>
      ) : null}
    </section>
  )
}
