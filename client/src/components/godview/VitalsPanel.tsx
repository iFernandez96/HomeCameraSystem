import { cpuFreqTone, gpuTempTone } from '../../lib/pipelineHealth'
import type { ServerStatus } from '../../lib/types'
import { formatTemp } from '../../lib/format'
import { StatCard } from './StatCard'

function formatMemory(status: ServerStatus): string | null {
  if (status.memory_used_mb == null || status.memory_total_mb == null) return null
  return `${Math.round(status.memory_used_mb)} / ${Math.round(status.memory_total_mb)} MB`
}

function memoryPct(status: ServerStatus): number | null {
  if (status.memory_used_mb == null || !status.memory_total_mb) return null
  return Math.min(100, Math.max(0, (status.memory_used_mb / status.memory_total_mb) * 100))
}

export function VitalsPanel({ status }: { status: ServerStatus }) {
  const memPct = memoryPct(status)
  return (
    <section
      aria-labelledby="jetson-vitals-h2"
      className="rounded-lg border-[1.5px] border-[var(--color-border)] bg-[var(--color-surface)] p-4 shadow-[var(--shadow-subtle)]"
    >
      <h2 id="jetson-vitals-h2" className="text-lg font-semibold text-[var(--color-text-primary)]">
        Jetson Vitals
      </h2>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <StatCard label="CPU temp" value={formatTemp(status.cpu_temp_c)} />
        <StatCard label="GPU temp" value={formatTemp(status.gpu_temp_c)} tone={gpuTempTone(status.gpu_temp_c)} />
        <StatCard label="Memory" value={formatMemory(status)}>
          {memPct == null ? null : (
            <div className="mt-2 h-2 overflow-hidden rounded-full bg-[var(--color-surface-raised)]" aria-label={`Memory ${Math.round(memPct)} percent used`}>
              <div className="h-full rounded-full bg-[var(--color-accent-default)]" style={{ width: `${memPct}%` }} />
            </div>
          )}
        </StatCard>
        <StatCard
          label="CPU freq headroom"
          value={status.cpu_freq_pct == null ? null : Math.round(status.cpu_freq_pct)}
          unit="%"
          tone={cpuFreqTone(status.cpu_freq_pct)}
        />
        <StatCard
          label="Load average"
          value={status.load_avg ? status.load_avg.map((n) => n.toFixed(2)).join(' / ') : null}
        />
      </div>
    </section>
  )
}
