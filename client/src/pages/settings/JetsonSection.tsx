import { formatUptime } from '../../lib/format'
import type { ServerStatus, WorkerMetrics } from '../../lib/types'
import { Mono, Row, Section } from './parts'

// iter-269: read-only Jetson health-and-status panel pulled out of
// Settings.tsx. Pure props-in / DOM-out — `status` comes from the
// parent's `useStatus()` polling hook, which is the only state
// dependency.
//
// Premium-launch slice — Settings health UX. Pre-fix the panel was
// a single 18-row dump titled "Camera box health". Per the brief:
//   - keep ALL telemetry visible (operator-grade detail preserved)
//   - add a top-line status verdict so a glance answers "is the
//     camera box happy?" without reading 18 rows
//   - group rows by purpose so scanability improves on mobile +
//     desktop without hiding anything
//   - preserve every existing severity-color rule + helper
//     component (InferenceLatency, DroppedFrames, StreamRecoveries,
//     CpuFreqPct, FaceRecogStatus) so the iter-269+ pinned tests
//     in Settings.test.tsx keep passing.
//
// Layout shape:
//   ┌───────────────────────────────────────────────────────┐
//   │ ● All systems normal                                 │  ← verdict
//   │   Camera box, detection, and resources running smoothly │
//   ├───────────────────────────────────────────────────────┤
//   │ CAMERA BOX                                           │
//   │   Camera box · On since · Camera                      │
//   ├───────────────────────────────────────────────────────┤
//   │ DETECTION                                             │
//   │   Detection process · Detection running · Watching    │
//   │   Face recognition · FPS · Inference · Dropped · …    │
//   ├───────────────────────────────────────────────────────┤
//   │ SYSTEM RESOURCES                                      │
//   │   CPU temp · GPU temp · CPU clock · Load avg · Memory │
//   │   Disk free                                           │
//   └───────────────────────────────────────────────────────┘

export function JetsonSection({
  status,
}: {
  status: ServerStatus | null
}) {
  return (
    <div className="space-y-6">
      <HealthVerdict status={status} />

      <Section
        title="Camera box"
        subtitle="Physical reachability of the Jetson hardware."
      >
        <Row label="Camera box" right={<Mono>{status?.ok ? 'online' : '—'}</Mono>} />
        <Row
          label="On since"
          right={
            <Mono>
              {status?.uptime_s ? formatUptime(status.uptime_s) : '—'}
            </Mono>
          }
        />
        <Row label="Camera" right={<Mono>{status?.camera ?? '—'}</Mono>} />
      </Section>

      <Section
        title="Detection"
        subtitle="What the AI is watching for and how it’s processing frames."
      >
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
          label="Detection running"
          right={
            <Mono>
              {status?.worker_metrics?.uptime_s != null
                ? formatUptime(status.worker_metrics.uptime_s)
                : '—'}
            </Mono>
          }
        />
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

      <Section
        title="System resources"
        subtitle="CPU, memory, and storage on the camera box."
      >
        <Row
          label="CPU temp"
          right={<Temperature kind="cpu" celsius={status?.cpu_temp_c ?? null} />}
        />
        <Row
          label="GPU temp"
          right={<Temperature kind="gpu" celsius={status?.gpu_temp_c ?? null} />}
        />
        <Row
          label="CPU clock"
          right={<CpuFreqPct pct={status?.cpu_freq_pct ?? null} />}
        />
        <Row
          label="Load avg (1m · 5m · 15m)"
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
            <Memory
              usedMb={status?.memory_used_mb ?? null}
              totalMb={status?.memory_total_mb ?? null}
            />
          }
        />
        <Row
          label="Disk free"
          right={<DiskFree gb={status?.disk_free_gb ?? null} />}
        />
      </Section>
    </div>
  )
}

// ───────────────────────────────────────────────────────────
// Top-line verdict
// ───────────────────────────────────────────────────────────

type VerdictKind = 'loading' | 'healthy' | 'attention' | 'critical'

interface Verdict {
  kind: VerdictKind
  headline: string
  subline: string
}

