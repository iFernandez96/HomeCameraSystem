import type { ReactNode } from 'react'
import { RETENTION_PRESETS, type RetentionPreset } from '../../lib/types'
import { useRipple } from '../../lib/ripple'

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
//
// Playroom Modern (redesign/playroom-modern, Task 8): Section now
// wears the shared `.card-paper` grammar Task 3 landed (flat paper,
// 1.5px hairline border, `--radius-xl` 18px) instead of a bespoke
// `rounded-2xl` + `shadow-card` recreation — this is the "rounded
// rows" surface every Settings row lives inside. Toggle's knob is
// resized to the corrected 26px track + ink-fill-when-on spec (see
// Toggle below).

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
  // redesign/warm-boutique (Sunroom): section header steps up from the
  // dark-era uppercase-tracking micro-label to the shared header tier
  // (Inter semibold 18px, ink) so Settings reads as a control room in
  // daylight, not a terminal. The card itself is paper: cream surface,
  // hairline border, warm shadow-card (light themes need the shadow —
  // L-delta alone doesn't separate paper from linen).
  return (
    <section>
      <h2 className="text-lg font-semibold text-[var(--color-text-primary)] mb-1 px-1">
        {title}
      </h2>
      {subtitle && (
        <p className="text-sm text-[var(--color-text-tertiary)] mb-2 px-1">
          {subtitle}
        </p>
      )}
      <div className="card-paper divide-y divide-[var(--color-border-subtle)] overflow-hidden mt-1">
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
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-4 py-3">
      <span className="min-w-0 break-words text-[var(--color-text-primary)]">{label}</span>
      <div className="shrink-0">{right}</div>
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
// Playroom Modern (Task 8 corrections): track grows 24px -> 26px tall
// (w-11 h-[26px]), and the "on" fill moves off the accent color onto
// --color-ink (matching the Button primary pill fill) so a toggled-on
// row reads with the same ink-fill language as a primary CTA. Off
// stays --color-border. Thumb stays a plain white circle with a soft
// shadow (unchanged visually, just re-affirmed by the brief).
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
  const ripple = useRipple()
  return (
    <button
      type="button"
      onClick={() => !disabled && onChange(!checked)}
      onPointerDown={disabled ? undefined : ripple}
      disabled={disabled}
      // Sunroom hit-area fix: the visual pill stays 44x24, but the
      // interactive element gains transparent p-2.5 padding cancelled
      // by -m-2.5, lifting the tap target to 44px tall (64px wide)
      // without visibly shifting layout.
      className="relative overflow-hidden p-2.5 -m-2.5 rounded-full flex items-center disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-[var(--color-accent-default)] focus-visible:outline-offset-2"
      aria-pressed={checked}
      aria-label={ariaLabel}
    >
      {/* Sunroom: the off-state pill needs a real border tone — the old
          surface-raised fill was near-invisible against the paper card,
          so on/off read as "orange vs nothing." */}
      <span
        className={`w-11 h-[26px] rounded-full p-0.5 flex items-center transition-colors duration-150 ${
          checked ? 'bg-[var(--color-ink)]' : 'bg-[var(--color-border)]'
        }`}
      >
        <span
          className={`w-5 h-5 bg-white rounded-full shadow-md transition-transform duration-150 ${
            checked ? 'translate-x-5' : 'translate-x-0'
          }`}
        />
      </span>
    </button>
  )
}

// HH:MM time input. Used by the iter-209 Schedule window block in
// DetectionSection AND by the NotificationsSection per-user schedule
// (iter-209 + premium-launch slice).
// iter-356.3d: tokens applied (was bg-[var(--color-surface-raised)] / border-[var(--color-border-strong)]).
//
// Premium-launch slice — accessibility extensions for the
// NotificationsSection schedule consumer:
//   - `ariaDescribedBy` ties the input to a sibling validation
//     message (the Notifications schedule alert at line ~454)
//     so SR users hear the error context when focus returns.
//   - `ariaInvalid` flips on validation failure so VO/NVDA
//     announce "invalid entry" alongside the input.
//   - `allowEmpty` lets the consumer treat empty input as a
//     value (NotificationsSection schedule semantics: empty =
//     no time gating). DetectionSection leaves this unset
//     because its schedule UI gates on a separate toggle, not
//     on emptying the time inputs.
//   - `inputMode="numeric"` so mobile NVDA / TalkBack reads the
//     field as a number entry surface, not plain text.
export function TimeInput({
  value,
  onChange,
  disabled,
  ariaLabel,
  ariaDescribedBy,
  ariaInvalid,
  allowEmpty,
}: {
  value: string
  onChange: (v: string) => void
  disabled?: boolean
  ariaLabel?: string
  ariaDescribedBy?: string
  ariaInvalid?: boolean
  /**
   * When true, an empty input triggers `onChange('')` so the
   * consumer can clear the value. Default false preserves the
   * iter-209 DetectionSection behaviour (ignore empty change
   * events; clearing is handled by a separate toggle).
   */
  allowEmpty?: boolean
}) {
  return (
    <input
      type="time"
      inputMode="numeric"
      value={value}
      disabled={disabled}
      onChange={(e) => {
        if (allowEmpty || e.target.value) onChange(e.target.value)
      }}
      aria-label={ariaLabel}
      aria-describedby={ariaDescribedBy}
      aria-invalid={ariaInvalid || undefined}
      // iter-356.66 (iOS oddities sweep): time inputs at text-sm
      // (14 px after Slice-A bump) under iOS Safari's 16-px floor
      // trigger zoom-on-focus. Schedule editing on a phone reflowed
      // the whole settings page on every tap. Bumped to text-base.
      className="bg-[var(--color-surface-raised)] text-[var(--color-text-primary)] px-3 py-2 rounded-lg text-base tabular-nums border border-[var(--color-border)] focus-visible:outline-2 focus-visible:outline-[var(--color-accent-default)] focus-visible:outline-offset-2 disabled:opacity-50 aria-[invalid=true]:border-[var(--color-danger)]"
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
              // Sunroom: accent-subtle is a LIGHT peach surface now — the
              // selected tile keeps ink text (accent-bright text on a light
              // tint was a dark-era leftover, ~3.5:1).
              className={`px-3 py-3 rounded-xl border transition-colors duration-150 text-left disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-[var(--color-accent-default)] focus-visible:outline-offset-2 ${
                active
                  ? 'bg-[var(--color-accent-subtle)] border-[var(--color-accent-border)] text-[var(--color-text-primary)]'
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
