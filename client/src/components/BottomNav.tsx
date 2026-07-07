import { NavLink } from 'react-router-dom'
import { useRipple } from '../lib/ripple'

// iter-356.x (Frank P3-6): pre-fix Training and Review queue were
// only reachable via the People page header link, which non-technical
// users routinely missed. Adding Training as a peer BottomNav entry
// surfaces the active-learning loop on mobile. 5 tabs at 390px ≈ 78px
// each — comfortable for the 22px icons plus a single short label.
// Structural overhaul (2026-07-02): four tabs. Watch (the new home:
// live + today) replaces Live; Events reads as History; Training
// moved off the bar — it lives one tap inside People (its header
// link), which matches how often a family member actually visits it.
//
// Playroom Modern (Task 4): relabeled for the pebble bar — Home
// (was Watch), Events (was History), Faces (was People). Routes are
// unchanged; only the accessible names/visible copy moved.
//
// Nav-coherence fix (painfix, nav parity): the desktop SideRail has
// room for 5 items (Home/Events/Faces/Review/Settings); the portrait
// pebble bar deliberately stays at 4 (Review is one tap inside Faces
// instead, per iter-356.x Frank feedback on bar density). But the
// landscape-phone left-rail dock has the same vertical room as the
// desktop rail, so parity was broken there specifically — Review was
// reachable on desktop and portrait-via-Faces, but invisible in the
// landscape-phone dock. `landscapeOnly` items render `hidden` by
// default and `landscape-phone:flex` only in that dock; the portrait
// pebble bar (no `landscape-phone:` match) never shows them.
const tabs = [
  { to: '/', label: 'Home', icon: LiveIcon },
  { to: '/events', label: 'Events', icon: EventsIcon },
  { to: '/people', label: 'Faces', icon: PeopleIcon },
  { to: '/training/review', label: 'Review', icon: TrainingIcon, landscapeOnly: true },
  { to: '/settings', label: 'Settings', icon: SettingsIcon },
]