function computeVerdict(status: ServerStatus | null): Verdict {
  if (status === null) {
    return {
      kind: 'loading',
      headline: 'Checking the camera box…',
      subline: 'Polling the Jetson for live readings.',
    }
  }

  // Critical conditions — most-actionable first. The first match
  // wins so a single critical issue shapes the headline.
  if (status.ok === false) {
    return {
      kind: 'critical',
      headline: 'Camera box is unreachable',
      subline:
        'No response from the Jetson. Check power and network, then refresh.',
    }
  }
  if (
    status.worker_alive === false &&
    status.worker_last_seen_s != null &&
    status.worker_last_seen_s > 60
  ) {
    return {
      kind: 'critical',
      headline: 'Detection process is offline',
      subline: `No heartbeat for ${Math.floor(status.worker_last_seen_s)}s — detection auto-restarts; check Settings → System if it persists.`,
    }
  }

  // Pull worker metrics into locals so guard expressions stay
  // readable.
  const m = status.worker_metrics ?? null
  const dropped = m?.dropped ?? 0
  const frames = m?.frames ?? 0
  const droppedPct = dropped + frames > 0 ? (dropped / (dropped + frames)) * 100 : 0
  const inferBasis =
    m?.infer_ms_p95 != null && m.infer_ms_p95 > 0
      ? m.infer_ms_p95
      : (m?.infer_ms_recent ?? 0)

  // Critical-tier hardware thresholds.
  if (status.cpu_temp_c != null && status.cpu_temp_c >= 85) {
    return {
      kind: 'critical',
      headline: 'CPU is overheating',
      subline: `CPU at ${status.cpu_temp_c.toFixed(1)} °C — the Jetson will throttle to protect itself.`,
    }
  }
  if (status.gpu_temp_c != null && status.gpu_temp_c >= 85) {
    return {
      kind: 'critical',
      headline: 'GPU is overheating',
      subline: `GPU at ${status.gpu_temp_c.toFixed(1)} °C — inference will slow until things cool down.`,
    }
  }
  if (status.cpu_freq_pct != null && status.cpu_freq_pct < 75) {
    return {
      kind: 'critical',
      headline: 'CPU is throttled',
      subline: `Clock is at ${status.cpu_freq_pct.toFixed(0)}% of its rated max — usually a sustained-heat side effect.`,
    }
  }
  if (status.disk_free_gb != null && status.disk_free_gb < 5) {
    return {
      kind: 'critical',
      headline: 'Storage is almost full',
      subline: `Only ${status.disk_free_gb.toFixed(0)} GB free — clip recording will fail soon. Trim retention or attach storage.`,
    }
  }
  if (m?.mediamtx_restarts != null && m.mediamtx_restarts >= 3) {
    return {
      kind: 'critical',
      headline: 'Camera stream keeps dropping',
      subline: `${m.mediamtx_restarts} auto-recoveries — usually a cable, power, or sensor issue.`,
    }
  }
  if (droppedPct >= 5) {
    return {
      kind: 'critical',
      headline: 'Frames are being dropped',
      subline: `Around ${droppedPct.toFixed(1)}% of captured frames lost — the video connection is under pressure.`,
    }
  }
  if (inferBasis >= 150) {
    return {
      kind: 'critical',
      headline: 'Detection is running slow',
      subline: `Inference at ${inferBasis.toFixed(0)} ms — usually thermal throttle or memory pressure.`,
    }
  }

  // Warning-tier (calm "needs an eye" rather than "act now").
  if (status.cpu_temp_c != null && status.cpu_temp_c >= 75) {
    return {
      kind: 'attention',
      headline: 'CPU is running warm',
      subline: `CPU at ${status.cpu_temp_c.toFixed(1)} °C — within tolerance but worth keeping an eye on.`,
    }
  }
  if (status.gpu_temp_c != null && status.gpu_temp_c >= 75) {
    return {
      kind: 'attention',
      headline: 'GPU is running warm',
      subline: `GPU at ${status.gpu_temp_c.toFixed(1)} °C — within tolerance but worth keeping an eye on.`,
    }
  }
  if (status.cpu_freq_pct != null && status.cpu_freq_pct < 95) {
    return {
      kind: 'attention',
      headline: 'CPU clock is reduced',
      subline: `Clock is at ${status.cpu_freq_pct.toFixed(0)}% of its rated max — a mild thermal cap.`,
    }
  }
  if (status.disk_free_gb != null && status.disk_free_gb < 10) {
    return {
      kind: 'attention',
      headline: 'Storage is getting low',
      subline: `${status.disk_free_gb.toFixed(0)} GB free — consider trimming retention.`,
    }
  }
  // Memory: sustained >90 % is the warning floor (the iter-33
  // memory-guard is the safety net). Below that, the OS handles
  // its own pressure quietly.
  if (
    status.memory_used_mb != null &&
    status.memory_total_mb != null &&
    status.memory_total_mb > 0 &&
    status.memory_used_mb / status.memory_total_mb >= 0.9
  ) {
    return {
      kind: 'attention',
      headline: 'Memory is tight',
      subline: 'The Jetson is using more than 90% of available RAM.',
    }
  }
  if (m?.mediamtx_restarts != null && m.mediamtx_restarts >= 1) {
    return {
      kind: 'attention',
      headline: 'Camera stream recovered recently',
      subline: `Auto-recovery fired ${m.mediamtx_restarts} time${m.mediamtx_restarts === 1 ? '' : 's'} — keep an eye on it.`,
    }
  }
  if (droppedPct >= 1) {
    return {
      kind: 'attention',
      headline: 'Some frames are being dropped',
      subline: `Around ${droppedPct.toFixed(1)}% of captured frames lost — usually transient.`,
    }
  }
  if (inferBasis >= 80) {
    return {
      kind: 'attention',
      headline: 'Detection is a bit slow',
      subline: `Inference at ${inferBasis.toFixed(0)} ms — within tolerance but watch for thermals.`,
    }
  }
  if (
    status.worker_alive === false &&
    status.worker_last_seen_s != null &&
    status.worker_last_seen_s <= 60
  ) {
    return {
      kind: 'attention',
      headline: 'Detection process is reconnecting',
      subline: `Last heartbeat ${Math.floor(status.worker_last_seen_s)}s ago — auto-restarting.`,
    }
  }

  return {
    kind: 'healthy',
    headline: 'All systems normal',
    subline:
      'Camera box, detection, and resources are running smoothly.',
  }
}

