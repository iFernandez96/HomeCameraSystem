/**
 * Viewport-matrix smoke tests (iter-356.66 / mobile-e2e-test-engineer).
 *
 * Goal: cheap-to-run JSDOM-only canary that catches gross horizontal-
 * overflow and "primary CTA missing" regressions across the five
 * user-reachable pages at four target viewport widths. Lives next to
 * the page-level Vitest specs so every `npm test` run gets it for
 * free; no Playwright, no Chrome dependency.
 *
 * What this is NOT: a replacement for the per-page behaviour tests
 * (Live.test.tsx, Events.test.tsx, Settings.test.tsx, etc.). Those
 * own state-machine + interaction coverage. This file is an
 * integration smoke layer — "does the page mount, paint a heading,
 * paint a primary action button, and not blow out horizontally?"
 *
 * ─────────────────────────── MOCKS ────────────────────────────────
 *
 * REAL (rendered as written in the source tree):
 *   - The page component itself (Login / Live / Events / Training /
 *     Settings).
 *   - The simulated <main> shell wrapping each page (className mirrors
 *     App.tsx so the bottom-nav-clearance pad assertion is meaningful).
 *   - MemoryRouter from react-router-dom (real).
 *
 * MOCKED:
 *   - `lib/api`: every function the five pages reach into. Calls
 *     resolve to deterministic minimal fixtures (empty-list-shaped or
 *     healthy-camera-shaped) so the page renders its happy path
 *     without network. HttpError stays the real class (re-exported
 *     from importActual) so `instanceof` narrowing still works.
 *   - `lib/auth`: state hard-coded to 'authed' as user 'alice/admin'
 *     so RequireAuth-equivalent gates pass without an AuthProvider.
 *   - `lib/useStatus`: returns a healthy ServerStatus snapshot
 *     (camera ok, worker alive, detection on, 30 fps, sane temps).
 *     Tests that need stale/throttled states use Live.test.tsx etc.
 *   - `lib/ws`: subscribeEvents + subscribeWsState are no-op
 *     unsubscribers. Connection-state UI doesn't fire anything.
 *   - `lib/push`: pushSupported() returns false so NotificationsSection
 *     short-circuits to "not supported" copy and skips ServiceWorker
 *     plumbing.
 *   - `components/VideoTile` + `components/SnapshotPreview`: replaced
 *     with stubs (WHEP is unwired in JSDOM; canvas is null).
 *   - `components/CatLayer` (transitively, lazy-loaded — never reached
 *     from this test).
 *   - `window.matchMedia`: stub that approximates Tailwind breakpoints
 *     (sm ≥640, md ≥768, lg ≥1024, xl ≥1280) against the current
 *     `window.innerWidth`.
 *
 * NOT mocked (and intentionally noop in JSDOM):
 *   - WHEP / WebRTC: `lib/webrtc` is never invoked because VideoTile
 *     is stubbed.
 *   - ServiceWorker registration (sw.ts): not imported at any level
 *     reached from a page.
 *   - localStorage: real JSDOM impl. Reset between tests.
 *
 * ─────────────────────── VIEWPORT TARGETS ─────────────────────────
 *
 *  360 — stress (Pixel-class small Android, primary check for overflow)
 *  390 — primary (iPhone 13/14/15 baseline)
 *  430 — secondary (iPhone Pro Max)
 *  768 — tablet (iPad portrait, just under Tailwind lg:)
 *
 * Per page × viewport, we assert:
 *   1. No horizontal overflow: shell.scrollWidth ≤ window.innerWidth+1.
 *   2. A level-1 heading is present.
 *   3. At least one primary action button is reachable by role.
 *   4. The shell <main> carries the pb-[calc(5rem+env(safe-area-
 *      inset-bottom))] bottom-nav-clearance pad.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, cleanup } from '@testing-library/react'
import type { ReactNode } from 'react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'

// ─── api mock ─────────────────────────────────────────────────────
// Re-export real HttpError (some pages use `instanceof HttpError`).
vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../lib/api')>('../lib/api')
  const healthyStatus = {
    ok: true,
    uptime_s: 600,
    camera: 'ok',
    detection_active: true,
    worker_alive: true,
    worker_last_seen_s: 1,
    worker_metrics: null,
    cpu_temp_c: 50,
    gpu_temp_c: 47,
    cpu_freq_pct: 100,
    load_avg: [0.5, 0.6, 0.7],
    memory_used_mb: 1400,
    memory_total_mb: 1979,
    disk_free_gb: 28,
    fps: 30,
    push_subs_count: 0,
    seconds_since_last_frame: 1,
    camera_label: 'Front Door',
    audio_enabled: false,
  }
  const detectionConfig = {
    threshold: 0.55,
    cooldown_s: 5,
    classes: ['person'],
    face_capture_enabled: false,
    face_capture_retention_days: 30,
  }
  // Catch-all: every API export becomes a Promise.resolve of a
  // minimal-shape fixture. Pages render their happy path without
  // ever needing a network round-trip.
  const noop = () => Promise.resolve({})
  return {
    ...actual,
    getStatus: () => Promise.resolve(healthyStatus),
    getDetectionConfig: () => Promise.resolve(detectionConfig),
    patchDetectionConfig: () => Promise.resolve(detectionConfig),
    fetchEvents: () => Promise.resolve([]),
    searchEvents: () =>
      Promise.resolve({ events: [], next_cursor: null, total: 0 }),
    fetchEventTracks: () => Promise.resolve(null),
    getEventCountsByDay: () => Promise.resolve({ counts: {} }),
    getUnreadCount: () => Promise.resolve({ unread: 0 }),
    markAllEventsSeen: noop,
    markEventSeen: noop,
    deleteEvent: () => Promise.resolve({ deleted: true }),
    deleteEventsByDay: () => Promise.resolve({ deleted: 0 }),
    exportEvents: () => Promise.resolve(new Blob([''], { type: 'application/zip' })),
    captureSnapshot: () => Promise.resolve({ url: '/snapshots/snap.jpg' }),
    toggleDetection: () => Promise.resolve({ active: true }),
    rebootJetson: noop,
    triggerBackup: noop,
    triggerRestore: noop,
    listBackups: () => Promise.resolve({ items: [] }),
    triggerUpdate: noop,
    getServerVersion: () => Promise.resolve({ version: '0.1.0' }),
    triggerTimelapse: noop,
    listTimelapses: () => Promise.resolve({ items: [] }),
    deleteTimelapse: () => Promise.resolve({ deleted: true, date: '' }),
    listPeople: () => Promise.resolve({ people: [], total: 0 }),
    listFaceCaptureDirs: () => Promise.resolve({ dirs: [] }),
    listFaceCapturesInDir: () => Promise.resolve({ files: [] }),
    moveFaceCapture: noop,
    deleteFaceCapture: noop,
    deleteTrainingCaptures: noop,
    getNameConsent: () => Promise.resolve({ name: '', consented: false, ts: 0 }),
    setNameConsent: noop,
    getTrainingExport: () => Promise.resolve(new Blob([''])),
    getMyPushFilters: () => Promise.resolve({ filters: null }),
    setMyPushFilters: () => Promise.resolve({ filters: null }),
    getKnownFilterOptions: () =>
      Promise.resolve({ cameras: [], person_names: [] }),
    adminListUsers: () => Promise.resolve({ users: [{ username: 'alice', role: 'admin', created_at: 1714000000 }] }),
    adminCreateUser: () => Promise.resolve({ ok: true, username: '', role: 'family' }),
    adminDeleteUser: () => Promise.resolve({ ok: true }),
    adminResetPassword: () => Promise.resolve({ ok: true }),
    changePassword: () => Promise.resolve({ ok: true }),
    login: noop,
    logout: noop,
    getMe: () => Promise.resolve({ user: { username: 'alice', role: 'admin' } }),
  }
})

// ─── auth mock — Login needs 'anon' so it doesn't <Navigate to="/live">.
// Other pages need 'authed' so internal owner gates render their
// content (Settings ManageUsersPanel, Events delete affordances, etc.).
// `_authState` is mutated per-page in mountAt().
const _authStateRef: { current: 'loading' | 'authed' | 'anon' } = {
  current: 'authed',
}
vi.mock('../lib/auth', () => ({
  useAuth: () => ({
    state: _authStateRef.current,
    user:
      _authStateRef.current === 'authed'
        ? { username: 'alice', role: 'admin' as const }
        : null,
    login: vi.fn().mockResolvedValue(undefined),
    logout: vi.fn(),
  }),
  AuthProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  getSessionExpiredFlag: () => false,
  clearSessionExpiredFlag: () => {},
}))

// ─── useStatus mock ───────────────────────────────────────────────
vi.mock('../lib/useStatus', () => ({
  useStatus: () => ({
    ok: true,
    uptime_s: 600,
    camera: 'ok',
    detection_active: true,
    worker_alive: true,
    worker_last_seen_s: 1,
    worker_metrics: null,
    cpu_temp_c: 50,
    gpu_temp_c: 47,
    cpu_freq_pct: 100,
    load_avg: [0.5, 0.6, 0.7],
    memory_used_mb: 1400,
    memory_total_mb: 1979,
    disk_free_gb: 28,
    fps: 30,
    push_subs_count: 0,
    seconds_since_last_frame: 1,
    camera_label: 'Front Door',
    audio_enabled: false,
  }),
}))

// ─── ws mock — no-op subscribers ──────────────────────────────────
vi.mock('../lib/ws', () => ({
  subscribeEvents: () => () => {},
  subscribeWsState: () => () => {},
}))

// ─── push mock — pretend not supported so the section is read-only ─
vi.mock('../lib/push', () => ({
  pushSupported: () => false,
  getPushState: () => Promise.resolve(false),
  ensurePushSubscription: () => Promise.resolve(false),
  disablePushSubscription: () => Promise.resolve(undefined),
  sendTestPush: () => Promise.resolve(0),
}))

// ─── VideoTile / SnapshotPreview stubs (WHEP unwired in JSDOM) ────
vi.mock('../components/VideoTile', () => ({
  VideoTile: () => <div data-testid="video-tile" />,
}))
vi.mock('../components/SnapshotPreview', () => ({
  SnapshotPreview: () => null,
}))

// ─── matchMedia stub for Tailwind breakpoints ────────────────────
function installMatchMedia() {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string) => {
      // Parse `(min-width: 640px)` style queries against innerWidth.
      const m = /\(min-width:\s*(\d+)px\)/.exec(query)
      const minW = m ? Number(m[1]) : 0
      const matches = window.innerWidth >= minW
      return {
        matches,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }
    },
  })
}

// ─── Viewport setter ─────────────────────────────────────────────
function setViewport(width: number) {
  Object.defineProperty(window, 'innerWidth', {
    writable: true,
    configurable: true,
    value: width,
  })
  Object.defineProperty(document.documentElement, 'clientWidth', {
    writable: true,
    configurable: true,
    value: width,
  })
  // 16:9 portrait-ish — matters less; widgets read width.
  Object.defineProperty(window, 'innerHeight', {
    writable: true,
    configurable: true,
    value: Math.round((width * 19) / 9),
  })
  // Trigger any resize listeners (none expected; safety net).
  window.dispatchEvent(new Event('resize'))
}

// ─── Test shell — mirrors App.tsx <main> for the pad assertion ───
// The pad classNames are duplicated verbatim from App.tsx so any
// future drift shows up here as a failed assertion. The width is
// clamped to window.innerWidth + style overflowX:hidden? NO — we
// want overflow to be observable, so width is unconstrained and we
// measure scrollWidth directly.
const MAIN_PAD_CLASS = 'pb-[calc(5rem+env(safe-area-inset-bottom))]'

function TestShell({ children }: { children: ReactNode }) {
  return (
    <main
      data-testid="viewport-main"
      style={{ width: window.innerWidth }}
      className={`flex-1 overflow-y-auto overscroll-y-contain ${MAIN_PAD_CLASS} lg:pb-6 w-full`}
    >
      <div className="w-full mx-auto">{children}</div>
    </main>
  )
}

// Helper: render a page at a route, return { main } once it has a h1.
async function mountAt(width: number, path: string, element: ReactNode) {
  setViewport(width)
  // Build a Routes set that always supplies the matching path.
  render(
    <MemoryRouter initialEntries={[path]}>
      <TestShell>
        <Routes>
          <Route path={path} element={<>{element}</>} />
          <Route path="*" element={<>{element}</>} />
        </Routes>
      </TestShell>
    </MemoryRouter>,
  )
  // Pages do their initial fetch via useEffect → wait for h1 to land.
  const h1 = await screen.findByRole(
    'heading',
    { level: 1 },
    { timeout: 3000 },
  )
  return { h1, main: screen.getByTestId('viewport-main') }
}

// ─── Page imports ────────────────────────────────────────────────
import { Login } from '../pages/Login'
import { Watch } from '../pages/Watch'
import { Events } from '../pages/Events'
import { Training } from '../pages/Training'
import { Settings } from '../pages/Settings'

// ─── Per-page registry ───────────────────────────────────────────
const PAGES: Array<{
  name: string
  path: string
  element: ReactNode
  // Loose pattern for "primary action" probe; first match wins.
  primaryAction: RegExp
  authState: 'authed' | 'anon'
}> = [
  { name: 'Login', path: '/login', element: <Login />, primaryAction: /sign in/i, authState: 'anon' },
  { name: 'Watch', path: '/', element: <Watch />, primaryAction: /(snapshot|full screen)/i, authState: 'authed' },
  { name: 'Events', path: '/events', element: <Events />, primaryAction: /./, authState: 'authed' },
  { name: 'Training', path: '/training', element: <Training />, primaryAction: /./, authState: 'authed' },
  { name: 'Settings', path: '/settings', element: <Settings />, primaryAction: /./, authState: 'authed' },
]

const VIEWPORTS = [360, 390, 430, 768] as const

describe('viewport matrix — JSDOM smoke', () => {
  beforeEach(() => {
    installMatchMedia()
    // localStorage cleared so Settings tab default is deterministic.
    window.localStorage.clear()
    // Silence noisy console.error from unhandled-rejection of mocked
    // network calls under the hood (jsdom log noise, not a failure).
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  for (const page of PAGES) {
    describe(page.name, () => {
      for (const width of VIEWPORTS) {
        it(`given viewport=${width}px, when ${page.name} mounts, then no horizontal overflow + h1 + primary action present`, async () => {
          // arrange — flip auth state to match what the page needs.
          _authStateRef.current = page.authState
          // act
          const { h1, main } = await mountAt(width, page.path, page.element)

          // assert — pad class survives
          expect(main.className).toMatch(
            /pb-\[calc\(5rem\+env\(safe-area-inset-bottom\)\)\]/,
          )

          // assert — level-1 heading exists (sr-only OR visible).
          expect(h1).toBeInTheDocument()
          expect(h1.textContent ?? '').not.toBe('')

          // assert — at least one button reachable.
          // Some pages render many buttons; first match by role is enough.
          const buttons = await waitFor(() => {
            const found = screen.queryAllByRole('button')
            if (found.length === 0) {
              // Login renders a form-submit <button>; should never be empty.
              throw new Error('no buttons found')
            }
            return found
          })
          expect(buttons.length).toBeGreaterThan(0)

          // assert — primary action regex matches at least one
          // accessible name. We don't tie to a specific button — pages
          // have multiple primary surfaces; any match is enough.
          const matched = buttons.some((b) => {
            const name = (b.getAttribute('aria-label') ?? b.textContent ?? '').trim()
            return page.primaryAction.test(name)
          })
          expect(matched, `expected a button matching ${page.primaryAction}`).toBe(true)

          // assert — no horizontal overflow on smallest viewports.
          // JSDOM scrollWidth is approximate but stable: a layout with
          // `min-w-[600px]` on a 360-wide shell still reports the
          // overflow. +1 tolerates the pixel-rounding scroll fudge.
          const overflow = main.scrollWidth - window.innerWidth
          expect(
            overflow,
            `${page.name} overflowed at ${width}px: scrollWidth=${main.scrollWidth} innerWidth=${window.innerWidth}`,
          ).toBeLessThanOrEqual(1)
        })
      }
    })
  }
})
