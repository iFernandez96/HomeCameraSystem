import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'

// Nav-coherence fix (painfix, item 4): push permission is a one-way
// OS gate — `Notification.permission` — that this banner reads
// directly, since lib/push.ts persists no client-side "push was ever
// enabled" marker to key off instead.
const useAuthMock = vi.fn()
vi.mock('../lib/auth', () => ({
  useAuth: () => useAuthMock(),
}))

import { PushDeniedBanner } from './PushDeniedBanner'

const DISMISS_KEY = 'homecam:push-denied-banner-dismissed-until'

function setPermission(value: 'default' | 'denied' | 'granted') {
  Object.defineProperty(globalThis, 'Notification', {
    configurable: true,
    writable: true,
    value: { permission: value, requestPermission: vi.fn() },
  })
}

describe('PushDeniedBanner', () => {
  beforeEach(() => {
    useAuthMock.mockReset()
    useAuthMock.mockReturnValue({ state: 'authed' })
    localStorage.clear()
    setPermission('default')
  })
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('given push permission is denied and the user is authed, when the banner renders, then it shows the blocked-notifications warning as a status region', () => {
    // arrange
    setPermission('denied')

    // act
    render(<PushDeniedBanner />)

    // assert
    expect(screen.getByRole('status').textContent).toMatch(
      /notifications are blocked by your phone/i,
    )
  })

  it('given push permission is granted, when the banner renders, then it shows nothing', () => {
    // arrange
    setPermission('granted')

    // act
    render(<PushDeniedBanner />)

    // assert
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('given push permission is still the default (never asked), when the banner renders, then it shows nothing', () => {
    // arrange
    setPermission('default')

    // act
    render(<PushDeniedBanner />)

    // assert
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('given the user is not authed, when push permission is denied, then the banner still shows nothing (no session to warn on the login screen)', () => {
    // arrange
    setPermission('denied')
    useAuthMock.mockReturnValue({ state: 'anon' })

    // act
    render(<PushDeniedBanner />)

    // assert
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('given the banner is showing, when the user dismisses it, then it hides immediately and persists the dismissal', () => {
    // arrange
    setPermission('denied')
    render(<PushDeniedBanner />)
    expect(screen.getByRole('status')).toBeInTheDocument()

    // act
    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }))

    // assert — hides immediately
    expect(screen.queryByRole('status')).toBeNull()
    // assert — persisted for a future window (7 days), not just in-memory
    const stored = Number(localStorage.getItem(DISMISS_KEY))
    expect(stored).toBeGreaterThan(Date.now())
  })

  it('given a prior dismissal is still within its 7-day window, when the banner mounts fresh, then it stays hidden', () => {
    // arrange — simulate the dismissal a prior session already wrote
    localStorage.setItem(DISMISS_KEY, String(Date.now() + 3 * 24 * 60 * 60 * 1000))
    setPermission('denied')

    // act
    render(<PushDeniedBanner />)

    // assert
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('given a prior dismissal window has expired, when the banner mounts fresh, then it shows again', () => {
    // arrange — a stale dismissal from more than 7 days ago
    localStorage.setItem(DISMISS_KEY, String(Date.now() - 1000))
    setPermission('denied')

    // act
    render(<PushDeniedBanner />)

    // assert
    expect(screen.getByRole('status')).toBeInTheDocument()
  })
})
