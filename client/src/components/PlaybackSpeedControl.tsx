import { useRef } from 'react'
import { nextRovingIndex } from '../lib/a11y'

// Playback-speed multipliers offered on recorded-video players (ClipModal +
// the timelapse reel). Native <video>.playbackRate supports these directly;
// the segmented control just sets it. Browsers cap playbackRate (Chrome ~16x),
// so 4x is safely within range. Ordered slow→fast for a sensible roving order.
export const SPEED_RATES: ReadonlyArray<number> = [
  0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 4,
]

/** Spoken name for a rate (visible label is the compact "1.5×"). Frank (the
 *  ux-grandpa persona) hears "0.5×" as "zero point five ex", so screen readers
 *  get the clearer "… times speed" / "Normal speed" instead. */
function speedAriaLabel(rate: number): string {
  if (rate === 1) return 'Normal speed'
  return `${rate} times speed`
}

type Variant = 'overlay' | 'surface'

const PILL_BASE =
  'min-w-[44px] min-h-[44px] px-2.5 rounded-full text-xs font-semibold ' +
  'tabular-nums transition-colors focus-visible:outline-2 ' +
  'focus-visible:outline-[var(--color-accent-default)] focus-visible:outline-offset-2'

// `overlay` paints over video pixels (ClipModal) — literal white/black like
// drawBoxes.ts, not theme tokens. `surface` is the light calico theme (the
// timelapse player sits on the Settings page).
const PILL_STYLES: Record<Variant, { on: string; off: string }> = {
  overlay: {
    on: 'bg-white text-black',
    off:
      'bg-white/10 text-white/85 hover:text-white active:text-white ' +
      'border border-white/15',
  },
  surface: {
    on: 'bg-[var(--color-accent-default)] text-white',
    off:
      'bg-[var(--color-surface-raised)] text-[var(--color-text-primary)] ' +
      'hover:bg-[var(--color-accent-subtle)] border border-[var(--color-border-strong)]',
  },
}

/**
 * Accessible segmented speed control (WAI-ARIA radiogroup + roving tabindex:
 * ArrowLeft/Right + Home/End move BOTH selection and focus; only the selected
 * pill is in the Tab order). Pure presentational — the parent owns the rate
 * and applies it to its <video>.playbackRate.
 */
export function PlaybackSpeedControl({
  rate,
  onRateChange,
  variant = 'surface',
  className,
}: {
  rate: number
  onRateChange: (rate: number) => void
  variant?: Variant
  className?: string
}) {
  const pillRefs = useRef<Array<HTMLButtonElement | null>>([])
  const styles = PILL_STYLES[variant]
  return (
    <div
      role="radiogroup"
      aria-label="Playback speed"
      // tabIndex=-1 satisfies jsx-a11y/interactive-supports-focus for the
      // container (which has onKeyDown). The container is NOT in the Tab
      // order; the roving-tabindex on the inner radios IS.
      tabIndex={-1}
      className={`flex flex-wrap items-center justify-center gap-1 ${className ?? ''}`}
      onKeyDown={(e) => {
        const idx = SPEED_RATES.indexOf(rate)
        if (idx === -1) return
        const next = nextRovingIndex(e.key, idx, SPEED_RATES.length)
        if (next === null) return
        e.preventDefault()
        onRateChange(SPEED_RATES[next])
        // tabIndex flips next paint before .focus() so the browser doesn't
        // refuse to focus a tabIndex=-1 element.
        requestAnimationFrame(() => {
          pillRefs.current[next]?.focus()
        })
      }}
    >
      {SPEED_RATES.map((r, idx) => (
        <button
          key={r}
          ref={(el) => {
            pillRefs.current[idx] = el
          }}
          type="button"
          role="radio"
          aria-checked={rate === r}
          aria-label={speedAriaLabel(r)}
          tabIndex={rate === r ? 0 : -1}
          onClick={() => onRateChange(r)}
          className={`${PILL_BASE} ${rate === r ? styles.on : styles.off}`}
        >
          {r}×
        </button>
      ))}
    </div>
  )
}
