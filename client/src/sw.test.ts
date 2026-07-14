import { beforeAll, describe, expect, it, vi } from 'vitest'

// notif-deeplink (UI/UX overhaul 2026-07-07): sw.ts runs module-level
// SW wiring (skipWaiting, clientsClaim, precacheAndRoute) on import.
// Mock the workbox modules + stub the one SW-global the module body
// touches so importing it in jsdom is inert, leaving the exported
// notificationClickTarget pure helper testable without a real
// ServiceWorkerGlobalScope. Same isolation rationale as
// lib/swPushHandler.ts (iter-282).
vi.mock('workbox-core', () => ({ clientsClaim: vi.fn() }))
vi.mock('workbox-precaching', () => ({
  cleanupOutdatedCaches: vi.fn(),
  precacheAndRoute: vi.fn(),
  createHandlerBoundToURL: vi.fn(),
}))
vi.mock('workbox-routing', () => ({
  registerRoute: vi.fn(),
  NavigationRoute: vi.fn(),
}))
vi.mock('workbox-strategies', () => ({
  CacheFirst: vi.fn(),
  NetworkFirst: vi.fn(),
}))
vi.mock('workbox-cacheable-response', () => ({
  CacheableResponsePlugin: vi.fn(),
}))
vi.mock('workbox-expiration', () => ({ ExpirationPlugin: vi.fn() }))

let notificationClickTarget: typeof import('./sw').notificationClickTarget
let notificationActionTarget: typeof import('./sw').notificationActionTarget

beforeAll(async () => {
  // sw.ts calls self.skipWaiting() at module scope; jsdom's window
  // (which `self` resolves to) doesn't have it.
  ;(globalThis as unknown as { skipWaiting: () => void }).skipWaiting =
    vi.fn()
  ;({ notificationClickTarget, notificationActionTarget } = await import('./sw'))
})

describe('notificationClickTarget', () => {
  it('given a detection payload with url + event_id, when the click target is composed, then it deep-links /events?event=<id>', () => {
    // arrange
    const data = { url: '/events', event_id: 'abc123' }

    // act
    const target = notificationClickTarget(data)

    // assert
    expect(target).toBe('/events?event=abc123')
  })

  it('given a non-event notification (timelapse ready, no event_id), when composed, then the payload url passes through untouched', () => {
    // arrange
    const data = { url: '/settings', event_id: null }

    // act
    const target = notificationClickTarget(data)

    // assert
    expect(target).toBe('/settings')
  })

  it('given no data at all (legacy notification), when composed, then the target falls back to /', () => {
    // arrange / act
    const target = notificationClickTarget(null)

    // assert
    expect(target).toBe('/')
  })

  it('given the generic "event" test-push tag leaked into event_id, when composed, then no deep-link param is appended (same guard as the dismiss branch)', () => {
    // arrange
    const data = { url: '/events', event_id: 'event' }

    // act
    const target = notificationClickTarget(data)

    // assert
    expect(target).toBe('/events')
  })

  it('given an event_id needing URL encoding, when composed, then the id is percent-encoded', () => {
    // arrange
    const data = { url: '/events', event_id: 'a b&c' }

    // act
    const target = notificationClickTarget(data)

    // assert
    expect(target).toBe('/events?event=a%20b%26c')
  })

  it('given a base url that already carries a query string, when composed, then the event param is appended with &', () => {
    // arrange
    const data = { url: '/events?person=Alice', event_id: 'e1' }

    // act
    const target = notificationClickTarget(data)

    // assert
    expect(target).toBe('/events?person=Alice&event=e1')
  })
})

describe('notificationActionTarget', () => {
  it('given Talk is selected, when composed, then it opens a foreground talk intent without starting the microphone', () => {
    expect(
      notificationActionTarget('talk', {
        url: '/events',
        event_id: 'evt 7',
      }),
    ).toBe('/?talk=1&event=evt+7')
  })

  it('given a deterrence action, when composed, then it opens a foreground confirmation intent with duration and event', () => {
    expect(
      notificationActionTarget('siren', {
        event_id: 'evt-9',
        deterrence_duration_s: 20,
      }),
    ).toBe('/?deterrence=siren&duration=20&event=evt-9')
  })

  it('given an unrecognized action, when composed, then it safely falls back to the event viewer', () => {
    expect(
      notificationActionTarget('snooze', {
        url: '/events',
        event_id: 'evt-10',
      }),
    ).toBe('/events?event=evt-10')
  })
})
