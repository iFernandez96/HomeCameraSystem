import { NavLink } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import { useRipple } from '../lib/ripple'

/**
 * iter-356.58 (layout rebuild) — SideRail replaces SideNav.
 *
 * Structural change: the iter-356.25 SideNav was a 224px (`w-56`)
 * sidebar with stacked icon+label rows + brand cluster + sign-out.
 * That shape is THE generic-SaaS tell ("Notion / Linear / Stripe
 * left rail"). The SideRail is a slim 64px icon-only rail that
 * never expands. The brand row moves to the WatchRibbon (which
 * sits above this rail). The username/sign-out moves to the
 * bottom of the rail as icons.
 *
 * Design: 5 nav-items as 48px-tall icon buttons centered in the
 * 64px rail. Active state = ember-on-rail-bg ring + tooltip-style
 * label that shows on hover. Bottom: sign-out icon. The rail is
 * `lg:fixed top-14` (below the 56px WatchRibbon) so the ribbon
 * spans full width and the rail starts beneath it.
 *
 * Why 64px: it's narrow enough to feel like a console (not a
 * SaaS sidebar) but wide enough for a 24px icon + 8px hit-margin
 * on each side. Hover-expansion was considered + rejected — it
 * adds animation cost and is a generic-pattern tell ("Notion-style
 * rail"). We commit to icons-only-always.
 *
 * Mobile: hidden entirely. BottomNav covers mobile nav.
 */

type NavItem = {
  to: string
  label: string
  icon: (active: boolean) => React.ReactNode
}

// iter-356.x (Frank P3-6): Training back on the rail. Pre-fix it was
// only reachable via the People page header link, which non-technical
// users routinely missed; the active-learning loop and Review queue
// were effectively invisible. Adding it as a peer entry surfaces the
// loop on both desktop rail and mobile BottomNav (matching change in
// BottomNav.tsx). The iter-356.65 IA collapse traded discoverability
// for visual quietness — that trade is reversed.
//
// Playroom Modern (Task 4): relabeled to match the pebble BottomNav's
// vocabulary — Home (was Watch), Events (was History), Faces (was
// People), Review (was Training). Routes are unchanged.
//
// Nav-coherence fix (painfix): the "Review" item routed to /training
// (the raw capture browser), which doesn't match what the label
// promises — a review QUEUE of only the captures the classifier is
// uncertain about. /training/review (Review.tsx, shipped iter-356.12)
// is that queue. Label stays "Review"; only the destination moves.
const NAV_ITEMS: NavItem[] = [
  { to: '/',                label: 'Home',     icon: (a) => <LiveIcon active={a} /> },
  { to: '/events',          label: 'Events',   icon: () => <EventsIcon /> },
  { to: '/people',          label: 'Faces',    icon: () => <PeopleIcon /> },
  { to: '/training/review', label: 'Review',   icon: () => <TrainingIcon /> },
  { to: '/settings',        label: 'Settings', icon: () => <SettingsIcon /> },
]