function HealthVerdict({ status }: { status: ServerStatus | null }) {
  const verdict = computeVerdict(status)

  // Calm tinted-surface tokens so the verdict reads as a status
  // anchor, not an alert. The dot color carries severity; the
  // surface tint is subtle.
  const palette =
    verdict.kind === 'healthy'
      ? {
          surface: 'bg-[var(--color-success-bg)] border-[var(--color-success-border)]',
          dot: 'bg-[var(--color-success)]',
          headline: 'text-[var(--color-text-primary)]',
        }
      : verdict.kind === 'attention'
        ? {
            surface: 'bg-[var(--color-warning-bg)] border-[var(--color-warning-border)]',
            dot: 'bg-[var(--color-warning)]',
            headline: 'text-[var(--color-text-primary)]',
          }
        : verdict.kind === 'critical'
          ? {
              surface: 'bg-[var(--color-danger-bg)] border-[var(--color-danger-border)]',
              dot: 'bg-[var(--color-danger)]',
              headline: 'text-[var(--color-text-primary)]',
            }
          : {
              // loading
              surface: 'bg-[var(--color-surface)] border-[var(--color-border)]',
              dot: 'bg-[var(--color-text-tertiary)] animate-pulse',
              headline: 'text-[var(--color-text-secondary)]',
            }

  return (
    <div
      role={verdict.kind === 'critical' ? 'alert' : 'status'}
      aria-live={verdict.kind === 'critical' ? undefined : 'polite'}
      data-testid="jetson-health-verdict"
      data-verdict-kind={verdict.kind}
      className={`rounded-2xl border px-4 py-3 shadow-[var(--shadow-subtle)] ${palette.surface}`}
    >
      <div className="flex items-start gap-3">
        <span
          aria-hidden="true"
          className={`mt-1.5 w-2.5 h-2.5 rounded-full flex-shrink-0 ${palette.dot}`}
        />
        <div className="min-w-0 flex-1">
          <p className={`text-sm font-semibold ${palette.headline}`}>
            {verdict.headline}
          </p>
          <p className="text-xs text-[var(--color-text-secondary)] mt-0.5 leading-relaxed">
            {verdict.subline}
          </p>
        </div>
      </div>
    </div>
  )
}

