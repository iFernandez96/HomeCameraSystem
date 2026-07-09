import { CatEmptyState } from '../CatEmptyState'
import { formatSecondsAgo, formatUptime } from '../../lib/format'
import type { ServerStatus } from '../../lib/types'
import { StatCard } from './StatCard'

function restartTone(n: number | undefined): 'neutral' | 'warn' {
  return n && n > 0 ? 'warn' : 'neutral'
}

export function WorkerLivenessPanel({ status }: { status: ServerStatus }) {
  const metrics = status.worker_metrics
  return (
    <section
      aria-labelledby="worker-liveness-h2"
      className="rounded-lg border-[1.5px] border-[var(--color-border)] bg-[var(--color-surface)] p-4 shadow-[var(--shadow-subtle)]"
    >
      <h2 id="worker-liveness-h2" className="text-lg font-semibold text-[var(--color-text-primary)]">
        Worker Liveness
      </h2>
      {metrics === null ? (
        <CatEmptyState
          mood="watching"
          heading="Worker is silent"
          body="No worker metrics are available yet."
          ariaLabel="Worker is silent"
        />
      ) : (
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <StatCard label="Last seen" value={formatSecondsAgo(status.worker_last_seen_s)} />
          <StatCard label="FPS" value={status.fps.toFixed(1)} />
          <StatCard
            label="Infer latency"
            value={
              metrics.infer_ms_recent == null
                ? null
                : `${Math.round(metrics.infer_ms_recent)} ms${
                    metrics.infer_ms_p95 == null ? '' : ` · p95 ${Math.round(metrics.infer_ms_p95)} ms`
                  }`
            }
          />
          <StatCard label="Gear" value={metrics.gear ?? null} />
          <StatCard
            label="MediaMTX recoveries"
            value={metrics.mediamtx_restarts ?? 0}
            tone={restartTone(metrics.mediamtx_restarts)}
          />
          <StatCard
            label="Argus recoveries"
            value={metrics.argus_restarts ?? 0}
            tone={restartTone(metrics.argus_restarts)}
          />
          <StatCard
            label="Worker uptime"
            value={metrics.uptime_s == null ? null : formatUptime(metrics.uptime_s)}
          />
        </div>
      )}
    </section>
  )
}
