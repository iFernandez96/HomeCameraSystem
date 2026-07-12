import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'

// ── Mock surface ─────────────────────────────────────────────────
// Landscape-pass Task 2: /live-style unknown/stale routes rendered a
// BLANK page on a real device (confirmed at /live, an old bookmark).
// This test drives the REAL <App/> router (BrowserRouter reads
// window.location, so we push history state before render) to pin
// that an unrecognized path lands on real, visible content — not a
// blank body. Auth + network are mocked; the goal is routing
// behavior, not a full page mount of every data-fetching child.
vi.mock('./lib/auth', () => ({
  AuthProvider: ({ children }: { children: React.ReactNode }) => children,
  useAuth: () => ({
    state: 'authed',
    user: { username: 'alice', role: 'admin' },
    login: vi.fn(),
    logout: vi.fn(),
  }),
  getSessionExpiredFlag: () => false,
  clearSessionExpiredFlag: vi.fn(),
}))

vi.mock('./lib/api', () => {
  class HttpError extends Error {
    status: number
    constructor(status: number) {
      super(`HTTP ${status}`)
      this.status = status
    }
  }
  return {
    getStatus: vi.fn().mockResolvedValue(null),
    searchEvents: vi.fn().mockResolvedValue({ items: [], next_cursor: null }),
    getSavedSearches: vi.fn().mockResolvedValue({ v: 1, items: [] }),
    captureSnapshot: vi.fn(),
    getCameras: vi.fn().mockResolvedValue({
      cameras: [{ id: 'front_door', name: 'Front Door', path: 'cam' }],
    }),
    getCurrentPackages: vi.fn().mockResolvedValue({ v: 1, items: [] }),
    triggerDeterrence: vi.fn().mockResolvedValue({ ok: true }),
    listVisitStories: vi.fn().mockResolvedValue({ items: [] }),
    getUnreadCount: vi.fn().mockResolvedValue(0),
    // W2 scroll-reset test navigates to the real Events page, which
    // pulls in the rest of the events API surface at module scope —
    // stub the lot with quiet resolved values.
    fetchEvents: vi.fn().mockResolvedValue([]),
    getDetectionConfig: vi.fn().mockResolvedValue({ classes: [] }),
    markAllEventsSeen: vi.fn().mockResolvedValue({ updated: 0 }),
    markEventSeen: vi.fn().mockResolvedValue({ updated: true }),
    deleteEvent: vi.fn().mockResolvedValue({ deleted: true }),
    deleteEventsByDay: vi.fn().mockResolvedValue({ deleted: 0 }),
    exportEvents: vi
      .fn()
      .mockResolvedValue(new Blob([''], { type: 'application/zip' })),
    getEventCountsByDay: vi.fn().mockResolvedValue({ days: {} }),
    fetchEventTracks: vi.fn().mockResolvedValue(null),
    HttpError,
  }
})

vi.mock('./lib/ws', () => ({
  subscribeEvents: () => () => {},
  subscribeWsState: () => () => {},
  reconnectIfClosed: vi.fn(),
}))

// The WebRTC tile owns WHEP wiring that jsdom can't exercise, and is
// being edited concurrently by another agent — stub it out entirely
// so this routing test never imports it.
vi.mock('./components/VideoTile', () => ({
  VideoTile: () => <div data-testid="video-tile-stub" />,
}))

import { App } from './App'

function goTo(path: string) {
  window.history.pushState({}, '', path)
}

