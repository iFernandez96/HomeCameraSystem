import type { ReactNode } from 'react'

export type StatTone = 'ok' | 'warn' | 'down' | 'neutral'

const toneClass: Record<StatTone, string> = {
  ok: 'text-[var(--color-text-primary)]',
  warn: 'text-[var(--color-warning)]',
  down: 'text-[var(--color-danger)]',
  neutral: 'text-[var(--color-text-primary)]',
}

export function StatCard({
  label,
  value,
  unit,
  tone = 'neutral',
  children,
}: {
  label: string
  value: ReactNode | null | undefined
  unit?: string
  tone?: StatTone
  children?: ReactNode
}) {
  const displayValue = value == null || value === '' ? '—' : value
  return (
    <div className="rounded-lg border-[1.5px] border-[var(--color-border)] bg-[var(--color-surface)] p-3 shadow-[var(--shadow-subtle)]">
      <dl className="space-y-1">
        <div>
          <dt className="text-xs font-medium uppercase tracking-normal text-[var(--color-text-secondary)]">
            {label}
          </dt>
          <dd className={`text-lg font-semibold ${toneClass[tone]}`}>
            {displayValue}
            {unit && displayValue !== '—' ? (
              <span className="ml-1 text-sm font-medium text-[var(--color-text-secondary)]">
                {unit}
              </span>
            ) : null}
          </dd>
        </div>
      </dl>
      {children}
    </div>
  )
}
