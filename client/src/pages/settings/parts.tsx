import type { ReactNode } from 'react'
import { RETENTION_PRESETS, type RetentionPreset } from '../../lib/types'

// iter-268: shared layout primitives extracted from Settings.tsx so
// individual sections can be moved to their own files (the iter-235
// audit + iter-267 3-auditor convergent #1 named the 1969-line
// Settings.tsx as the top refactor target). Section + Row + Mono
// are pure presentational components — no state, no effects —
// safe to render anywhere.
//
// iter-290: Toggle, TimeInput, RetentionPresetPicker added below.
//
// iter-356.3d: Maya iter-356.3c parallel called this "Critical: zero
// adoption of iter-356.0 tokens. Hardcoded bg-[var(--color-surface)],
// border-[var(--color-border)], text-[var(--color-text-tertiary)], rounded-2xl. iter-356.0
// shipped --color-surface, --radius-lg, --space-*, --text-* and they
// haven't reached this file." Token migration applied here unblocks
// every downstream Settings sub-section in one diff.

export function Section({
  title,
  subtitle,
  children,
}: {
  title: string
  /**
   * Optional one-line helper rendered below the title. Calm tone
   * (text-tertiary) so it sits as guidance, not as competing
   * heading weight. Used by JetsonSection's grouped panels to
   * explain WHY a cluster of rows belongs together (e.g. "What
   * the AI is seeing and processing"). All other Section
   * consumers leave this undefined and render unchanged.
   */
  subtitle?: string
  children: ReactNode
}) {
  return (
    <section>
      <h2 className="text-xs uppercase tracking-wider text-[var(--color-text-tertiary)] mb-2 px-1">
        {title}
      </h2>
      {subtitle && (
        <p className="text-xs text-[var(--color-text-tertiary)] mb-2 px-1 -mt-1">
          {subtitle}
        </p>
      )}
      <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl divide-y divide-[var(--color-border-subtle)] overflow-hidden">
        {children}
      </div>
    </section>
  )
}

export function Row({
  label,
  right,
}: {
  label: string
  right: ReactNode
}) {
  return (
    <div className="flex items-center justify-between px-4 py-3">
      <span className="text-[var(--color-text-primary)]">{label}</span>
      <div>{right}</div>
    </div>
  )
}

export function Mono({ children }: { children: ReactNode }) {
  return (
    <span className="text-[var(--color-text-secondary)] tabular-nums text-sm">
      {children}
    </span>
  )
}

// iter-244d Toggle: switched from absolute-positioned knob (manual
// translate-x-0.5 / translate-x-5) to a padded flex container after
// the iter-244d user report ("the knob escapes the pill's right
// edge during transition"). Documented in CLAUDE.md sharp edges.
// iter-356.3d: tokens applied (was bg-[var(--color-accent-default)] + bg-[var(--color-border-strong)]).
export function Toggle({
  checked,
  onChange,
  disabled,
  ariaLabel,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
  ariaLabel?: string
}) {
  return (
    <button
      type="button"
      onClick={() => !disabled && onChange(!checked)}
      disabled={disabled}
      className={`w-11 h-6 rounded-full p-0.5 flex items-center transition-colors duration-150 disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-[var(--color-accent-default)] focus-visible:outline-offset-2 ${
        checked ? 'bg-[var(--color-accent-default)]' : 'bg-[var(--color-surface-raised)]'
      }`}
      aria-pressed={checked}
      aria-label={ariaLabel}
    >
      <span
        className={`w-5 h-5 bg-white rounded-full shadow transition-transform duration-150 ${
          checked ? 'translate-x-5' : 'translate-x-0'
        }`}
      />
    </button>
  )
}

// HH:MM time input. Used by the iter-209 Schedule window block.
// iter-356.3d: tokens applied (was bg-[var(--color-surface-raised)] / border-[var(--color-border-strong)]).
export function TimeInput({
  value,
  onChange,
  disabled,
  ariaLabel,
}: {
  value: string
  onChange: (v: string) => void
  disabled?: boolean
  ariaLabel?: string
}) {
  return (
    <input
      type="time"
      value={value}
      disabled={disabled}
      onChange={(e) => {
        if (e.target.value) onChange(e.target.value)
      }}
      aria-label={ariaLabel}
      // iter-356.66 (iOS oddities sweep): time inputs at text-sm
      // (14 px after Slice-A bump) under iOS Safari's 16-px floor
      // trigger zoom-on-focus. Schedule editing on a phone reflowed
      // the whole settings page on every tap. Bumped to text-base.
      className="bg-[var(--color-surface-raised)] text-[var(--color-text-primary)] px-3 py-2 rounded-lg text-base tabular-nums border border-[var(--color-border)] focus-visible:outline-2 focus-visible:outline-[var(--color-accent-default)] focus-visible:outline-offset-2 disabled:opacity-50"
    />
  )
}

// iter-257: three discrete retention tiers. Each picks both
// retention_days AND the per-clip max length so the disk math stays
// bounded. iter-356.3d: tokens applied (was raw blue-500/15 + blue-100
// + neutral-900 + neutral-800).
export function RetentionPresetPicker({
  value,
  onChange,
  disabled,
}: {
  value: RetentionPreset
  onChange: (preset: RetentionPreset) => void
  disabled?: boolean
}) {
  const options: RetentionPreset[] = ['week', 'month', 'year_5']
  return (
    <div
      className="px-4 py-3 space-y-2"
      role="radiogroup"
      aria-label="Clip retention period"
    >
      <div className="text-sm text-[var(--color-text-primary)]">Keep clips for</div>
      <div className="grid grid-cols-3 gap-2">
        {options.map((opt) => {
          const tier = RETENTION_PRESETS[opt]
          const active = value === opt
          return (
            <button
              key={opt}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => !disabled && onChange(opt)}
              disabled={disabled}
              className={`px-3 py-3 rounded-xl border transition-colors duration-150 text-left disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-[var(--color-accent-default)] focus-visible:outline-offset-2 ${
                active
                  ? 'bg-[var(--color-accent-bg)] border-[var(--color-accent-border)] text-[var(--color-accent-bright)]'
                  : 'bg-[var(--color-surface)] border-[var(--color-border)] text-[var(--color-text-primary)] hover:border-[var(--color-border-strong)]'
              }`}
            >
              <div className="text-sm font-semibold">{tier.label}</div>
              <div className="text-[11px] text-[var(--color-text-secondary)] mt-0.5">
                {tier.description}
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}
