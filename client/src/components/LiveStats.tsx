import { useState } from 'react'
import { formatAge, formatUptime } from '../lib/format'
import type { ServerStatus } from '../lib/types'

/**
 * iter-356.15 (Maya 9th-sweep CRITICAL #1) — System Health card.
 *
 * Pre-iter-356.15 this rendered as a 7-stat tabular-nums grid:
 *   `CPU 54°C · GPU 61°C · mem 1.7/2.0 GB · up 3d 2h · load 1.42 ·
 *    disk 18 GB free · Watching: active`
 * — a Grafana panel pasted onto a consumer app. Frank's wife reads
 * "GB" and assumes the camera is broken; Maya called this the next
 * tier-1 design crime to fix on Live.
 *
 * Now: a single health-summary line (icon dot + plain-English status
 * + optional sub-line) backed by a collapsible "System details"
 * disclosure that surfaces the existing stat grid for power users.
 *
 * Health rules — strongest signal wins:
 *   1. Worker offline → red, "Camera offline" + reconnect hint
 *   2. Worker paused (low memory / thermal) → red, explanatory copy
 *   3. CPU/GPU temp ≥ 85°C OR clock throttled → amber, "Camera running warm"
 *   4. Worker manually paused / scheduled-off → amber, "Detection paused"
 *   5. Memory ≥ 90% → amber, "Memory running tight"
 *   6. Everything else → green, "All systems normal"
 *
 * Acceptance per Maya: "the team's pride is no longer in the
 * telemetry — it's in the experience."
 */

type HealthLevel = 'ok' | 'warn' | 'error'

type HealthSummary = {
  level: HealthLevel
  label: string
  hint?: string
}

function computeHealth(status: ServerStatus): HealthSummary {
  const gear = status.worker_metrics?.gear
  const isManuallyOff = gear === 'off'
  const isScheduledOff = gear === 'scheduled-off'
  const isLowMemory = gear === 'low-memory'
  const isThermal = gear === 'thermal-throttled'

  // 1. Worker offline takes precedence.
  if (!status.worker_alive) {
    const seenAge =
      status.worker_last_seen_s != null
        ? `Last seen ${formatAge(status.worker_last_seen_s)} ago.`
        : "We haven't heard from the camera since this app loaded."
    return {
      level: 'error',
      label: 'Camera offline',
      hint: `${seenAge} It usually comes back on its own — wait a moment.`,
    }
  }

  // 2. Hard pauses from the worker side.
  if (isLowMemory) {
    return {
      level: 'error',
      label: 'Detection paused — low memory',
      hint: 'The camera will resume on its own when the system frees up memory.',
    }
  }

  // 3. Thermal — show as warning even if the worker is still doing
  //    its slowed-down job.
  const hottestTemp = Math.max(
    status.cpu_temp_c ?? 0,
    status.gpu_temp_c ?? 0,
  )
  const throttled =
    status.cpu_freq_pct != null && status.cpu_freq_pct < 95
  if (isThermal || hottestTemp >= 85 || throttled) {
    return {
      level: 'warn',
      label: 'Camera running warm',
      hint: isThermal
        ? 'Detection slowed down to cool off. It will speed up when the camera cools.'
        : throttled
          ? 'CPU is running slower than usual to manage heat.'
          : 'Temperature is high but still safe.',
    }
  }

  // 4. Manual / scheduled detection pauses are notable but not bad.
  if (isManuallyOff) {
    return {
      level: 'warn',
      // iter-356.57 (cat-brand brief): Panther is the Sentry; her
      // off-duty state IS the manual-pause state.
      label: "Panther's off duty",
      hint: 'Tap Resume on the action panel to bring her back on watch.',
    }
  }
  if (isScheduledOff) {
    return {
      level: 'warn',
      // iter-356.57: scheduled quiet hours = Coco's hours (her
      // dominant activity is sleep — coherent role mapping).
      label: "Coco's hours",
      hint: 'Detection resumes automatically at the end of your quiet window.',
    }
  }

  // 5. Tight memory but not at the worker-pause threshold.
  if (
    status.memory_used_mb != null &&
    status.memory_total_mb &&
    status.memory_used_mb / status.memory_total_mb >= 0.9
  ) {
    return {
      level: 'warn',
      label: 'Memory running tight',
      hint: 'The camera should keep running, but heavy detection may slow.',
    }
  }

  // iter-356.57: "All systems normal" was Frank-flagged engineer
  // voice. "Home is calm" is den-voice (passion-project register).
  // Hint added to reinforce the watch metaphor.
  return { level: 'ok', label: 'Home is calm' }
}

