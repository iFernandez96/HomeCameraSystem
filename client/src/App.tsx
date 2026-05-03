import { lazy, Suspense } from 'react'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { BottomNav } from './components/BottomNav'
import { ConnectionBanner } from './components/ConnectionBanner'
import { ErrorBoundary } from './components/ErrorBoundary'
import { RequireAuth } from './components/RequireAuth'
import { SideNav } from './components/SideNav'
import { AuthProvider, useAuth } from './lib/auth'
import { useUnreadBadge } from './lib/badge'
import { useCatsEnabled } from './lib/catPref'
import { ConfirmProvider } from './lib/confirm'
import { ToastProvider } from './lib/toast'

// iter-241: route-level code-split. Pre-iter-241 the production
// bundle was a single 300 KB JS chunk because all 4 pages were
// eagerly imported. Vite emits per-route chunks for `lazy()` calls,
// so first-paint after a cold visit only loads the landing route.
// The named-export → default-export shim is needed because pages
// export `export function X` (matches the rest of the codebase)
// while React.lazy wants a default export.
const Live = lazy(() => import('./pages/Live').then((m) => ({ default: m.Live })))
const Events = lazy(() =>
  import('./pages/Events').then((m) => ({ default: m.Events })),
)
const Login = lazy(() => import('./pages/Login').then((m) => ({ default: m.Login })))
const People = lazy(() =>
  import('./pages/People').then((m) => ({ default: m.People })),
)
const Settings = lazy(() =>
  import('./pages/Settings').then((m) => ({ default: m.Settings })),
)
// iter-352 (face-capture-for-retraining, Phase 2): /training page
// for browsing the worker's saved face crops. Lazy because most
// users don't need it on every session — only when curating + re-
// training. Reachable from the People page header AND SideNav.
const Training = lazy(() =>
  import('./pages/Training').then((m) => ({ default: m.Training })),
)
// iter-356.12: /training/review — surfaces only the captures the
// classifier is uncertain about (confidence in [0.3, 0.75]). The
// active-learning entry point — most-bang-for-buck triage. Server
// route shipped iter-355c1 + tests; this is the FIRST UI consumer.
const Review = lazy(() =>
  import('./pages/Review').then((m) => ({ default: m.Review })),
)

// iter-356.6 (perf A1): lazy-load the ambient CatLayer. Pre-iter-356.6
// the static import at module top pulled the ~12 KB minified SVG +
// state machine into the SHELL chunk, which loads on every cold
// visit including the Login page. The render is already gated by
// `state === 'authed'`, so the JS only runs after auth — but the
// bytes still rode in the shell. Switching to lazy() defers them
// behind a code-split boundary that fires at the same time the
// guard would have. Estimated save: ~8-9 KB gzip off the shell;
// Login chunk shrinks back close to its 6 KB pre-iter-356.4 size.
const CatLayer = lazy(() =>
  import('./components/CatLayer').then((m) => ({ default: m.CatLayer })),
)

// iter-356.20 (Maya 14th CRITICAL #1): bare-spinner page fallback
// kept for non-Live routes (Events / People / Settings / Training /
// Review / Login). Live uses the LivePageSkeleton via RequireAuth's
// loading branch — the SAME skeleton shape will swap in here too
// when Live's lazy chunk is in-flight, so the user sees one
// continuous shape from auth-resolution → chunk-load → first frame.
// PageFallback is the fallback for everything else; not worth
// per-route skeletons until a specific page requests one.
function PageFallback() {
  // iter-356.25 (light theme): tokenized spinner ring colors. The
  // base ring uses --color-border-subtle (warm tan); the moving
  // arc uses --color-accent-default (calico orange) so the loading
  // motion brings a touch of brand warmth instead of a generic
  // grey ring.
  return (
    <div
      className="flex items-center justify-center py-12"
      role="status"
      aria-label="Loading"
      aria-busy="true"
    >
      <div className="w-6 h-6 rounded-full border-2 border-[var(--color-border-subtle)] border-t-[var(--color-accent-default)] animate-spin" />
    </div>
  )
}