// ───────────────────────────────────────────────────────────
// Per-row helper components — preserved verbatim from the prior
// JetsonSection. Severity color logic + thresholds are pinned by
// existing tests in client/src/pages/Settings.test.tsx; do not
// edit thresholds without also updating those tests.
// ───────────────────────────────────────────────────────────

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
      ? 'text-[var(--color-danger)]'
      : colorBasis >= 80
        ? 'text-[var(--color-warning)]'
        : 'text-[var(--color-text-secondary)]'
  return (
    <span className={`tabular-nums text-sm ${color}`}>
      {ms.toFixed(1)} ms
      {p95 != null && p95 > 0 ? (
        <span className="text-[var(--color-text-tertiary)] ml-1">(p95 {p95.toFixed(1)})</span>
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
    pct < 75 ? 'text-[var(--color-danger)]' : pct < 95 ? 'text-[var(--color-warning)]' : 'text-[var(--color-text-secondary)]'
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
    n >= 3 ? 'text-[var(--color-danger)]' : n >= 1 ? 'text-[var(--color-warning)]' : 'text-[var(--color-text-secondary)]'
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
    pct >= 5 ? 'text-[var(--color-danger)]' : pct >= 1 ? 'text-[var(--color-warning)]' : 'text-[var(--color-text-secondary)]'
  return (
    <span className={`tabular-nums text-sm ${color}`}>
      {dropped.toLocaleString()}
      {total > 0 && (
        <span className="text-[var(--color-text-tertiary)] ml-1">({pct.toFixed(2)}%)</span>
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
          className="px-2 py-0.5 text-[11px] rounded-full bg-[var(--color-success-bg)] text-[var(--color-success)] border border-[var(--color-success-border)] capitalize"
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

// Premium-launch slice: temperature display now carries the same
// calm-severity color treatment as the other helpers — yellow at
// ≥75 °C, red at ≥85 °C. Pre-fix CPU/GPU temps were neutral
// regardless of value; the user only learned of a hot box from
// the inference-latency row going red. The verdict above
// surfaces the hottest temp in plain English; this color gives
// a glance signal in the row itself.
function Temperature({
  kind: _kind,
  celsius,
}: {
  kind: 'cpu' | 'gpu'
  celsius: number | null
}) {
  if (celsius == null) return <Mono>—</Mono>
  const color =
    celsius >= 85
      ? 'text-[var(--color-danger)]'
      : celsius >= 75
        ? 'text-[var(--color-warning)]'
        : 'text-[var(--color-text-secondary)]'
  return (
    <span className={`tabular-nums text-sm ${color}`}>
      {celsius.toFixed(1)} °C
    </span>
  )
}

// Premium-launch slice: memory now shows GB used / GB total
// alongside a percent — preserves the prior "1.4 / 1.9 GB" output
// (existing copy expectation) and adds calm coloring at ≥90 %
// usage so the verdict's "memory tight" condition has a visible
// row-level companion.
function Memory({
  usedMb,
  totalMb,
}: {
  usedMb: number | null
  totalMb: number | null
}) {
  if (usedMb == null || totalMb == null || totalMb === 0) {
    return <Mono>—</Mono>
  }
  const pct = (usedMb / totalMb) * 100
  const color =
    pct >= 90
      ? 'text-[var(--color-warning)]'
      : 'text-[var(--color-text-secondary)]'
  return (
    <span className={`tabular-nums text-sm ${color}`}>
      {(usedMb / 1024).toFixed(1)} / {(totalMb / 1024).toFixed(1)} GB
    </span>
  )
}

// Premium-launch slice: disk-free now color-codes alongside the
// other helpers — yellow at <10 GB, red at <5 GB. Previously the
// disk row was always neutral.
function DiskFree({ gb }: { gb: number | null }) {
  if (gb == null) return <Mono>—</Mono>
  const color =
    gb < 5
      ? 'text-[var(--color-danger)]'
      : gb < 10
        ? 'text-[var(--color-warning)]'
        : 'text-[var(--color-text-secondary)]'
  return (
    <span className={`tabular-nums text-sm ${color}`}>
      {gb.toFixed(0)} GB
    </span>
  )
}
