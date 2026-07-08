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
    captureSnapshot: vi.fn(),
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

    // act — client-side navigate via the Events tab. Scope to the
    // BottomNav landmark: the SideRail renders a second Events link.
    fireEvent.click(within(nav).getByRole('link', { name: /events/i }))

    // assert — the layout effect keyed on pathname zeroes the
    // scroll offset before the new page paints.
    await screen.findByRole('heading', { level: 1, name: /^events$/i })
    expect(main.scrollTop).toBe(0)
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

  it('GIVEN the legacy /live bookmark WHEN the app mounts THEN it redirects to Home, not a blank page', async () => {
    // arrange
    goTo('/live')

    // act
    render(<App />)

    // assert
    const nav = await screen.findByRole('navigation', { name: 'Bottom navigation' })
    expect(nav).toBeInTheDocument()
  })
})
