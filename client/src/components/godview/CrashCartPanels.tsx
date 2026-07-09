import { CatEmptyState } from '../CatEmptyState'
import type { ServerStatus } from '../../lib/types'
import { PipelinePanel } from './PipelinePanel'
import { RecordingRunwayPanel } from './RecordingRunwayPanel'
import { VitalsPanel } from './VitalsPanel'
import { WorkerLivenessPanel } from './WorkerLivenessPanel'

export function CrashCartPanels({ status }: { status: ServerStatus | null }) {
  return (
    <section aria-labelledby="crash-cart-h2" className="space-y-3">
      <div>
        <h2 id="crash-cart-h2" className="text-lg font-semibold text-[var(--color-text-primary)]">
          Crash Cart
        </h2>
        <p className="mt-1 text-sm text-[var(--color-text-secondary)]">
          Read-only live health from the existing status endpoint.
        </p>
      </div>
      {status === null ? (
        <div className="rounded-lg border-[1.5px] border-[var(--color-border)] bg-[var(--color-surface)] shadow-[var(--shadow-subtle)]">
          <CatEmptyState
            mood="watching"
            heading="Can't reach the Jetson"
            body="No status from the server yet."
            ariaLabel="Can't reach the Jetson"
          />
        </div>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-2">
          <PipelinePanel status={status} />
          <VitalsPanel status={status} />
          <RecordingRunwayPanel status={status} />
          <WorkerLivenessPanel status={status} />
        </div>
      )}
    </section>
  )
}
