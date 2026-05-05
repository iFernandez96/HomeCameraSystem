import { NavLink } from 'react-router-dom'

const tabs = [
  { to: '/live', label: 'Live', icon: LiveIcon },
  { to: '/events', label: 'Events', icon: EventsIcon },
  { to: '/people', label: 'People', icon: PeopleIcon },
  { to: '/settings', label: 'Settings', icon: SettingsIcon },
]

export function BottomNav() {
  return (
    <nav
      aria-label="Bottom navigation"
      // iter-356.25 (light theme): white surface + warm-tan top border.
      // 95% opacity backdrop-blur for glass-on-cream effect against
      // the page bg as the user scrolls content under it.
      className="fixed bottom-0 inset-x-0 bg-[var(--color-surface)]/95 backdrop-blur border-t border-[var(--color-border)] pb-[env(safe-area-inset-bottom)] z-10 shadow-[var(--shadow-card)]"
    >
      <div className="flex">
        {tabs.map((t) => (
          <NavLink
            key={t.to}
            to={t.to}
            // iter-356.25: tokenized color + the bottom-paw indicator
            // appears under the active tab via .bottomnav-paw-active.
            // Inactive = warm tertiary; active = calico orange accent.
            className={({ isActive }) =>
              `relative flex-1 py-3 flex flex-col items-center gap-1 text-xs transition-colors focus-ring focus-visible:outline-offset-[-4px] focus-visible:rounded ${
                isActive
                  ? 'bottomnav-paw-active text-[var(--color-accent-default)] font-semibold'
                  : 'text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)]'
              }`
            }
          >
            {({ isActive }) => (
              <>
                <t.icon active={isActive} />
                <span>{t.label}</span>
              </>
            )}
          </NavLink>
        ))}
      </div>
    </nav>
  )
}

// iter-356.56 (Dana #2): every icon SVG carries `aria-hidden="true"`
// so VoiceOver swipe doesn't land on a "graphic" node before reaching
// the visible label. SideNav already has this (iter-261); BottomNav
// was left out and screen-reader users got a double-announcement on
// every nav item.
function LiveIcon({ active }: { active: boolean }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M23 7l-7 5 7 5V7z" />
      <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
      {active && <circle cx="5" cy="9" r="1.5" fill="var(--color-danger)" stroke="none" />}
    </svg>
  )
}

function EventsIcon({ active: _active }: { active: boolean }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  )
}

function PeopleIcon({ active: _active }: { active: boolean }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  )
}

function SettingsIcon({ active: _active }: { active: boolean }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  )
}
