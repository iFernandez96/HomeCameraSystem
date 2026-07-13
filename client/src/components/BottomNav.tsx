import { NavLink, useNavigate } from 'react-router-dom'
import { EventsIcon, LiveIcon, PeopleIcon, SettingsIcon } from './NavIcons'
import { useRipple } from '../lib/ripple'

// One stable four-destination information architecture on every device.
// Contextual tools stay where they are used: Training/Review in Faces,
// Playground on Home, and God View in Settings → Account & System.
const tabs = [
  { to: '/', label: 'Home', icon: LiveIcon },
  { to: '/events', label: 'Events', icon: EventsIcon },
  { to: '/people', label: 'Faces', icon: PeopleIcon },
  { to: '/settings', label: 'Settings', icon: SettingsIcon },
]

export function BottomNav() {
  const ripple = useRipple()
  const navigate = useNavigate()
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
      // left-anchored ones (top-0/bottom-0/left-0/w-14/rounded-[...]).
      // The landscape rail is icon-first: labels stay in the
      // accessibility tree but are visually hidden. A short camera
      // viewport should not spend prime width on nav copy.
      className="fixed bottom-0 inset-x-0 z-10 mx-3.5 mb-[calc(0.875rem+env(safe-area-inset-bottom,0px))] rounded-full border-[1.5px] border-[var(--color-border)] bg-[var(--color-surface-scrim)] backdrop-blur px-2.5 py-2 shadow-[0_10px_24px_-14px_rgb(33_31_27/0.35)] landscape-phone:top-0 landscape-phone:bottom-0 landscape-phone:left-0 landscape-phone:right-auto landscape-phone:inset-x-auto landscape-phone:mx-0 landscape-phone:mb-0 landscape-phone:my-2 landscape-phone:ml-[max(0.375rem,env(safe-area-inset-left,0px))] landscape-phone:w-12 landscape-phone:rounded-2xl landscape-phone:px-0.5 landscape-phone:py-2"
    >
      {/* Premium-launch slice (mobile-view-auditor A2): lateral
          safe-area inset on the inner tab strip in landscape. Pre-
          fix the tab distribution didn't reserve room
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
      <div className="bottomnav-inner flex landscape-phone:flex-col landscape-phone:h-full landscape-phone:justify-center landscape-phone:gap-1.5">
        {tabs.map((t) => (
          <NavLink
            key={t.to}
            to={t.to}
            replace
            onClick={(event) => {
              if (
                event.defaultPrevented ||
                event.button !== 0 ||
                event.metaKey ||
                event.altKey ||
                event.ctrlKey ||
                event.shiftKey
              ) {
                return
              }
              event.preventDefault()
              navigate(t.to, { replace: true })
            }}
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
              `relative overflow-hidden flex flex-1 landscape-phone:flex-none landscape-phone:w-full landscape-phone:min-h-11 py-1.5 flex-col items-center gap-0.5 text-xs rounded-full transition-colors focus-ring focus-visible:outline-offset-[-4px] focus-visible:rounded-full ${
                isActive
                  ? 'bg-[var(--color-ink)] text-[var(--color-on-ink)] font-semibold'
                  : 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'
              }`
            }
            onPointerDown={ripple}
          >
            {({ isActive }) => (
              <>
                <span className="flex items-center justify-center w-14 landscape-phone:w-7 h-7">
                  <t.icon active={isActive} />
                </span>
                <span className="landscape-phone:sr-only">{t.label}</span>
              </>
            )}
          </NavLink>
        ))}
      </div>
    </nav>
  )
}

// Icon glyphs live in NavIcons.tsx (shared with SideRail — one
// source, no drift). Every glyph is aria-hidden (iter-356.56 Dana
// #2) so screen readers announce only the visible label.
