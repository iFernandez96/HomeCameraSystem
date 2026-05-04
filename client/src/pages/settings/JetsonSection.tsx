import { formatUptime } from '../../lib/format'
import type { ServerStatus, WorkerMetrics } from '../../lib/types'
import { Mono, Row, Section } from './parts'

// iter-269: read-only Jetson health-and-status panel pulled out of
// Settings.tsx. Pure props-in / DOM-out — `status` comes from the
// parent's `useStatus()` polling hook, which is the only state
// dependency. The five small helper components (InferenceLatency,
// CpuFreqPct, StreamRecoveries, DroppedFrames, FaceRecogStatus) live
// alongside because they're only used in this section. Moving them
// into a dedicated module continues the iter-268 Settings.tsx split
// (1471 lines pre-iter-269 → ~1280 after this pull-out).

export function JetsonSection({
  status,
}: {
  status: ServerStatus | null
}) {
  return (
    // iter-356.56 (Frank S5 + Settings redesign brief): renamed
    // section + row labels from developer vocabulary ("Jetson",
    // "Worker", "Server uptime", "Face recog") to plain English a
    // homeowner reads in 2 seconds. The wire shape under the hood
    // is unchanged; only the labels are user-facing.
    <Section title="Camera box health">
      <Row label="Camera box" right={<Mono>{status?.ok ? 'online' : '—'}</Mono>} />
      <Row
        label="On since"
        right={
          <Mono>
            {status?.uptime_s ? formatUptime(status.uptime_s) : '—'}
          </Mono>
        }
      />
      <Row
        label="Detection running"
        right={
          <Mono>
            {status?.worker_metrics?.uptime_s != null
              ? formatUptime(status.worker_metrics.uptime_s)
              : '—'}
          </Mono>
        }
      />
      <Row label="Camera" right={<Mono>{status?.camera ?? '—'}</Mono>} />
      <Row
        label="Watching for people"
        right={<Mono>{status?.detection_active ? 'on' : 'off'}</Mono>}
      />
      <Row
        label="Face recognition"
        right={
          <FaceRecogStatus names={status?.worker_metrics?.face_recog_names} />
        }
      />
      <Row
        label="Detection process"
        right={
          <Mono>
            {status?.worker_alive
              ? 'online'
              : status?.worker_last_seen_s != null
                ? `offline (${Math.floor(status.worker_last_seen_s)}s)`
                : '—'}
          </Mono>
        }
      />
      <Row
        label="CPU temp"
        right={
          <Mono>
            {status?.cpu_temp_c != null
              ? `${status.cpu_temp_c.toFixed(1)} °C`
              : '—'}
          </Mono>
        }
      />
      <Row
        label="GPU temp"
        right={
          <Mono>
            {status?.gpu_temp_c != null
              ? `${status.gpu_temp_c.toFixed(1)} °C`
              : '—'}
          </Mono>
        }
      />
      <Row
        label="CPU clock"
        right={<CpuFreqPct pct={status?.cpu_freq_pct ?? null} />}
      />
      <Row
        label="Load avg"
        right={
          <Mono>
            {status?.load_avg != null
              ? status.load_avg.map((n) => n.toFixed(2)).join(' · ')
              : '—'}
          </Mono>
        }
      />
      <Row
        label="Memory"
        right={
          <Mono>
            {status?.memory_used_mb != null && status?.memory_total_mb
              ? `${(status.memory_used_mb / 1024).toFixed(1)} / ${(status.memory_total_mb / 1024).toFixed(1)} GB`
              : '—'}
          </Mono>
        }
      />
      <Row
        label="Disk free"
        right={
          <Mono>
            {status?.disk_free_gb != null
              ? `${status.disk_free_gb.toFixed(0)} GB`
              : '—'}
          </Mono>
        }
      />
      <Row label="FPS" right={<Mono>{status?.fps?.toFixed(1) ?? '—'}</Mono>} />
      <Row
        label="Inference"
        right={
          <InferenceLatency metrics={status?.worker_metrics ?? null} />
        }
      />
      <Row
        label="Dropped frames"
        right={<DroppedFrames metrics={status?.worker_metrics ?? null} />}
      />
      <Row
        label="Stream recoveries"
        right={
          <StreamRecoveries metrics={status?.worker_metrics ?? null} />
        }
      />
    </Section>
  )
}

