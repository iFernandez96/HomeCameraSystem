import { Link } from 'react-router-dom'
import { Button } from '../../components/primitives/Button'
import { formatBytes } from '../../lib/format'
import type { RecordingIntegrity } from '../../lib/api'
import { Row, Section } from '../settings/parts'

export function RecordingIntegrityPanel({
  integrity,
  running,
  disabled,
  onRun,
}: {
  integrity: RecordingIntegrity | null
  running: boolean
  disabled: boolean
  onRun: () => void
}) {
  return (
    <Section title="Recording integrity" subtitle="Persisted lifecycle jobs and validated playback—not filename guesses.">
      {integrity ? (
        <>
          <Row label="Playable videos" right={<span>{integrity.counts.available}</span>} />
          <Row label="Recording or finalizing" right={<span>{integrity.processing}</span>} />
          <Row label="Stuck over five minutes" right={<span className={integrity.stuck_jobs ? 'text-[var(--color-danger)]' : ''}>{integrity.stuck_jobs}</span>} />
          <Row label="Median time to playback" right={<span>{integrity.median_ready_s == null ? 'Collecting' : `${integrity.median_ready_s.toFixed(1)}s`}</span>} />
          <Row label="95th-percentile time" right={<span>{integrity.p95_ready_s == null ? 'Collecting' : `${integrity.p95_ready_s.toFixed(1)}s`}</span>} />
          <div className="space-y-2 p-3">
            {integrity.objectives.map((objective) => (
              <p key={objective.id} className="flex items-start gap-2 text-sm">
                <span aria-hidden="true" className={objective.met == null ? 'text-[var(--color-text-tertiary)]' : objective.met ? 'text-[var(--color-success)]' : 'text-[var(--color-danger)]'}>{objective.met == null ? '…' : objective.met ? '✓' : '!'}</span>
                <span>{objective.label}{objective.met == null ? ' · collecting baseline' : ''}</span>
              </p>
            ))}
            <div className={`rounded-xl border p-3 ${integrity.storage.state === 'healthy' ? 'border-[var(--color-border)]' : 'border-[var(--color-danger)] bg-[var(--color-danger-bg)]'}`}>
              <p className="font-semibold">USB recording storage · {integrity.storage.state}</p>
              <p className="mt-1 text-xs text-[var(--color-text-secondary)]">
                {integrity.storage.device ?? 'Device unconfirmed'} at {integrity.storage.mountpoint ?? 'unknown mount'} · {integrity.storage.filesystem ?? 'filesystem unconfirmed'} · {formatBytes(integrity.storage.free_bytes ?? 0)} free
                {integrity.storage.write_probe_ms == null ? '' : ` · ${integrity.storage.write_probe_ms.toFixed(1)}ms fsync probe`}
              </p>
              {integrity.storage.reasons.map((reason) => <p key={reason} className="mt-1 text-xs text-[var(--color-danger)]">{reason}</p>)}
            </div>
            {integrity.recent_failures.slice(0, 5).map((failure) => (
              <Link key={failure.event_id} to={`/events/detections?event=${encodeURIComponent(failure.event_id)}`} className="block rounded-xl border border-[var(--color-border)] p-3 text-sm">
                <span className="block font-semibold">{failure.failure_summary ?? 'No playable video was saved'}</span>
                <span className="block text-xs text-[var(--color-text-secondary)]">Open event · {failure.failure_code ?? 'unknown failure'}</span>
              </Link>
            ))}
            <Button loading={running} loadingText="Testing camera…" disabled={disabled} onClick={onRun}>
              Run end-to-end camera test
            </Button>
            <p className="text-xs text-[var(--color-text-secondary)]">Captures the existing RTSP publication, writes and fsyncs a temporary MP4, fully decodes it, verifies the newest real event clip, then removes every test-owned artifact.</p>
          </div>
        </>
      ) : <p role="status" className="p-4 text-sm">Checking recording integrity…</p>}
    </Section>
  )
}
