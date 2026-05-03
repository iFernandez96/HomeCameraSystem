import { NavLink } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import { CatTrioMark } from './CatIcons'

// iter-261: desktop sidebar navigation. Replaces the BottomNav at
// `lg:` (≥1024 px) — bottom-tab navigation is a phone idiom; on a
// laptop the user expects a left rail with persistent labels +
// space for context (the username, sign-out, status indicator).
//
// Mobile (`<lg`) hides this entirely and uses BottomNav. Desktop
// hides BottomNav and shows this. Switch is media-query-driven so
// the same component tree handles both.

const tabs = [
  { to: '/live', label: 'Live', icon: LiveIcon },
  { to: '/events', label: 'Events', icon: EventsIcon },
  { to: '/people', label: 'People', icon: PeopleIcon },
  // iter-352 (face-capture-for-retraining, Phase 2): direct desktop
  // entry to /training. Mobile users reach /training via the People-
  // page header button — adding a 5th BottomNav tab would crowd the
  // ~80 px-per-button layout on small phones (375 px viewport).
  { to: '/training', label: 'Training', icon: TrainingIcon },
  { to: '/settings', label: 'Settings', icon: SettingsIcon },
]

export function SideNav() {
  const { user, logout } = useAuth()
  return (
    <nav
      aria-label="Main navigation"
      // iter-356.25: light-theme + CatTrioMark in brand row.
      // Pre-iter-356.25: bg-[var(--color-bg)] + neutral-800 border on a
      // dark theme. Post-iter-356.25: bg-[var(--color-surface)] (white)
      // + warm-tan border, lifts off the cream page bg with the
      // shadow-card token for a soft paper feel.
      className="hidden lg:flex flex-col fixed top-0 left-0 bottom-0 w-56 bg-[var(--color-surface)] border-r border-[var(--color-border)] px-3 py-6 z-10 shadow-[var(--shadow-card)]"
    >
      <div className="px-3 mb-6">
        {/* iter-356.28: CatTrioMark sized for legibility. Pre-iter-356.28
            it was inline with the wordmark at size=28 — 28×9px renders
            each 16-px-grid cat face at ~9px wide, below the threshold
            where the pixel-art reads as cats (browser-harness audit
            against the live tailnet PWA showed three indistinct smudges).
            Now stacked above the wordmark at size=72 (72×24, ~24px per
            face), matching the Login card's hero treatment but smaller. */}
        <CatTrioMark size={72} ariaLabel="Home Camera" className="mb-3" />
        <div>
          <div className="text-lg font-semibold text-[var(--color-text-primary)] leading-none">
            Home Camera
          </div>
          {user ? (
            <div className="text-xs text-[var(--color-text-tertiary)] mt-1">
              Signed in as{' '}
              <span className="text-[var(--color-text-secondary)] font-medium">
                {user.username}
              </span>
            </div>
          ) : null}
        </div>
      </div>
      <div className="flex flex-col gap-1 flex-1">
        {tabs.map((t) => (
          <NavLink
            key={t.to}
            to={t.to}
            className={({ isActive }) =>
              // iter-356.25: tokenized colors + paw-print indicator
              // bullet on the active tab. Active = warm cream surface
              // + accent-default text + ::before paw print rendered
              // via background-image on a 6px ::before pseudo. The
              // 'paw-active' class is defined in index.css.
              `relative flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors focus-ring ${
                isActive
                  ? 'paw-active bg-[var(--color-accent-subtle)] text-[var(--color-accent-default)]'
                  : 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-surface-raised)]'
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
      {user ? (
        <button
          type="button"
          onClick={logout}
          className="mt-3 px-3 py-2 text-sm text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-surface-raised)] rounded-lg text-left transition-colors focus-ring"
        >
          Sign out
        </button>
      ) : null}
    </nav>
  )
}

function LiveIcon({ active }: { active: boolean }) {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M23 7l-7 5 7 5V7z" />
      <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
      {active && <circle cx="5" cy="9" r="1.5" fill="#ef4444" stroke="none" />}
    </svg>
  )
}

function EventsIcon({ active: _active }: { active: boolean }) {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  )
}

function TrainingIcon({ active: _active }: { active: boolean }) {
  // iter-352: graduation-cap-ish glyph reads as "learn / train"
  // without leaning on text labels. 20×20 to match the rest.
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M22 10L12 5 2 10l10 5 10-5z" />
      <path d="M6 12v5a3 3 0 0 0 3 3h6a3 3 0 0 0 3-3v-5" />
    </svg>
  )
}

function PeopleIcon({ active: _active }: { active: boolean }) {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  )
}

function SettingsIcon({ active: _active }: { active: boolean }) {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  )
}
