import { CatEmptyState } from '../CatEmptyState'
import { formatSecondsAgo } from '../../lib/format'
import type { WorkerMetrics } from '../../lib/types'
import { useTicker } from '../../lib/useTicker'
import {
  REBOOT_GUARD_SECONDS,
  actionLabel,
  rungDisplay,
  rungTone,
} from '../../lib/wedgeLadder'

const toneClass = {
  ok: 'text-[var(--color-text-primary)]',
  warn: 'text-[var(--color-warning)]',
  down: 'text-[var(--color-danger)]',
}

function ageFromEpoch(ts: number | null | undefined, nowSec: number): string {
  if (ts == null || ts <= 0) return 'never'
  return formatSecondsAgo(Math.max(0, nowSec - ts))
}

function formatMbFromKb(kb: number | null | undefined): string {
  if (kb == null || kb <= 0) return '—'
  return `${(kb / 1024).toFixed(1)} MB`
}

function formatNumber(n: number | null | undefined, unit = ''): string {
  if (n == null || n <= 0) return '—'
  return `${Math.round(n)}${unit}`
}

function rebootGuard(metrics: WorkerMetrics, nowSec: number): string {
  const last = metrics.watchdog_last_reboot_at ?? 0
  if (last <= 0) return 'Reboot available - never rebooted'
  const age = Math.max(0, nowSec - last)
  if (age < REBOOT_GUARD_SECONDS) {
    const mins = Math.ceil((REBOOT_GUARD_SECONDS - age) / 60)
    return `Reboot suppressed - boot-loop guard active, cools down in ${mins}m`
  }
  return `Reboot available - last reboot ${formatSecondsAgo(age)}`
}

export function WedgePanel({
  metrics,
  now,
}: {
  metrics: WorkerMetrics | null
  now?: number
}) {
  const tickNow = useTicker()
  const nowSec = (now ?? tickNow) / 1000
  if (metrics === null) {
    return (
      <section
        aria-labelledby="wedge-h2"
        className="rounded-lg border-[1.5px] border-[var(--color-border)] bg-[var(--color-surface)] p-4 shadow-[var(--shadow-subtle)]"
      >
        <h2 id="wedge-h2" className="text-lg font-semibold text-[var(--color-text-primary)]">
          Capture Wedge
        </h2>
        <CatEmptyState
          mood="watching"
          heading="Worker is silent - no wedge telemetry"
          body="Watchdog escalation details will appear after the worker heartbeats."
          ariaLabel="Worker is silent - no wedge telemetry"
        />
      </section>
    )
  }

  const level = metrics.watchdog_level ?? 0
  const tone = rungTone(level)
  const action = metrics.watchdog_last_action ?? ''
  const actionCount = metrics.watchdog_action_count ?? 0
  const hasDiag = (metrics.wedge_diag_at ?? 0) > 0

  return (
    <section
      aria-labelledby="wedge-h2"
      className="rounded-lg border-[1.5px] border-[var(--color-border)] bg-[var(--color-surface)] p-4 shadow-[var(--shadow-subtle)]"
    >
      <div>
        <h2 id="wedge-h2" className="text-lg font-semibold text-[var(--color-text-primary)]">
          Capture Wedge
        </h2>
        <p className="mt-1 text-sm text-[var(--color-text-secondary)]">
          Watchdog escalation state and the latest capture-wedge diagnostics.
        </p>
      </div>

      <dl className="mt-4 grid gap-3 md:grid-cols-3">
        <div className="rounded-lg border-[1.5px] border-[var(--color-border)] bg-[var(--color-surface)] p-3">
          <dt className="text-xs font-medium uppercase tracking-normal text-[var(--color-text-secondary)]">
            Escalation
          </dt>
          <dd className={`mt-1 text-lg font-semibold ${toneClass[tone]}`}>
            {rungDisplay(level)}
          </dd>
        </div>
        <div className="rounded-lg border-[1.5px] border-[var(--color-border)] bg-[var(--color-surface)] p-3">
          <dt className="text-xs font-medium uppercase tracking-normal text-[var(--color-text-secondary)]">
            Last action
          </dt>
          <dd className="mt-1 text-lg font-semibold text-[var(--color-text-primary)]">
            {actionLabel(action)} - {ageFromEpoch(metrics.watchdog_last_action_at, nowSec)}
          </dd>
          <dd className="mt-1 text-sm text-[var(--color-text-secondary)]">
            {actionCount} escalations this session
          </dd>
        </div>
        <div className="rounded-lg border-[1.5px] border-[var(--color-border)] bg-[var(--color-surface)] p-3">
          <dt className="text-xs font-medium uppercase tracking-normal text-[var(--color-text-secondary)]">
            Reboot guard
          </dt>
          <dd className="mt-1 text-lg font-semibold text-[var(--color-text-primary)]">
            {rebootGuard(metrics, nowSec)}
          </dd>
        </div>
      </dl>

      <div className="mt-4 rounded-lg border-[1.5px] border-[var(--color-border)] bg-[var(--color-surface)] p-4">
        <h3 className="text-base font-semibold text-[var(--color-text-primary)]">
          Latest diagnostics
        </h3>
        {hasDiag ? (
          <>
            <p className="mt-1 text-sm text-[var(--color-text-secondary)]">
              Snapshot from the last watchdog escalation - correlate wedge time with nvargus RSS, temp, and pending events.
            </p>
            <dl className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
              <div>
                <dt className="text-xs font-medium uppercase tracking-normal text-[var(--color-text-secondary)]">
                  Captured
                </dt>
                <dd className="font-semibold text-[var(--color-text-primary)]">
                  {ageFromEpoch(metrics.wedge_diag_at, nowSec)}
                </dd>
              </div>
              <div>
                <dt className="text-xs font-medium uppercase tracking-normal text-[var(--color-text-secondary)]">
                  nvargus RSS
                </dt>
                <dd className="font-semibold text-[var(--color-text-primary)]">
                  {formatMbFromKb(metrics.wedge_diag_nvargus_rss_kb)}
                </dd>
              </div>
              <div>
                <dt className="text-xs font-medium uppercase tracking-normal text-[var(--color-text-secondary)]">
                  GPU temp
                </dt>
                <dd className="font-semibold text-[var(--color-text-primary)]">
                  {formatNumber(metrics.wedge_diag_gpu_temp_c, ' °C')}
                </dd>
              </div>
              <div>
                <dt className="text-xs font-medium uppercase tracking-normal text-[var(--color-text-secondary)]">
                  MemAvailable
                </dt>
                <dd className="font-semibold text-[var(--color-text-primary)]">
                  {formatNumber(metrics.wedge_diag_mem_avail_mb, ' MB')}
                </dd>
              </div>
              <div>
                <dt className="text-xs font-medium uppercase tracking-normal text-[var(--color-text-secondary)]">
                  Argus pending
                </dt>
                <dd className="font-semibold text-[var(--color-text-primary)]">
                  {metrics.wedge_diag_argus_pending ?? 0}
                </dd>
              </div>
            </dl>
          </>
        ) : (
          <CatEmptyState
            mood="calm"
            heading="No camera wedges this session"
            body="The watchdog has not captured escalation diagnostics."
            ariaLabel="No camera wedges this session"
          />
        )}
      </div>
    </section>
  )
}