function InferenceLatency({ metrics }: { metrics: WorkerMetrics | null }) {
  // SSD-MobileNet-v2 at FP16 on the Nano 2GB lives around 45 ms. We pin
  // yellow at 80 ms (clearly above headroom) and red at 150 ms (the
  // GPU thermal-throttle range) so the user spots throttling at a
  // glance without needing to know the absolute baseline. The color is
  // driven by the p95 (when available) so a single cold-cache spike on
  // recent doesn't paint the row red.
  const ms = metrics?.infer_ms_recent
  if (ms == null || ms === 0) return <Mono>—</Mono>
  const p95 = metrics?.infer_ms_p95
  const colorBasis = p95 != null && p95 > 0 ? p95 : ms
  const color =
    colorBasis >= 150
      ? 'text-red-400'
      : colorBasis >= 80
        ? 'text-yellow-400'
        : 'text-[var(--color-text-secondary)]'
  return (
    <span className={`tabular-nums text-sm ${color}`}>
      {ms.toFixed(1)} ms
      {p95 != null && p95 > 0 ? (
        <span className="text-neutral-600 ml-1">(p95 {p95.toFixed(1)})</span>
      ) : null}
    </span>
  )
}

function CpuFreqPct({ pct }: { pct: number | null }) {
  // Throttle ceiling. 100 % = the governor will let the CPU run at the
  // SoC's rated max. Below 100 % means a thermal trip or nvpmodel cap
  // is holding the ceiling down. Yellow at < 95 % (mild constraint),
  // red at < 75 % (significant throttle).
  if (pct == null) return <Mono>—</Mono>
  const color =
    pct < 75 ? 'text-red-400' : pct < 95 ? 'text-yellow-400' : 'text-[var(--color-text-secondary)]'
  return (
    <span className={`tabular-nums text-sm ${color}`}>
      {pct.toFixed(1)} %
    </span>
  )
}

function StreamRecoveries({ metrics }: { metrics: WorkerMetrics | null }) {
  // The detection worker's mediamtx watchdog kicks the gateway when
  // captures time out for ~60 s straight. Healthy operation = 0. A
  // single recovery is fine (transient USB / argus blip); 3+ usually
  // means something further upstream is wrong (cable, power, thermals).
  const n = metrics?.mediamtx_restarts
  if (n == null) return <Mono>—</Mono>
  const color =
    n >= 3 ? 'text-red-400' : n >= 1 ? 'text-yellow-400' : 'text-[var(--color-text-secondary)]'
  return <span className={`tabular-nums text-sm ${color}`}>{n}</span>
}

function DroppedFrames({ metrics }: { metrics: WorkerMetrics | null }) {
  // The worker reports cumulative dropped-frame count alongside total
  // captured `frames`. Dropped is only meaningful relative to throughput,
  // so render both — and color-code once the rate exceeds 1 % to flag
  // chronic RTSP / decoder issues.
  if (!metrics || metrics.dropped == null) return <Mono>—</Mono>
  const dropped = metrics.dropped
  const frames = metrics.frames ?? 0
  const total = dropped + frames
  const pct = total > 0 ? (dropped / total) * 100 : 0
  const color =
    pct >= 5 ? 'text-red-400' : pct >= 1 ? 'text-yellow-400' : 'text-[var(--color-text-secondary)]'
  return (
    <span className={`tabular-nums text-sm ${color}`}>
      {dropped.toLocaleString()}
      {total > 0 && (
        <span className="text-neutral-600 ml-1">({pct.toFixed(2)}%)</span>
      )}
    </span>
  )
}

function FaceRecogStatus({ names }: { names: string[] | undefined }) {
  // names absent = worker hasn't reported yet (no heartbeat metrics
  // surfaced); empty = recognition is disabled / no encodings loaded;
  // non-empty = list of known people.
  if (names === undefined) {
    return <Mono>—</Mono>
  }
  if (names.length === 0) {
    return <span className="text-[var(--color-text-tertiary)] text-sm">disabled</span>
  }
  return (
    <span className="flex items-center gap-1.5 flex-wrap justify-end">
      {names.slice(0, 4).map((n) => (
        <span
          key={n}
          className="px-2 py-0.5 text-[11px] rounded-full bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 capitalize"
        >
          {n}
        </span>
      ))}
      {names.length > 4 && (
        <span className="text-[var(--color-text-tertiary)] text-sm tabular-nums">
          +{names.length - 4}
        </span>
      )}
    </span>
  )
}
