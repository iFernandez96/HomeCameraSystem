import { NavLink } from 'react-router-dom'
import { EventsIcon, GodViewIcon, LiveIcon, PeopleIcon, SettingsIcon } from './NavIcons'
import { useRipple } from '../lib/ripple'
import { useAuth } from '../lib/auth'
import { isGodModeUser } from '../lib/roles'

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
// UI/UX overhaul 2026-07-07 (NAV-1): the previous nav-coherence fix
// added a `landscapeOnly` Review entry that showed ONLY in the
// landscape-phone left-rail dock. The live device run-through found
// the opposite bug: rotating the phone now CHANGED the app's
// information architecture — 4 destinations in portrait, 5 in
// landscape — which is disorienting on rotate. Orientation must not
// change IA. Phone (portrait AND landscape) exposes the same 4
// destinations; Review is one tap inside Faces (the People page
// header link). The desktop SideRail keeps its 5-item roster — a
// cross-DEVICE difference is acceptable, a cross-ORIENTATION one
// is not.
const tabs = [
  { to: '/', label: 'Home', icon: LiveIcon },
  { to: '/events', label: 'Events', icon: EventsIcon },
  { to: '/people', label: 'Faces', icon: PeopleIcon },
  { to: '/settings', label: 'Settings', icon: SettingsIcon },
]

export function BottomNav() {
  const ripple = useRipple()
  const { user } = useAuth()
  const visibleTabs =
    isGodModeUser(user)
      ? [...tabs, { to: '/god', label: 'God View', icon: GodViewIcon }]
      : tabs
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
        {visibleTabs.map((t) => (
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
              // Landscape label: 9px was below the readable floor
              // (frank B3) — 11px still fits "Settings" inside the
              // 64px rail width with the px-1.5 nav padding.
              `relative overflow-hidden flex flex-1 landscape-phone:flex-none landscape-phone:w-full py-1.5 flex-col items-center gap-0.5 text-xs landscape-phone:text-[11px] rounded-full transition-colors focus-ring focus-visible:outline-offset-[-4px] focus-visible:rounded-full ${
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

// Icon glyphs live in NavIcons.tsx (shared with SideRail — one
// source, no drift). Every glyph is aria-hidden (iter-356.56 Dana
// #2) so screen readers announce only the visible label.