describe('App routing', () => {
  beforeEach(() => {
    goTo('/')
  })
  afterEach(() => {
    goTo('/')
  })

  // NOTE: this test must run FIRST in the file. React.lazy caches the
  // resolved Watch module at App.tsx module scope, so only the very
  // first mount of "/" in this process actually suspends — later
  // renders resolve synchronously and never show the fallback.
  it('GIVEN a cold visit to "/" WHEN the Watch chunk is still loading THEN the Suspense fallback is VIDEO-shaped, not a list (UI/UX overhaul 2026-07-07, perf C1: the home route resolves to a video tile; a list skeleton jump-cut into a video frame)', async () => {
    // arrange
    goTo('/')

    // act
    render(<App />)

    // assert — LoadingState shape="video" announces itself as a
    // "Loading video" status region; the list shape does not.
    expect(
      screen.getByRole('status', { name: /loading video/i }),
    ).toBeInTheDocument()
    // Let the lazy chunk settle so this test doesn't leak an
    // in-flight suspense boundary into the next one.
    await waitFor(() =>
      expect(
        screen.queryByRole('status', { name: /loading video/i }),
      ).not.toBeInTheDocument(),
    )
  })

  it('GIVEN the user has scrolled deep into a page WHEN navigating to another route THEN the main scroll container resets to the top (UI/UX overhaul 2026-07-07, hari FOCUS-1: <main> is the real scroller, so router navigation used to land mid-scroll)', async () => {
    // arrange — mount Home, then simulate a deep scroll of <main>.
    goTo('/')
    render(<App />)
    const nav = await screen.findByRole('navigation', {
      name: 'Bottom navigation',
    })
    expect(nav).toBeInTheDocument()
    const main = screen.getByRole('main')
    main.scrollTop = 480
    expect(main.scrollTop).toBe(480)

    // act — client-side navigate via the Activity tab.
    fireEvent.click(within(nav).getByRole('link', { name: /activity/i }))

    // assert — the layout effect keyed on pathname zeroes the
    // scroll offset before the new page paints.
    await screen.findByRole('heading', { level: 1, name: /^activity$/i })
    expect(main.scrollTop).toBe(0)
  })

  it('GIVEN Home renders WHEN the app shell lays out the live view THEN main itself is not a vertical scroller', async () => {
    // arrange / act
    goTo('/')
    render(<App />)
    const main = await screen.findByRole('main')
    await screen.findByTestId('video-tile-stub')

    // assert — the Watch route owns a fixed viewport and the Today at
    // home list scrolls internally. The shell must not add route-level
    // scroll or old bottom padding, otherwise the live view drifts.
    expect(main.className).toMatch(/overflow-hidden/)
    expect(main.className).toMatch(/pb-0/)
    expect(main.className).not.toMatch(/overflow-y-auto/)
    expect(main.firstElementChild?.className).toMatch(/h-full/)
    expect(main.firstElementChild?.className).toMatch(/min-h-0/)
    expect(document.documentElement.classList.contains('homecam-watch-route')).toBe(true)
    expect(document.body.classList.contains('homecam-watch-route')).toBe(true)
  })

  it('GIVEN an unknown path WHEN the app mounts THEN it does not render a blank page — Home renders instead', async () => {
    // arrange
    goTo('/some-old-bookmarked-route-that-no-longer-exists')

    // act
    render(<App />)

    // assert — the app shell chrome (bottom nav landmark) renders,
    // proving the catch-all redirected to real content rather than
    // an empty <main>. `findBy*` awaits the lazy Watch chunk resolve.
    const nav = await screen.findByRole('navigation', { name: 'Bottom navigation' })
    expect(nav).toBeInTheDocument()
    expect(document.body.textContent?.trim().length).toBeGreaterThan(0)
  })

  it('GIVEN the public event-search path WHEN the app mounts THEN the routed search page renders', async () => {
    goTo('/events/search')

    render(<App />)

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Search events' }),
    ).toBeInTheDocument()
  })

  it('GIVEN the public visits path WHEN the app mounts THEN the visit-story list renders', async () => {
    goTo('/events/visits')

    render(<App />)

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Visits' }),
    ).toBeInTheDocument()
  })

  it('GIVEN the legacy /live bookmark WHEN the app mounts THEN it redirects to Home, not a blank page', async () => {
    // arrange
    goTo('/live')

    // act
    render(<App />)

    // assert
    const nav = await screen.findByRole('navigation', { name: 'Bottom navigation' })
    expect(nav).toBeInTheDocument()
  })

  it('GIVEN the user changes primary tabs WHEN Android Back is pressed from Home THEN it does not replay the previous Settings tab', async () => {
    // arrange — seed a real previous entry, then enter the app. If tab
    // clicks push instead of replace, Back from Home lands on Settings.
    window.history.replaceState({}, '', '/before-app')
    window.history.pushState({}, '', '/')
    render(<App />)
    const nav = await screen.findByRole('navigation', {
      name: 'Bottom navigation',
    })

    // act — tab to Settings, tab back Home, then simulate Android Back.
    fireEvent.click(within(nav).getByRole('link', { name: /settings/i }))
    await waitFor(() => expect(window.location.pathname).toBe('/settings'))
    fireEvent.click(within(nav).getByRole('link', { name: /home/i }))
    await waitFor(() => expect(window.location.pathname).toBe('/'))
    const popped = new Promise<void>((resolve) => {
      window.addEventListener('popstate', () => resolve(), { once: true })
    })
    window.history.back()
    await popped

    // assert — Back may leave the app entry or be caught by the
    // catch-all redirect, but it must not land sideways on Settings.
    await waitFor(() => expect(window.location.pathname).not.toBe('/settings'))
  })

  it('GIVEN Home is the current app tab WHEN Android Back is pressed THEN the PWA stays on Home instead of falling through to a blank shell', async () => {
    // arrange — simulate the PWA custom-tab having a non-app entry
    // behind Home. The root back guard should consume Back inside the
    // app document before the browser exposes that empty container.
    window.history.replaceState({}, '', '/blank-shell')
    window.history.pushState({}, '', '/')
    render(<App />)
    await screen.findByRole('navigation', { name: 'Bottom navigation' })
    await waitFor(() => expect(window.history.state?.homecamRootGuard).toBe(true))

    // act
    const popped = new Promise<void>((resolve) => {
      window.addEventListener('popstate', () => resolve(), { once: true })
    })
    window.history.back()
    await popped

    // assert
    await waitFor(() => expect(window.location.pathname).toBe('/'))
  })
})