export function LiveStats({ status, compact }: { status: ServerStatus | null; compact?: boolean }) {
  const [detailsOpen, setDetailsOpen] = useState(false)

  if (!status) {
    return (
      <div
        aria-busy="true"
        className={
          compact
            ? 'h-10 px-3 flex items-center justify-center text-xs text-white/70 bg-black/55 backdrop-blur ring-1 ring-white/15 rounded-xl'
            : 'h-12 px-3 flex items-center justify-center text-sm text-[var(--color-text-secondary)]'
        }
      >
        Connecting to camera…
      </div>
    )
  }

  const health = computeHealth(status)
  const dotColor =
    health.level === 'ok'
      ? 'bg-[var(--color-success)]'
      : health.level === 'warn'
        ? 'bg-[var(--color-warning)]'
        : 'bg-[var(--color-danger)]'
  const labelColor =
    health.level === 'ok'
      ? 'text-[var(--color-text-primary)]'
      : health.level === 'warn'
        ? 'text-[var(--color-warning)]'
        : 'text-[var(--color-danger)]'
  const ringClass =
    health.level === 'ok'
      ? 'ring-[var(--color-success-border)]'
      : health.level === 'warn'
        ? 'ring-[var(--color-warning-border)]'
        : 'ring-[var(--color-danger-border)]'

  // iter-356.58 (layout rebuild): `compact` mode — overlaid on the
  // dark video field as a floating watch-panel. Glass surface + white
  // text + tighter spacing. The disclosure is dropped in this mode
  // because the panel is meant to be a persistent glance-target, not
  // a navigable drawer; tapping the small "more" link leads users
  // through to /settings/system anyway.
  if (compact) {
    return (
      <section
        aria-label="Watch panel"
        className="bg-black/55 backdrop-blur ring-1 ring-white/15 rounded-2xl px-3 py-3 space-y-2.5 text-white"
      >
        <div role="status" aria-live="polite">
          <div className="flex items-center gap-2.5">
            <span aria-hidden="true" className={`w-2.5 h-2.5 rounded-full ${dotColor}`} />
            <span className="text-sm font-semibold">{health.label}</span>
          </div>
          {health.hint && (
            <p className="text-[11px] text-white/70 mt-1 ml-5 leading-snug">{health.hint}</p>
          )}
        </div>
        <CompactStatStrip status={status} />
      </section>
    )
  }

  return (
    <section
      aria-label="System health"
      className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl px-4 py-3 space-y-3 shadow-[var(--shadow-subtle)]"
    >
      {/* Summary row: dot + label + optional sub-line. */}
      <div role="status" aria-live="polite">
        <div className="flex items-center gap-2.5">
          <span
            aria-hidden="true"
            className={`w-2.5 h-2.5 rounded-full ${dotColor} ring-2 ${ringClass}`}
          />
          <span className={`text-base font-medium ${labelColor}`}>
            {health.label}
          </span>
        </div>
        {health.hint && (
          <p className="text-sm text-[var(--color-text-secondary)] mt-1 ml-5">
            {health.hint}
          </p>
        )}
      </div>

      <StatStrip status={status} />

      <div>
        <button
          type="button"
          onClick={() => setDetailsOpen((v) => !v)}
          aria-expanded={detailsOpen}
          aria-controls="system-details"
          className="text-xs text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)] focus-visible:outline-2 focus-visible:outline-[var(--color-accent-default)] focus-visible:outline-offset-2 rounded inline-flex items-center gap-1"
        >
          <span
            aria-hidden="true"
            className={`inline-block transition-transform duration-150 text-[var(--color-accent-default)] ${detailsOpen ? 'rotate-90' : ''}`}
          >
            ▸
          </span>
          {detailsOpen ? 'Hide camera box details' : 'Camera box details'}
        </button>
        {detailsOpen && <SystemDetails id="system-details" status={status} />}
      </div>
    </section>
  )
}

