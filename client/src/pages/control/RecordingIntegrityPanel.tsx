import { Link } from 'react-router-dom'
import { Button } from '../../components/primitives/Button'
import { formatBytes } from '../../lib/format'
import type { RecordingIntegrity } from '../../lib/api'
import { Row, Section } from '../settings/parts'
import { useState } from 'react'

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
  const [windowKey, setWindowKey] = useState<'24h' | '7d' | 'release' | 'all'>('24h')
  // Keep the control center usable during a rolling deploy where the new
  // client can briefly talk to the previous v1 server response.
  const selected = integrity?.windows?.[windowKey] ?? integrity
  const alerts = integrity?.alerts ?? []
  return (
    <Section title="Recording integrity" subtitle="Persisted lifecycle jobs and validated playback—not filename guesses.">
      {integrity ? (
        <>
          <div className="flex flex-wrap gap-2 p-3" role="group" aria-label="Recording statistics window">
            {([['24h', '24 hours'], ['7d', '7 days'], ['release', 'This release'], ['all', 'All time']] as const).map(([key, label]) => (
              <button key={key} type="button" aria-pressed={windowKey === key} onClick={() => setWindowKey(key)} className={`min-h-11 rounded-full px-3 text-sm font-semibold ${windowKey === key ? 'bg-[var(--color-ink)] text-[var(--color-on-ink)]' : 'bg-[var(--color-surface-raised)] text-[var(--color-text-secondary)]'}`}>{label}</button>
            ))}
          </div>
          {alerts.length ? <div className="space-y-2 px-3 pb-3">{alerts.map((alert) => <div key={alert.id} role="alert" className={`rounded-xl border p-3 ${alert.severity === 'critical' ? 'border-[var(--color-danger)] bg-[var(--color-danger-bg)]' : 'border-[var(--color-warning)] bg-[var(--color-warning-bg)]'}`}><p className="font-semibold">{alert.title}</p><p className="mt-1 text-xs">{alert.detail}</p></div>)}</div> : <p className="px-4 pb-3 text-sm text-[var(--color-success)]">No critical recording or storage alerts.</p>}
          <Row label="Videos in this window" right={<span>{selected?.total ?? 0}</span>} />
          <Row label="Playable videos" right={<span>{selected?.counts.available ?? 0}</span>} />
          <Row label="Recording or finalizing" right={<span>{selected?.processing ?? 0}</span>} />
          <Row label="Stuck over five minutes" right={<span className={selected?.stuck_jobs ? 'text-[var(--color-danger)]' : ''}>{selected?.stuck_jobs ?? 0}</span>} />
          <Row label="Median time to playback" right={<span>{selected?.median_ready_s == null ? 'Collecting' : `${selected.median_ready_s.toFixed(1)}s`}</span>} />
          <Row label="95th-percentile time" right={<span>{selected?.p95_ready_s == null ? 'Collecting' : `${selected.p95_ready_s.toFixed(1)}s`}</span>} />
          <Row label="Timing sample size" right={<span>{selected?.latency_samples ?? 0}</span>} />
          <div className="space-y-2 p-3">
            {selected?.objectives?.map((objective) => (
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
              <p className="mt-1 text-xs text-[var(--color-text-secondary)]">SMART: {integrity.storage.smart_status === 'unavailable' ? 'not exposed by this USB adapter; write and fsync checks remain active' : integrity.storage.smart_status ?? 'not reported'}</p>
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