// Each page is wrapped in its own ErrorBoundary so an uncaught throw
// in (say) the Events list renderer doesn't blank Live or Settings.
// Bottom nav stays outside the boundary so the user can always
// navigate away from a crashed page without a hard reload.
function AppShell() {
  const { state } = useAuth()
  // iter-248: home-screen app-icon badge wiring. The hook is a no-op
  // when the user is anon (no /unread_count permission) — auth-failed
  // calls swallow silently and the WS subscription likewise inherits
  // the auth-gated WS handshake which closes 1008 if not authed.
  useUnreadBadge()
  // iter-356.10 (Frank #5): per-device toggle for the ambient cat
  // layer. Default on. Settings → Account → "Show ambient cats"
  // flips it. Reads localStorage; cross-tab via storage event.
  const [catsEnabled] = useCatsEnabled()
  return (
    <div className="flex flex-col h-full">
      <ConnectionBanner />
      {/* iter-261: real desktop layout. SideNav fixed-positioned at
          left on `lg:` (≥1024px) viewports; BottomNav stays for
          smaller screens. Main content gets `lg:ml-56` to clear the
          240 px sidebar, `lg:pb-6` to drop the bottom-nav padding.

          iter-267 (mobile-desktop-coherence-auditor C1): the
          previous `lg:max-w-5xl` wrapper here was capping every
          page at 1024 px on desktop, leaving 200-1000 px of empty
          neutral-950 to the right of every screen on a 1440 px+
          monitor. The original intent (Live + Login readability)
          is now enforced PER PAGE — pages that benefit from a
          width cap (Live's `max-w-5xl`, Login's `max-w-sm`) set
          their own, while Events + Settings + Manage Users get the
          full available width and can lay themselves out as actual
          desktop surfaces.

          --sidenav-width is also exposed as a CSS variable here so
          the iter-262 column-aware fixed elements (ConnectionBanner,
          toast) can stop hard-coding `lg:left-56` and the iter-260
          band-aid lineage doesn't compound.

          --day-header-top fixes the iter-? sticky-header collision:
          EventList day-section headers stick to top: var(...) which
          was unset, so they collided with the Events page sticky
          header. Set to ~64px so day headers sit just below the
          page header. */}
      <SideNav />
      {/* iter-269 (accessibility-auditor D top-3): skip-to-main link.
          Visible only when keyboard-focused. Closes the iter-261
          desktop SideNav tab-gauntlet (3 nav items × N pages = N×3
          tabs to reach content) AND the mobile case where VoiceOver
          users have to swipe past the BottomNav before reaching the
          page body. The `sr-only focus:not-sr-only` Tailwind pattern
          keeps it invisible until focused. The .sr-only utility is
          defined in index.css. */}
      <a
        href="#main"
        // iter-356.25 (light theme) → Maya Phase-2 fix: outline was
        // amber-on-amber (focus-bg accent + focus-outline accent-bright)
        // = invisible-when-focused for the keyboard users this exists
        // for. Now: white outline on accent-orange background — the
        // outline's job is to add a visible halo, the contrast is
        // white-vs-orange.
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:px-4 focus:py-2 focus:bg-[var(--color-accent-default)] focus:text-[var(--color-text-primary)] focus:rounded-lg focus:outline-2 focus:outline-white focus:outline-offset-2 focus:shadow-[var(--shadow-card)]"
      >
        Skip to content
      </a>
      <main
        id="main"
        // iter-347 (Mobile E1 from iter-347 audit): overscroll-y-contain
        // here on the actual scroll container (was placed on People
        // wrapper at iter-342 — silent no-op because the wrapper is
        // not a scroll container). Suppresses Android Chrome
        // pull-to-refresh app-wide which was discarding the loaded
        // list on a fast top-fling.
        className="flex-1 overflow-y-auto overscroll-y-contain pb-20 lg:pb-6 pt-[env(safe-area-inset-top)] w-full lg:ml-56 lg:max-w-[calc(100vw-14rem)]"
        style={
          {
            '--sidenav-width': '14rem',
            // iter-286 (mobile-view-auditor C1): include the iOS
            // safe-area inset so day-headers don't briefly overlap
            // the page-header during scroll-back gestures. The page
            // header sits at top: env(safe-area-inset-top) (via
            // pt-[env(...)] on this `<main>`), so the day-header
            // sticky offset must include the same inset to land
            // beneath it.
            '--day-header-top': 'calc(64px + env(safe-area-inset-top))',
          } as React.CSSProperties
        }
      >
        <div className="w-full mx-auto">
          <Suspense fallback={<PageFallback />}>
            <Routes>
            <Route path="/login" element={<Login />} />
            <Route path="/" element={<Navigate to="/live" replace />} />
            <Route
              path="/live"
              element={
                <RequireAuth>
                  <ErrorBoundary label="Live">
                    <Live />
                  </ErrorBoundary>
                </RequireAuth>
              }
            />
            <Route
              path="/events"
              element={
                <RequireAuth>
                  <ErrorBoundary label="Events">
                    <Events />
                  </ErrorBoundary>
                </RequireAuth>
              }
            />
            <Route
              path="/people"
              element={
                <RequireAuth>
                  <ErrorBoundary label="People">
                    <People />
                  </ErrorBoundary>
                </RequireAuth>
              }
            />
            <Route
              path="/training"
              element={
                <RequireAuth>
                  <ErrorBoundary label="Training">
                    <Training />
                  </ErrorBoundary>
                </RequireAuth>
              }
            />
            <Route
              path="/training/review"
              element={
                <RequireAuth>
                  <ErrorBoundary label="Review">
                    <Review />
                  </ErrorBoundary>
                </RequireAuth>
              }
            />
            <Route
              path="/settings"
              element={
                <RequireAuth>
                  <ErrorBoundary label="Settings">
                    <Settings />
                  </ErrorBoundary>
                </RequireAuth>
              }
            />
            <Route path="*" element={<Navigate to="/live" replace />} />
          </Routes>
          </Suspense>
        </div>
      </main>
      {/* Hide BottomNav on /login AND on `lg:` viewports (the
          SideNav fills that role on desktop). */}
      {state === 'authed' && (
        <div className="lg:hidden">
          <BottomNav />
        </div>
      )}
      {/* iter-356.4-cats: ambient cat layer. Three personality-driven
          sprites walk along the bottom of the viewport, react to each
          other (head-rubs, hisses, chases, scares), and emit emoji
          mood bubbles. Mounted only when authed so the Login page
          stays calm. pointer-events:none + z-index below modals so
          they never block UX. prefers-reduced-motion respected
          (cats freeze in cute poses).
          iter-356.6: Suspense fallback={null} — the cats are pure
          decoration; rendering nothing during the brief lazy-load
          is correct (a spinner here would defeat the purpose). */}
      {state === 'authed' && catsEnabled && (
        <Suspense fallback={null}>
          <CatLayer />
        </Suspense>
      )}
    </div>
  )
}

export function App() {
  return (
    <BrowserRouter>
      <ToastProvider>
        <ConfirmProvider>
          <AuthProvider>
            <AppShell />
          </AuthProvider>
        </ConfirmProvider>
      </ToastProvider>
    </BrowserRouter>
  )
}
