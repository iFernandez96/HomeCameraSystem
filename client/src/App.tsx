import { lazy, Suspense } from 'react'
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { BottomNav } from './components/BottomNav'
import { ConnectionBanner } from './components/ConnectionBanner'
import { ErrorBoundary } from './components/ErrorBoundary'
import { LoadingState } from './components/states/LoadingState'
import { RequireAuth } from './components/RequireAuth'
import { SideRail } from './components/SideRail'
import { WatchRibbon } from './components/WatchRibbon'
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
  // iter-356.63 (mobile redesign Slice F): swap the centered
  // PawSpinner Suspense fallback for a route-shaped <LoadingState>.
  // The "list" shape is a reasonable default — most route bundles
  // (Events, People, Training, Review) resolve to a list/grid that
  // matches it; the grid/video/form variants are picked at the page
  // level when the route can be more specific.
  return <LoadingState shape="list" />
}

// Each page is wrapped in its own ErrorBoundary so an uncaught throw
// in (say) the Events list renderer doesn't blank Live or Settings.
// Bottom nav stays outside the boundary so the user can always
// navigate away from a crashed page without a hard reload.
function AppShell() {
  const { state } = useAuth()
  const location = useLocation()
  // iter-248: home-screen app-icon badge wiring.
  useUnreadBadge()
  const [catsEnabled] = useCatsEnabled()
  // iter-356.58 (layout rebuild): cats only walk on Live. The
  // mobile-architect brief flagged the cat strip overlapping the
  // empty-state cat illustration on People + Settings. Restricting
  // to /live keeps the brand atmosphere while removing the visual
  // register collision on other routes.
  const isLiveRoute = location.pathname === '/live' || location.pathname === '/'
  // iter-356.58: hide the entire shell chrome on Login. Login owns
  // the full viewport with its own brand block.
  const isLoginRoute = location.pathname === '/login'
  const showShell = state === 'authed' && !isLoginRoute
  return (
    <div className="flex flex-col h-full">
      <ConnectionBanner />
      {/* iter-356.58 (layout rebuild) — STRUCTURAL: kill the 224px
          sidebar + per-page-h1 pattern. Replace with:
            (a) <WatchRibbon> — 56px persistent top bar with brand +
                live-watch state + jump-to-live action.
            (b) <SideRail>   — slim 64px icon-only nav rail (was 224
                px SideNav with stacked icon+label rows).
            (c) Per-page H1s collapse to optional headers; the
                ribbon carries identity universally.
          This is the load-bearing layout move. SaaS-template
          sidebar pattern dies here. */}
      {showShell && <WatchRibbon />}
      {showShell && <SideRail />}
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
        // redesign/warm-boutique: text-primary is now dark ink — on the
        // marmalade focus bg it fails contrast. White on #b3540b ≈ 4.9:1.
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:px-4 focus:py-2 focus:bg-[var(--color-accent-default)] focus:text-[var(--color-on-accent)] focus:rounded-lg focus:outline-2 focus:outline-white focus:outline-offset-2 focus:shadow-[var(--shadow-card)]"
      >
        Skip to content
      </a>
      <main
        id="main"
        // iter-356.58 (layout rebuild): main column now offsets for
        // the 64px SideRail (was 224px) on lg+ AND clears the 56px
        // WatchRibbon on top via padding. Sidenav-width var
        // updated 14rem → 4rem so any other consumer (toast,
        // ConnectionBanner) inherits the new offset. Day-header
        // sticky-top now starts BELOW the ribbon (56px) instead of
        // the old generic 64px.
        // iter-356.66 (user "can you just let me scroll a bit downward
        // to show them please?"): on /live the pb is extended by
        // ~120 px (the CatLayer strip height = SPRITE_HEIGHT + 56 +
        // the 80-px bottom offset) so scrolling to the end reveals
        // the ambient cats walking ABOVE the BottomNav. CatLayer
        // only mounts on /live (see isLiveRoute below), so other
        // routes use the base nav-clearance pb only — pre-gating
        // they got 120 px of empty cream on iPhone with no cats to
        // fill it, the "horrible bottom space" report. Desktop (lg+)
        // keeps the original pb-6 because lg has no BottomNav and
        // the SideRail handles nav.
        className={`flex-1 overflow-y-auto overscroll-y-contain ${
          isLiveRoute
            ? 'pb-[calc(5rem+env(safe-area-inset-bottom)+7.5rem)]'
            : 'pb-[calc(5rem+env(safe-area-inset-bottom))]'
        } lg:pb-6 w-full ${
          showShell ? 'lg:ml-16 lg:max-w-[calc(100vw-4rem)]' : ''
        }`}
        style={
          {
            '--sidenav-width': '4rem',
            // Below the WatchRibbon (56 px) + iOS safe area.
            '--day-header-top': 'calc(56px + env(safe-area-inset-top))',
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
      {/* iter-356.58: BottomNav stays on mobile only; SideRail
          covers desktop. Login also hides it. */}
      {showShell && (
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
      {/* iter-356.58 (layout rebuild) — cats only walk on /live.
          Mobile-architect brief: the cat strip overlapped empty-
          state cat illustrations on People + collided with text
          density on Settings. Restricting the layer to the camera
          page keeps the brand atmosphere where it belongs (the
          camera IS the cats' domain) and clears bottom space on
          every other route. */}
      {showShell && catsEnabled && isLiveRoute && (
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
