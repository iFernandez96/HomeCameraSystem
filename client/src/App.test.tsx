import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

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
    searchEvents: vi.fn().mockResolvedValue({ events: [], next_cursor: null }),
    captureSnapshot: vi.fn(),
    getUnreadCount: vi.fn().mockResolvedValue(0),
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
