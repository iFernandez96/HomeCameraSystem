import { useEffect, useState } from 'react'
import { listOutages, type OutageRecord } from '../../lib/api'
import { CatEmptyState } from '../CatEmptyState'
import { ErrorState } from '../states/ErrorState'

function time(ts: number): string {
  return new Date(ts * 1000).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

function duration(item: OutageRecord): string {
  if (item.end_ts == null) return 'Ongoing'
  const seconds = Math.max(0, item.end_ts - item.start_ts)
  if (seconds < 60) return `${Math.round(seconds)} seconds`
  if (seconds < 3600) return `${Math.round(seconds / 60)} minutes`
  return `${(seconds / 3600).toFixed(1)} hours`
}

export function OutageTimelinePanel() {
  const [result, setResult] = useState<{
    items: OutageRecord[] | null
    error: unknown
  }>({ items: null, error: null })

  useEffect(() => {
    let cancelled = false
    listOutages()
      .then((value) => {
        if (!cancelled) setResult({ items: value.items, error: null })
      })
      .catch((error) => {
        if (!cancelled) setResult({ items: null, error })
      })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <section
      aria-labelledby="outage-timeline-h2"
      className="rounded-lg border-[1.5px] border-[var(--color-border)] bg-[var(--color-surface)] p-4 shadow-[var(--shadow-subtle)]"
    >
      <h2 id="outage-timeline-h2" className="text-lg font-semibold text-[var(--color-text-primary)]">
        Outage history
      </h2>
      <p className="mt-1 text-sm text-[var(--color-text-secondary)]">
        Inferred from recovery records and heartbeat gaps. A powered-off Jetson cannot report live; real-time power or network-down alerts require an external observer or UPS integration.
      </p>
      {result.error ? (
        <div className="mt-3">
          <ErrorState
            title="Could not load outage history"
            message="Live health above is still available."
            technicalDetail={result.error instanceof Error ? result.error.message : String(result.error)}
          />
        </div>
      ) : result.items?.length === 0 ? (
        <CatEmptyState
          mood="watching"
          heading="No outages recorded"
          body="No recovery record or heartbeat gap has been inferred as an interruption."
        />
      ) : (
        <ol className="mt-4 space-y-2">
          {(result.items ?? []).map((item) => (
            <li
              key={item.id}
              className={`rounded-xl border p-3 ${
                item.recovered
                  ? 'border-[var(--color-border)] bg-[var(--color-surface-raised)]'
                  : 'border-[var(--color-danger-border)] bg-[var(--color-danger-bg)]'
              }`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-semibold capitalize text-[var(--color-text-primary)]">
                    {item.kind.replaceAll('_', ' ')}
                  </p>
                  <p className="text-xs text-[var(--color-text-secondary)]">{item.reason}</p>
                </div>
                <span className="shrink-0 text-xs font-medium text-[var(--color-text-secondary)]">
                  {duration(item)}
                </span>
              </div>
              <p className="mt-2 text-xs tabular-nums text-[var(--color-text-tertiary)]">
                {time(item.start_ts)}{item.end_ts ? ` to ${time(item.end_ts)}` : ''}
              </p>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}