export function BottomNav() {
  const ripple = useRipple()
  return (
    <nav
      aria-label="Bottom navigation"
      // iter-356.25 (light theme): white surface + warm-tan top border.
      // 95% opacity backdrop-blur for glass-on-cream effect against
      // the page bg as the user scrolls content under it.
      //
      // iter-356.66 (real-device user feedback "on iOS the bottom is
      // too lifted") established the safe-area contract: the nav must
      // clear the iOS home-indicator gesture zone (env(safe-area-
      // inset-bottom) ≈ 34 px on a notched iPhone) without wasting
      // the whole inset as empty band.
      //
      // Playroom Modern (Task 4): the bar becomes a floating "pebble"
      // — off the screen edges on all sides (mx-3.5/mb-3.5) instead
      // of a full-bleed edge-anchored strip. The old `pb-[...]`
      // (padding pushing content up from an edge-anchored bg) is
      // replaced by folding the safe-area inset directly into the
      // bottom margin: `calc(0.875rem + env(...))` — 0.875rem (14px,
      // the mb-3.5 base clearance) PLUS whatever inset the device
      // reports. On Android (inset 0) this collapses to exactly the
      // 14px spec clearance; on a notched iPhone it lifts the whole
      // pill further above the home-indicator strip.
      // Fix 9 (clearance verification): this pill's real footprint —
      // mb-3.5 (14px) + border (3px) + py-2 (16px) + NavLink's
      // py-1.5 (12px) + icon h-7 (28px) + gap-0.5 (2px) + the
      // text-xs label line (~15px) — is ~90px, not the 76px a naive
      // "5rem + strip" estimate suggests. App.tsx's <main> pb was
      // bumped 5rem->6rem (96px) to keep ~6px of breathing room
      // above this pill instead of a ~10px overlap. Keep both
      // comments in sync if this bar's classes change.
      // Landscape pass: real-device screenshots (Galaxy S24 Ultra,
      // ~980px CSS width in landscape — below `lg:`) showed this
      // floating pebble rendering mid-viewport ON TOP of the video
      // card / filter chips, since the portrait bottom-bar layout
      // doesn't reflow for short-wide screens. `landscape-phone:`
      // docks it as a compact LEFT RAIL instead — same grammar as the
      // desktop SideRail (vertical icon stack, edge-anchored, content
      // never sits under it). Overridden dimensions: bottom-anchored
      // classes (inset-x-0/mx-3.5/mb-[...]/rounded-full) give way to
      // left-anchored ones (top-0/bottom-0/left-0/w-16/rounded-[...]).
      className="fixed bottom-0 inset-x-0 z-10 mx-3.5 mb-[calc(0.875rem+env(safe-area-inset-bottom,0px))] rounded-full border-[1.5px] border-[var(--color-border)] bg-[var(--color-surface-scrim)] backdrop-blur px-2.5 py-2 shadow-[0_10px_24px_-14px_rgb(33_31_27/0.35)] landscape-phone:top-0 landscape-phone:bottom-0 landscape-phone:left-0 landscape-phone:right-auto landscape-phone:inset-x-auto landscape-phone:mx-0 landscape-phone:mb-0 landscape-phone:my-3 landscape-phone:ml-[max(0.75rem,env(safe-area-inset-left,0px))] landscape-phone:w-16 landscape-phone:rounded-[1.75rem] landscape-phone:px-1.5 landscape-phone:py-3"
    >
      {/* Premium-launch slice (mobile-view-auditor A2): lateral
          safe-area inset on the inner tab strip in landscape. Pre-
          fix the 5-tab `flex-1` distribution didn't reserve room
          for the iPhone Dynamic Island (~47 px left) or the home-
          indicator strip (~21 px right) in landscape PWA standalone.
          The leftmost "Live" tab's icon + label sat partially behind
          the Dynamic Island; the rightmost "Settings" tab partially
          under the home indicator. Padding the INNER flex (not the
          outer `<nav>`, which is `inset-x-0` so the surface still
          fills the viewport edge-to-edge) keeps the visual bg
          extending under the safe-area while constraining tap
          targets to the safe inner band. Android (zero insets) is
          unchanged. */}
      <div
        className="flex landscape-phone:flex-col landscape-phone:h-full landscape-phone:justify-center landscape-phone:gap-1"
        style={{
          // `max(0px, env(...))` instead of bare `env(...)` so jsdom's
          // CSSStyleDeclaration accepts the value (it parses `max(...)`
          // expressions but silently rejects bare `env()` shorthands
          // when set via the React style prop). Functionally identical
          // on browsers — `env(safe-area-inset-left, 0px)` resolves to
          // 0 on devices without the inset, so `max(0px, 0)` = 0; on
          // devices with the inset, `max(0px, 47px)` = 47px.
          paddingLeft: 'max(0px, env(safe-area-inset-left))',
          paddingRight: 'max(0px, env(safe-area-inset-right))',
        }}
      >
        {tabs.map((t) => (
          <NavLink
            key={t.to}
            to={t.to}
            // `end` on the home tab — without it NavLink treats '/'
            // as a prefix of every route and Watch would always
            // render active.
            end={t.to === '/'}
            // Playroom Modern (Task 4): the paw-mask active treatment
            // (.bottomnav-paw-active) is retired in favor of an
            // ink-filled pill — the whole tab tile fills solid ink
            // with on-ink text/icon when active, matching the pebble
            // bar's rounded-full language. overflow-hidden still
            // contains the press ripple.
            className={({ isActive }) =>
              `relative overflow-hidden flex-1 landscape-phone:flex-none landscape-phone:w-full py-1.5 ${
                t.landscapeOnly ? 'hidden landscape-phone:flex' : 'flex'
              } flex-col items-center gap-0.5 text-xs landscape-phone:text-[9px] rounded-full transition-colors focus-ring focus-visible:outline-offset-[-4px] focus-visible:rounded-full ${
                isActive
                  ? 'bg-[var(--color-ink)] text-[var(--color-on-ink)] font-semibold'
                  : 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'
              }`
            }
            onPointerDown={ripple}
          >
            {({ isActive }) => (
              <>
                <span className="flex items-center justify-center w-14 landscape-phone:w-8 h-7">
                  <t.icon active={isActive} />
                </span>
                <span className="landscape-phone:leading-tight landscape-phone:text-center">{t.label}</span>
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
  // Activity-pulse glyph (warm-boutique redesign): the old clock face
  // read as "history/time", not "activity". Matches SideRail's Events
  // glyph — keep the two in sync.
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
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


// Nav-coherence fix (painfix): matches SideRail's TrainingIcon glyph —
// keep the two in sync.
function TrainingIcon({ active: _active }: { active: boolean }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2 10l10-5 10 5-10 5-10-5z" />
      <path d="M6 12v5c0 1.5 3 3 6 3s6-1.5 6-3v-5" />
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