/**
 * iter-356.56 — 2-row stat strip. Sources every value from existing
 * ServerStatus fields (no new backend route required).
 *
 * Row 1: FPS · Inference · Dropped frames (only if nonzero)
 * Row 2: Last frame age · Disk free
 *
 * When `worker_alive=false`, every stat falls to em-dash so the
 * layout doesn't collapse and the offline state reads consistent.
 */
function StatStrip({ status }: { status: ServerStatus }) {
  const wm = status.worker_metrics
  const alive = status.worker_alive
  const fps =
    !alive ? '—' : wm?.fps != null ? `${wm.fps.toFixed(0)} fps` : '—'
  const inferMs =
    !alive
      ? '—'
      : wm?.infer_ms_recent != null
        ? `${wm.infer_ms_recent.toFixed(0)} ms`
        : '—'
  const dropped =
    !alive || wm?.dropped == null || wm.dropped === 0
      ? null
      : `${wm.dropped} dropped`
  const lastFrame =
    !alive
      ? '—'
      : status.seconds_since_last_frame != null
        ? status.seconds_since_last_frame < 5
          ? 'Live now'
          : `${formatAge(status.seconds_since_last_frame)} ago`
        : '—'
  const diskFree =
    status.disk_free_gb != null ? `${status.disk_free_gb.toFixed(0)} GB free` : '—'
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs border-t border-[var(--color-border-subtle)] pt-3">
      <StatCell label="Frame rate" value={fps} />
      <StatCell label="Inference" value={inferMs} />
      <StatCell label="Last frame" value={lastFrame} />
      <StatCell label="Disk free" value={diskFree} />
      {dropped && (
        <div className="col-span-2 text-[var(--color-warning)]">
          <span className="uppercase tracking-wider text-[10px] mr-1">Dropped</span>
          <span className="font-medium tabular-nums">{dropped}</span>
        </div>
      )}
    </dl>
  )
}

/**
 * iter-356.58: compact watch-panel stat strip — 2-col, white-on-dark.
 */
function CompactStatStrip({ status }: { status: ServerStatus }) {
  const wm = status.worker_metrics
  const alive = status.worker_alive
  const fps = !alive ? '—' : wm?.fps != null ? `${wm.fps.toFixed(0)} fps` : '—'
  const inferMs =
    !alive
      ? '—'
      : wm?.infer_ms_recent != null
        ? `${wm.infer_ms_recent.toFixed(0)} ms`
        : '—'
  const lastFrame =
    !alive
      ? '—'
      : status.seconds_since_last_frame != null
        ? status.seconds_since_last_frame < 5
          ? 'Live'
          : `${formatAge(status.seconds_since_last_frame)} ago`
        : '—'
  const diskFree =
    status.disk_free_gb != null ? `${status.disk_free_gb.toFixed(0)} GB` : '—'
  return (
    <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-[11px] border-t border-white/15 pt-2">
      <div>
        <dt className="uppercase tracking-wider text-[9px] text-white/55">Frame rate</dt>
        <dd className="font-semibold tabular-nums">{fps}</dd>
      </div>
      <div>
        <dt className="uppercase tracking-wider text-[9px] text-white/55">Inference</dt>
        <dd className="font-semibold tabular-nums">{inferMs}</dd>
      </div>
      <div>
        <dt className="uppercase tracking-wider text-[9px] text-white/55">Last frame</dt>
        <dd className="font-semibold tabular-nums">{lastFrame}</dd>
      </div>
      <div>
        <dt className="uppercase tracking-wider text-[9px] text-white/55">Disk free</dt>
        <dd className="font-semibold tabular-nums">{diskFree}</dd>
      </div>
    </dl>
  )
}

function StatCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col">
      <dt className="uppercase tracking-wider text-[10px] text-[var(--color-text-tertiary)]">
        {label}
      </dt>
      <dd className="font-medium tabular-nums text-[var(--color-text-primary)]">
        {value}
      </dd>
    </div>
  )
}

/**
 * The pre-iter-356.15 stat grid, now opt-in via the disclosure
 * above. Power users + operator + Frank's son still get the full
 * thermals + uptime + load + worker label + disk readout.
 */
