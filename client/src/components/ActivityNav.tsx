import { NavLink } from 'react-router-dom'

const items = [
  { to: '/events', label: 'Activity', end: true },
  { to: '/events/search', label: 'Find', end: false },
  { to: '/events/saved', label: 'Saved', end: false },
]

export function ActivityNav() {
  return (
    <nav aria-label="Activity sections" className="flex gap-1 overflow-x-auto rounded-full border-[1.5px] border-[var(--color-border)] bg-[var(--color-surface)] p-1">
      {items.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.end}
          className={({ isActive }) => `inline-flex min-h-10 flex-1 items-center justify-center whitespace-nowrap rounded-full px-4 text-sm font-semibold transition-colors ${isActive ? 'bg-[var(--color-ink)] text-[var(--color-on-ink)]' : 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'}`}
        >
          {item.label}
        </NavLink>
      ))}
    </nav>
  )
}
