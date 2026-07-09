import { ASSUMED_GB_PER_DAY, estimateDaysLeft } from '../../lib/recordingRunway'
import type { ServerStatus } from '../../lib/types'

function runwayTone(days: number | null): string {
  if (days == null) return 'text-[var(--color-text-primary)]'
  if (days < 3) return 'text-[var(--color-danger)]'
  if (days < 7) return 'text-[var(--color-warning)]'
  return 'text-[var(--color-text-primary)]'
}

export function RecordingRunwayPanel({ status }: { status: ServerStatus }) {
  const runway = estimateDaysLeft(status.disk_free_gb)
  const days = runway.daysLeft
  const daysLabel = days == null ? '—' : `≈ ${Math.floor(days)} days left`
  const freeLabel = status.disk_free_gb == null ? 'unknown' : `${status.disk_free_gb.toFixed(1)} GB`

  return (
    <section
      aria-labelledby="recording-runway-h2"
      className="rounded-lg border-[1.5px] border-[var(--color-border)] bg-[var(--color-surface)] p-4 shadow-[var(--shadow-subtle)]"
    >
      <h2 id="recording-runway-h2" className="text-lg font-semibold text-[var(--color-text-primary)]">
        Recording Runway
      </h2>
      <dl className="mt-4">
        <div>
          <dt className="text-xs font-medium uppercase tracking-normal text-[var(--color-text-secondary)]">
            Estimated storage
          </dt>
          <dd className={`mt-1 text-3xl font-semibold ${runwayTone(days)}`}>
            {daysLabel}
          </dd>
        </div>
      </dl>
      <p className="mt-3 text-sm text-[var(--color-text-secondary)]">
        Estimate at ~{ASSUMED_GB_PER_DAY} GB/day. Free: {freeLabel}.
      </p>
    </section>
  )
}