export function SideRail() {
  const { user, logout } = useAuth()
  const ripple = useRipple()
  return (
    <nav
      aria-label="Main navigation"
      className="hidden lg:flex flex-col fixed top-14 left-0 bottom-0 w-16 bg-[var(--color-surface)] border-r border-[var(--color-border-subtle)] z-10 shadow-[var(--shadow-subtle)]"
    >
      <ul className="flex-1 flex flex-col items-center gap-1 pt-4">
        {NAV_ITEMS.map((t) => (
          <li key={t.to} className="w-full flex justify-center">
            <NavLink
              to={t.to}
              end={t.to === '/'}
              className={({ isActive }) =>
                // Playroom Modern (Task 4): same active grammar as the
                // BottomNav pebble bar, vertically — an ink-filled pill
                // (bg-[var(--color-ink)] + on-ink text/icon) instead of the
                // old accent-subtle bg + ring treatment.
                `group relative flex items-center justify-center w-12 h-12 rounded-full transition-colors focus-visible:outline-2 focus-visible:outline-[var(--color-accent-default)] focus-visible:outline-offset-2 ${
                  isActive
                    ? 'bg-[var(--color-ink)] text-[var(--color-on-ink)]'
                    : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-text-primary)]'
                }`
              }
              aria-label={t.label}
              title={t.label}
              onPointerDown={ripple}
            >
              {({ isActive }) => (
                <>
                  {/* Ripple host: the tooltip flyout sits OUTSIDE this
                      item (left-full), so overflow-hidden can't live on
                      the NavLink — the press ripple clips to this inset
                      overlay instead (see lib/ripple.ts). */}
                  <span
                    aria-hidden="true"
                    data-ripple-host
                    className="pointer-events-none absolute inset-0 rounded-full overflow-hidden"
                  />
                  {t.icon(isActive)}
                  {/* iter-356.58 — tooltip flyout. Renders only on
                      hover/focus to the right of the icon. Pointer-
                      events-none so it never intercepts clicks. */}
                  <span
                    aria-hidden="true"
                    className="pointer-events-none absolute left-full ml-2 px-2 py-1 rounded-md text-xs font-medium bg-[var(--color-surface-raised)] border border-[var(--color-border)] text-[var(--color-text-primary)] opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 transition-opacity whitespace-nowrap"
                  >
                    {t.label}
                  </span>
                </>
              )}
            </NavLink>
          </li>
        ))}
      </ul>
      {user ? (
        <div className="pb-4 flex flex-col items-center gap-2">
          <div
            aria-label={`Signed in as ${user.username}`}
            title={`Signed in as ${user.username}`}
            // redesign/warm-boutique: brass avatar chip sits on the
            // pre-mixed --color-brass-subtle paper (the old `/15`
            // opacity modifier on a var() bg is the unreliable
            // Tailwind v4 pattern — iter-356.14 lesson). Border uses
            // the strong warm-tan border token, no opacity modifier.
            className="w-9 h-9 rounded-full flex items-center justify-center bg-[var(--color-brass-subtle)] text-[var(--color-brass-default)] text-xs font-bold uppercase border border-[var(--color-border-strong)]"
          >
            {user.username.slice(0, 1)}
          </div>
          <button
            type="button"
            onClick={logout}
            aria-label="Sign out"
            title="Sign out"
            onPointerDown={ripple}
            className="group relative flex items-center justify-center w-12 h-12 rounded-xl text-[var(--color-text-secondary)] hover:bg-[var(--color-danger-bg)] hover:text-[var(--color-danger)] focus-visible:outline-2 focus-visible:outline-[var(--color-danger)] focus-visible:outline-offset-2 transition-colors"
          >
            <span
              aria-hidden="true"
              data-ripple-host
              className="pointer-events-none absolute inset-0 rounded-xl overflow-hidden"
            />
            <SignOutIcon />
            <span
              aria-hidden="true"
              className="pointer-events-none absolute left-full ml-2 px-2 py-1 rounded-md text-xs font-medium bg-[var(--color-surface-raised)] border border-[var(--color-border)] text-[var(--color-text-primary)] opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 transition-opacity whitespace-nowrap"
            >
              Sign out
            </span>
          </button>
        </div>
      ) : null}
    </nav>
  )
}

function LiveIcon({ active }: { active: boolean }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M23 7l-7 5 7 5V7z" />
      <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
      {active && <circle cx="5" cy="9" r="1.5" fill="var(--color-danger)" stroke="none" />}
    </svg>
  )
}
function EventsIcon() {
  // Activity-pulse glyph (warm-boutique redesign): the old clock face
  // read as "history/time", not "activity". Matches BottomNav's Events
  // glyph — keep the two in sync.
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
    </svg>
  )
}
function PeopleIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  )
}
function TrainingIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2 10l10-5 10 5-10 5-10-5z" />
      <path d="M6 12v5c0 1.5 3 3 6 3s6-1.5 6-3v-5" />
    </svg>
  )
}
function SettingsIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  )
}
function SignOutIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <polyline points="16 17 21 12 16 7" />
      <line x1="21" y1="12" x2="9" y2="12" />
    </svg>
  )
}
