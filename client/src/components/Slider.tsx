import type { ChangeEvent, KeyboardEvent, PointerEvent } from 'react'

type SliderProps = {
  label: string
  value: number
  min: number
  max: number
  step: number
  /** Format the value for display next to the label. Default: `String(v)`. */
  format?: (v: number) => string
  /** Fires every time the input value changes (drag, key, click). */
  onChange: (v: number) => void
  /**
   * Fires when the user *finishes* interacting — pointer up, touch end, or
   * key release. Use for debouncing network writes so we don't PATCH on
   * every drag step.
   */
  onCommit?: (v: number) => void
  disabled?: boolean
  /** Override the accessible name. Defaults to `label`. */
  ariaLabel?: string
}

const COMMIT_KEYS = new Set([
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
  'Home',
  'End',
  'PageUp',
  'PageDown',
])

export function Slider({
  label,
  value,
  min,
  max,
  step,
  format = String,
  onChange,
  onCommit,
  disabled,
  ariaLabel,
}: SliderProps) {
  const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
    onChange(parseFloat(e.target.value))
  }

  const commit = (target: HTMLInputElement) => {
    if (onCommit) onCommit(parseFloat(target.value))
  }

  const handlePointerUp = (e: PointerEvent<HTMLInputElement>) => {
    commit(e.currentTarget)
  }

  const handleKeyUp = (e: KeyboardEvent<HTMLInputElement>) => {
    if (COMMIT_KEYS.has(e.key)) commit(e.currentTarget)
  }

  return (
    <div className="px-4 py-3">
      <div className="flex justify-between items-center mb-2">
        <label className="text-[var(--color-text-primary)] text-sm">{label}</label>
        <span className="text-[var(--color-text-secondary)] tabular-nums text-sm">{format(value)}</span>
      </div>
      <input
        type="range"
        value={value}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        onChange={handleChange}
        onPointerUp={handlePointerUp}
        onKeyUp={handleKeyUp}
        aria-label={ariaLabel ?? label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        className="slider w-full"
      />
    </div>
  )
}
