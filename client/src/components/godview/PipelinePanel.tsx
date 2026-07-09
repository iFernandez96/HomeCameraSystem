import { derivePipeline, type PipelineVerdict } from '../../lib/pipelineHealth'
import type { ServerStatus } from '../../lib/types'

const stageLabel = {
  camera: 'Camera',
  mediamtx: 'MediaMTX',
  detect: 'Detect',
  server: 'Server',
}

const verdictLabel: Record<PipelineVerdict, string> = {
  up: 'Up',
  down: 'Down',
  warn: 'Warning',
  unknown: 'Unknown',
}

const verdictClasses: Record<PipelineVerdict, string> = {
  up: 'border-[var(--color-success-border)] bg-[var(--color-success-bg)] text-[var(--color-text-primary)]',
  warn: 'border-[var(--color-warning-border)] bg-[var(--color-warning-bg)] text-[var(--color-warning)]',
  down: 'border-[var(--color-danger-border)] bg-[var(--color-danger-bg)] text-[var(--color-danger)]',
  unknown: 'border-[var(--color-border)] bg-[var(--color-surface-raised)] text-[var(--color-text-secondary)]',
}

const dotClasses: Record<PipelineVerdict, string> = {
  up: 'bg-[var(--color-success)]',
  warn: 'bg-[var(--color-warning)]',
  down: 'bg-[var(--color-danger)]',
  unknown: 'bg-[var(--color-text-disabled)]',
}

export function PipelinePanel({ status }: { status: ServerStatus }) {
  const stages = derivePipeline(status)
  return (
    <section
      aria-labelledby="pipeline-health-h2"
      className="rounded-lg border-[1.5px] border-[var(--color-border)] bg-[var(--color-surface)] p-4 shadow-[var(--shadow-subtle)]"
    >
      <h2 id="pipeline-health-h2" className="text-lg font-semibold text-[var(--color-text-primary)]">
        Pipeline Health
      </h2>
      <div role="list" aria-label="Camera pipeline stages" className="mt-4 grid gap-2 sm:grid-cols-[1fr_auto_1fr_auto_1fr_auto_1fr] sm:items-center">
        {stages.map((stage, idx) => (
          <div key={stage.stage} className="contents">
            <div
              role="listitem"
              aria-label={`${stageLabel[stage.stage]} ${verdictLabel[stage.verdict]}: ${stage.reason}`}
              className={`rounded-full border-[1.5px] px-3 py-2 ${verdictClasses[stage.verdict]}`}
            >
              <div className="flex items-center gap-2">
                <span aria-hidden="true" className={`h-2.5 w-2.5 rounded-full ${dotClasses[stage.verdict]}`} />
                <span className="text-sm font-semibold">{stageLabel[stage.stage]}</span>
              </div>
              <div className="mt-0.5 text-xs">
                {verdictLabel[stage.verdict]} · {stage.reason}
              </div>
            </div>
            {idx < stages.length - 1 ? (
              <div aria-hidden="true" className="hidden text-center text-[var(--color-text-tertiary)] sm:block">
                →
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </section>
  )
}