function SystemDetails({
  id,
  status,
}: {
  id: string
  status: ServerStatus
}) {
  const throttled =
    status.cpu_freq_pct != null && status.cpu_freq_pct < 95
  const cpuColor = throttled ? 'text-red-400' : tempColor(status.cpu_temp_c)
  const gpuColor = tempColor(status.gpu_temp_c)
  const memPct =
    status.memory_used_mb != null && status.memory_total_mb
      ? Math.round((status.memory_used_mb / status.memory_total_mb) * 100)
      : null
  const memColor =
    memPct == null ? '' : memPct >= 90 ? 'text-red-400' : memPct >= 75 ? 'text-yellow-400' : ''
  const loadColor =
    status.load_avg == null
      ? ''
      : status.load_avg[0] >= 4
        ? 'text-red-400'
        : status.load_avg[0] >= 2
          ? 'text-yellow-400'
          : ''

  return (
    <div
      id={id}
      className="mt-2 text-sm text-[var(--color-text-secondary)] space-y-1.5 border-t border-[var(--color-border)] pt-2"
    >
      <div className="flex items-center justify-center gap-2.5 flex-wrap">
        <Stat
          label="CPU"
          valueClass={cpuColor}
          title={
            throttled
              ? `Throttled — clock capped at ${status.cpu_freq_pct?.toFixed(0)}% of max`
              : "The camera's main processor temperature."
          }
        >
          {status.cpu_temp_c != null ? `${status.cpu_temp_c.toFixed(0)}°C` : '—'}
          {throttled && (
            <span className="ml-1" aria-label="throttled">
              ⚠
            </span>
          )}
        </Stat>
        <Stat
          label="GPU"
          valueClass={gpuColor}
          // iter-356.15 (Frank Round-3 D4): tooltip rewritten human-side.
          // Was "Tegra GPU thermal zone — leads the CPU under inference".
          title="The camera's video chip temperature. Climbs when checking for people."
        >
          {status.gpu_temp_c != null ? `${status.gpu_temp_c.toFixed(0)}°C` : '—'}
        </Stat>
        <Dot />
        <Stat label="mem" valueClass={memColor}>
          {memUsage(status.memory_used_mb, status.memory_total_mb)}
        </Stat>
        <Dot />
        <Stat label="up">{formatUptime(status.uptime_s)}</Stat>
      </div>
      <div className="flex items-center justify-center gap-2.5 flex-wrap">
        <Stat label="load" valueClass={loadColor}>
          {status.load_avg != null ? status.load_avg[0].toFixed(2) : '—'}
        </Stat>
        <Dot />
        <Stat label="disk">
          {status.disk_free_gb != null
            ? `${status.disk_free_gb.toFixed(0)} GB free`
            : '—'}
        </Stat>
        <Dot />
        <Stat label="state">{workerStateLabel(status)}</Stat>
      </div>
    </div>
  )
}

function workerStateLabel(status: ServerStatus): string {
  if (!status.worker_alive) {
    return status.worker_last_seen_s != null
      ? `Camera offline (last seen ${formatAge(status.worker_last_seen_s)} ago)`
      : 'Camera offline'
  }
  const m = status.worker_metrics
  if (m?.gear === 'off') return 'Watching: paused'
  if (m?.gear === 'scheduled-off') return 'Watching: paused on schedule'
  if (m?.gear === 'low-memory') return 'Watching: paused — low memory'
  if (m?.gear === 'thermal-throttled')
    return 'Watching: slowed down (running warm)'
  if (m?.gear === 'idle') return 'Watching: standby'
  if (m?.gear === 'active') return 'Watching: active'
  return 'Camera online'
}

function Stat({
  label,
  children,
  valueClass = 'text-[var(--color-text-secondary)]',
  title,
}: {
  label: string
  title?: string
  children: React.ReactNode
  valueClass?: string
}) {
  return (
    <span title={title}>
      <span className="uppercase tracking-wider text-[0.7rem] text-[var(--color-text-secondary)] mr-1">
        {label}
      </span>
      <span className={`font-medium tabular-nums ${valueClass}`}>{children}</span>
    </span>
  )
}

function Dot() {
  return <span aria-hidden className="opacity-30">·</span>
}

function tempColor(c: number | null): string {
  if (c == null) return ''
  if (c >= 85) return 'text-red-400'
  if (c >= 75) return 'text-yellow-400'
  return ''
}

function memUsage(usedMb: number | null, totalMb: number | null): string {
  if (usedMb == null || totalMb == null) return '—'
  const usedGb = usedMb / 1024
  const totalGb = totalMb / 1024
  return `${usedGb.toFixed(1)}/${totalGb.toFixed(1)} GB`
}
