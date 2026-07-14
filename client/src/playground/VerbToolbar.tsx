import type { ReactElement } from 'react'
import type { PlaygroundVerb } from './playgroundTypes'

// Playground Slice C — the verb toolbar. Pill buttons per the Playroom
// Modern control grammar: 1.5px hairline borders, rounded-full, ink
// fill + on-ink text for the active pill (never text-white on ink —
// on-ink inverts with the theme). Petting needs no mode, so there is
// no fifth pill. Tapping the active verb deselects it (back to bare
// pointer). Icons follow the NavIcons stroke grammar (24 viewBox,
// strokeWidth 2, round caps, aria-hidden) — the button text owns the
// accessible name.

function LaserIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="3" fill="currentColor" stroke="none" />
      <path d="M12 2v4" />
      <path d="M12 18v4" />
      <path d="M2 12h4" />
      <path d="M18 12h4" />
    </svg>
  )
}

function YarnIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="8" />
      <path d="M5 9c4 1 10 1 14 0" />
      <path d="M5 15c4-1 10-1 14 0" />
    </svg>
  )
}

function TreatIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 12c3-5 13-5 16 0" />
      <path d="M4 12c3 5 13 5 16 0" />
      <path d="M20 12l2-3" />
      <path d="M20 12l2 3" />
      <circle cx="9" cy="12" r="0.5" fill="currentColor" stroke="none" />
    </svg>
  )
}

function WandIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 20L16 8" />
      <path d="M18 3l1 2 2 1-2 1-1 2-1-2-2-1 2-1 1-2z" />
    </svg>
  )
}

const VERBS: ReadonlyArray<{
  verb: PlaygroundVerb
  label: string
  Icon: () => ReactElement
}> = [
  { verb: 'laser', label: 'Laser', Icon: LaserIcon },
  { verb: 'yarn', label: 'Yarn', Icon: YarnIcon },
  { verb: 'treat', label: 'Treat', Icon: TreatIcon },
  { verb: 'wand', label: 'Wand', Icon: WandIcon },
]

export function VerbToolbar(props: {
  activeVerb: PlaygroundVerb | null
  onSelect: (verb: PlaygroundVerb | null) => void
}) {
  const { activeVerb, onSelect } = props
  return (
    <div
      role="group"
      aria-label="Toys"
      className="flex flex-wrap items-center gap-1.5"
    >
      {VERBS.map(({ verb, label, Icon }) => {
        const active = activeVerb === verb
        return (
          <button
            key={verb}
            type="button"
            aria-pressed={active}
            onClick={() => onSelect(active ? null : verb)}
            className={`inline-flex min-h-9 items-center gap-1.5 rounded-full border-[1.5px] px-3 text-sm font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-[var(--color-accent-default)] focus-visible:outline-offset-2 ${
              active
                ? 'border-[var(--color-ink)] bg-[var(--color-ink)] text-[var(--color-on-ink)]'
                : 'border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-primary)] hover:border-[var(--color-text-tertiary)]'
            }`}
          >
            <Icon />
            {label}
          </button>
        )
      })}
    </div>
  )
}
