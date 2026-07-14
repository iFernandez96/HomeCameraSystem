import type { EventListViewMode } from './EventList'

const STORAGE_KEY = 'homecam:eventsViewMode'
const MODES: Array<{ id: EventListViewMode; label: string }> = [
  { id: 'timeline', label: 'Timeline' },
  { id: 'thumbs', label: 'Thumbs' },
  { id: 'compact', label: 'Compact' },
]

function isViewMode(value: string | null): value is EventListViewMode {
  return value === 'timeline' || value === 'thumbs' || value === 'compact'
}

export function readEventsViewMode(): EventListViewMode {
  if (typeof window === 'undefined') return 'timeline'
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY)
    return isViewMode(stored) ? stored : 'timeline'
  } catch {
    return 'timeline'
  }
}

export function rememberEventsViewMode(mode: EventListViewMode) {
  try {
    window.localStorage.setItem(STORAGE_KEY, mode)
  } catch {
    // Best-effort; mode selection still works for the current tab.
  }
}

export function EventsViewSwitcher({ mode, onChange }: { mode: EventListViewMode; onChange: (mode: EventListViewMode) => void }) {
  return (
    <div role="group" aria-label="Event list view" className="flex rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-muted)] p-0.5">
      {MODES.map((option) => {
        const active = mode === option.id
        return (
          <button key={option.id} type="button" aria-pressed={active} onClick={() => onChange(option.id)} className={`min-h-9 rounded-[var(--radius-sm)] px-2.5 text-[11px] font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-[var(--color-accent-default)] focus-visible:outline-offset-2 sm:px-3 ${active ? 'bg-[var(--color-surface)] text-[var(--color-text-primary)] shadow-[0_1px_2px_rgba(15,23,42,0.08)]' : 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'}`}>
            {option.label}
          </button>
        )
      })}
    </div>
  )
}
