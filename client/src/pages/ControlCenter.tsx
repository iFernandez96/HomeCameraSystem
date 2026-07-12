import { Link } from 'react-router-dom'
import { OperationsSection } from './settings/OperationsSection'

export function ControlCenter() {
  return (
    <section aria-labelledby="control-center-h1" className="mx-auto max-w-5xl space-y-5 p-4 md:p-6">
      <header className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.16em] text-[var(--color-text-tertiary)]">Owner operations</p>
          <h1 id="control-center-h1" className="page-title mt-1 text-3xl text-[var(--color-text-primary)]">Control Center</h1>
          <p className="mt-1 max-w-2xl text-sm text-[var(--color-text-secondary)]">Is HomeCam watching, recording, notifying, and storing footage correctly?</p>
        </div>
        <Link to="/settings" className="inline-flex min-h-11 items-center rounded-full px-3 text-sm font-semibold text-[var(--color-accent-deep)]">Settings</Link>
      </header>
      <OperationsSection />
    </section>
  )
}
