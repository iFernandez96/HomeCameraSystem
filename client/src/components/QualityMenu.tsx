import { useEffect, useRef, useState } from 'react'
import { useRipple } from '../lib/ripple'
import type { StreamQuality } from '../lib/streamQuality'

/**
 * QualityMenu — themed replacement for the native `<select>` stream-
 * quality picker (fuzz F6, real device SM-S928U1: the native popup's
 * Samsung purple radio buttons clash hard with the Playroom dark
 * over-video chrome and can't be restyled at all).
 *
 * The ORIGINAL comment on the native `<select>` said it was chosen
 * "so it's keyboard-operable, reachable by accessible name, and
 * announces the current tier without any custom ARIA." This
 * component keeps every one of those properties by hand instead of
 * getting them for free from the UA: a real `<button>` trigger
 * (`aria-haspopup="listbox"`, `aria-expanded`) opens a `role="listbox"`
 * popover of `role="option"` rows, with full arrow-key navigation,
 * Enter/Space to select, Escape to close + return focus, and
 * click-outside to dismiss. Nothing about keyboard operability is
 * lost — only the unstyleable native popup is gone.
 */
export const QUALITY_OPTIONS: ReadonlyArray<{
  value: StreamQuality
  label: string
  subtitle: string
}> = [
  { value: 'auto', label: 'Auto', subtitle: 'Adjusts to your connection' },
  { value: 'hq', label: 'HQ', subtitle: 'Sharpest picture, most data' },
  {
    value: 'sd',
    label: 'Data-saver',
    subtitle: 'Good picture, about a quarter of the data',
  },
  { value: 'xs', label: 'Ultra-low', subtitle: 'Rough picture, works on weak signal' },
]

export function QualityMenu({
  quality,
  onSelect,
}: {
  quality: StreamQuality
  onSelect: (q: StreamQuality) => void
}) {
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(() =>
    Math.max(0, QUALITY_OPTIONS.findIndex((o) => o.value === quality)),
  )
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const listRef = useRef<HTMLUListElement | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const ripple = useRipple()

  const currentLabel =
    QUALITY_OPTIONS.find((o) => o.value === quality)?.label ?? 'Auto'

  const close = (returnFocus: boolean) => {
    setOpen(false)
    if (returnFocus) triggerRef.current?.focus()
  }

  const commit = (index: number) => {
    const opt = QUALITY_OPTIONS[index]
    if (!opt) return
    onSelect(opt.value)
    close(true)
  }

  // Open the popover, re-syncing the highlighted row to the current
  // value so arrow navigation starts from "where we are". Computed at
  // the two call sites (trigger click, trigger ArrowDown/Enter/Space)
  // instead of an effect keyed on `open` — react-hooks/set-state-in-
  // effect flags synchronous setState-in-effect as cascading-render
  // risk; deriving it at the event that opens the menu avoids the
  // extra render entirely.
  const openMenu = () => {
    setActiveIndex(Math.max(0, QUALITY_OPTIONS.findIndex((o) => o.value === quality)))
    setOpen(true)
  }
  const toggleMenu = () => {
    if (open) close(false)
    else openMenu()
  }

  // Click-outside dismiss.
  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        close(false)
      }
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open])

  // Focus the active option whenever the popover is open and the
  // highlighted index changes, so arrow-key nav is visibly tracked.
  useEffect(() => {
    if (!open) return
    const el = listRef.current?.querySelector<HTMLElement>(
      `[data-option-index="${activeIndex}"]`,
    )
    el?.focus()
  }, [open, activeIndex])

  const onTriggerKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      openMenu()
    }
  }

  const onListKeyDown = (e: React.KeyboardEvent<HTMLUListElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIndex((i) => Math.min(QUALITY_OPTIONS.length - 1, i + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIndex((i) => Math.max(0, i - 1))
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      commit(activeIndex)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      close(true)
    } else if (e.key === 'Tab') {
      close(false)
    }
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Stream quality"
        onClick={toggleMenu}
        onKeyDown={onTriggerKeyDown}
        onPointerDown={ripple}
        className="relative overflow-hidden flex items-center gap-1.5 bg-black/60 backdrop-blur ring-1 ring-white/20 px-2 py-1 rounded-full text-xs font-medium text-white focus-visible:outline-2 focus-visible:outline-[var(--color-accent-bright)] focus-visible:outline-offset-2"
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          {/* signal-bars glyph */}
          <line x1="6" y1="20" x2="6" y2="14" />
          <line x1="12" y1="20" x2="12" y2="9" />
          <line x1="18" y1="20" x2="18" y2="4" />
        </svg>
        {currentLabel}
      </button>
      {open && (
        <ul
          ref={listRef}
          role="listbox"
          aria-label="Stream quality options"
          tabIndex={-1}
          onKeyDown={onListKeyDown}
          className="absolute bottom-full left-0 mb-2 min-w-[9.5rem] bg-black/85 backdrop-blur rounded-[18px] ring-1 ring-white/15 p-1.5 shadow-[var(--shadow-overlay)] z-10"
        >
          {QUALITY_OPTIONS.map((o, i) => {
            const selected = o.value === quality
            return (
              // Keyboard operability is handled by the parent <ul>'s
              // onKeyDown (the standard ARIA listbox roving-tabindex
              // pattern — arrow keys move `activeIndex`, Enter/Space
              // there call the same `commit`); a per-option keydown
              // handler would just double-fire it via bubbling.
              // eslint-disable-next-line jsx-a11y/click-events-have-key-events
              <li
                key={o.value}
                role="option"
                aria-selected={selected}
                data-option-index={i}
                tabIndex={i === activeIndex ? 0 : -1}
                onClick={() => commit(i)}
                onMouseEnter={() => setActiveIndex(i)}
                className={`flex items-center justify-between gap-3 px-3 py-2 rounded-xl cursor-pointer outline-none focus-visible:outline-2 focus-visible:outline-[var(--color-accent-bright)] focus-visible:outline-offset-2 ${
                  selected
                    ? 'bg-[var(--color-accent-deep)] text-white'
                    : 'text-white/85 hover:bg-white/10'
                }`}
              >
                <span className="flex flex-col gap-0.5">
                  <span className="text-xs font-medium">{o.label}</span>
                  {/* Painfix wave B #4: one-line subtitle so a non-technical
                      user understands the tradeoff without guessing what
                      "HQ" vs "Data-saver" costs them. Listbox semantics are
                      unaffected — this is still one `role="option"` row;
                      the accessible name (option text content) now reads
                      "Auto Adjusts to your connection" etc., which is still
                      unambiguous. The trigger's aria-label stays the short
                      "Stream quality" so the closed-state control isn't
                      chatty. */}
                  <span
                    className={`text-[11px] font-normal ${
                      selected ? 'text-white/85' : 'text-white/55'
                    }`}
                  >
                    {o.subtitle}
                  </span>
                </span>
                {selected && (
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                    className="flex-shrink-0"
                  >
                    <path d="M20 6 9 17l-5-5" />
                  </svg>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
