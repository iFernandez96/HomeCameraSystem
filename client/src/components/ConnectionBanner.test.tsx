import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'

const subscribeWsState = vi.fn()
const reconnectIfClosed = vi.fn()
const probeJetsonHealth = vi.fn()

vi.mock('../lib/ws', () => ({
  subscribeWsState: (cb: (s: string) => void) => subscribeWsState(cb),
  reconnectIfClosed: () => reconnectIfClosed(),
}))

vi.mock('../lib/jetsonHealth', () => ({
  probeJetsonHealth: () => probeJetsonHealth(),
}))

// iter-182: ConnectionBanner consumes useAuth() to hide the banner
// while the user is on /login (state !== 'authed'). Default the mock
// to 'authed' so the existing tests in this file see the banner just
// as they always did pre-iter-182. The auth-aware hiding is pinned by
// a dedicated test below.
let _authState: 'loading' | 'authed' | 'anon' = 'authed'
vi.mock('../lib/auth', () => ({
  useAuth: () => ({
    state: _authState,
    user: null,
    login: vi.fn(),
    logout: vi.fn(),
  }),
}))

import { ConnectionBanner } from './ConnectionBanner'

describe('ConnectionBanner', () => {
  beforeEach(() => {
    subscribeWsState.mockReset()
    reconnectIfClosed.mockReset()
    probeJetsonHealth.mockReset().mockResolvedValue(true)
    _authState = 'authed'
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    })
    Object.defineProperty(window.navigator, 'onLine', {
      configurable: true,
      value: true,
    })
  })
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('renders nothing when the socket is open', () => {
    subscribeWsState.mockImplementation((cb) => {
      cb('open')
      return () => {}
    })
    const { container } = render(<ConnectionBanner />)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows a connecting banner during initial connect', () => {
    subscribeWsState.mockImplementation((cb) => {
      cb('connecting')
      return () => {}
    })
    render(<ConnectionBanner />)
    expect(screen.getByRole('status')).toHaveTextContent(/connecting to camera/i)
  })

  it('Given the socket goes closed past the post-auth grace, When the first 10 s have not yet elapsed, Then a soft amber "Trying to reconnect" status is announced via role="status" (premium-launch slice)', () => {
    // arrange — premium-launch slice tightened ConnectionBanner
    // cadence: amber for the first ESCALATE_AFTER_MS (10 s) of
    // sustained closed, red role="alert" only after sustained
    // outage. Grace period swallows the first 2 s on cold load.
    vi.useFakeTimers()
    try {
      subscribeWsState.mockImplementation((cb) => {
        cb('closed')
        return () => {}
      })

      // act
      render(<ConnectionBanner />)
      act(() => {
        vi.advanceTimersByTime(2_100) // past grace, well before escalation
      })

      // assert — soft state is polite role="status", not alert.
      expect(screen.getByRole('status')).toHaveTextContent(/trying to reconnect/i)
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('Given the socket stays closed past the escalation window, When the user lingers on a sustained outage, Then the banner escalates to a red role="alert" with plain-English copy (premium-launch slice)', () => {
    // arrange
    vi.useFakeTimers()
    try {
      subscribeWsState.mockImplementation((cb) => {
        cb('closed')
        return () => {}
      })

      // act — past grace AND past the 10-s escalation timer.
      render(<ConnectionBanner />)
      act(() => {
        vi.advanceTimersByTime(13_000)
      })

      // assert — red alert, plain-English copy that explains what
      // still works (Frank E1: "I don't know what 'Realtime' means").
      const alert = screen.getByRole('alert')
      expect(alert).toHaveTextContent(/live alerts paused/i)
      expect(alert).toHaveTextContent(/past events still work/i)
      // role="alert" implies aria-live="assertive" — explicit attr
      // would double-up the announcement.
      expect(alert.getAttribute('aria-live')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('Given health checks fail twice while the phone has network, Then the banner says the Jetson is offline or unreachable', async () => {
    vi.useFakeTimers()
    try {
      Object.defineProperty(window.navigator, 'onLine', {
        configurable: true,
        value: true,
      })
      probeJetsonHealth.mockResolvedValue(false)
      subscribeWsState.mockImplementation((cb) => {
        cb('closed')
        return () => {}
      })

      render(<ConnectionBanner />)
      await act(async () => {
        vi.advanceTimersByTime(7_100)
        await Promise.resolve()
      })

      const alert = screen.getByRole('alert')
      expect(alert).toHaveTextContent(/jetson offline or unreachable/i)
      expect(alert).toHaveTextContent(/past events are unavailable/i)
      expect(alert).not.toHaveTextContent(/past events still work/i)
    } finally {
      vi.useRealTimers()
    }
  })

  it('Given Android has no network, Then the banner blames the phone connection rather than the Jetson', () => {
    vi.useFakeTimers()
    try {
      Object.defineProperty(window.navigator, 'onLine', {
        configurable: true,
        value: false,
      })
      subscribeWsState.mockImplementation((cb) => {
        cb('closed')
        return () => {}
      })

      render(<ConnectionBanner />)
      act(() => vi.advanceTimersByTime(2_100))

      expect(screen.getByRole('alert')).toHaveTextContent(/this phone is offline/i)
      expect(screen.queryByText(/jetson offline/i)).not.toBeInTheDocument()
      expect(probeJetsonHealth).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('Given a real outage was visible to the user, When the socket recovers to open, Then a brief success "Reconnected" status is announced before the banner unmounts (Dana #4 critical)', () => {
    // arrange — Dana #4: pre-fix the recovery was silent because
    // the alerting node simply unmounted. Sighted users saw the red
    // banner vanish; SR users were left thinking the outage
    // continued. Now the banner briefly renders a green
    // "Reconnected" status, then unmounts on its own.
    vi.useFakeTimers()
    try {
      let push: (s: string) => void = () => {}
      subscribeWsState.mockImplementation((cb) => {
        push = cb
        cb('closed')
        return () => {}
      })

      const { container } = render(<ConnectionBanner />)
      // Render the soft outage first so `outageShown` flips true.
      act(() => {
        vi.advanceTimersByTime(2_100)
      })
      expect(screen.getByText(/trying to reconnect/i)).toBeInTheDocument()

      // act — socket recovers.
      act(() => {
        push('open')
      })

      // assert — recovered status is rendered, then auto-clears.
      expect(screen.getByRole('status')).toHaveTextContent(/reconnected/i)
      act(() => {
        vi.advanceTimersByTime(2_000) // past RECOVERY_LINGER_MS (1.8 s)
      })
      expect(container).toBeEmptyDOMElement()
    } finally {
      vi.useRealTimers()
    }
  })

  it('Given the socket only ever flickered through connecting → open, When auth resolves, Then no green Reconnected banner appears (no spurious success on healthy cold-load)', () => {
    // arrange — the recovery announcement should only fire if the
    // user was actually exposed to a real outage banner. A normal
    // cold-load (connecting → open) shouldn't celebrate.
    vi.useFakeTimers()
    try {
      let push: (s: string) => void = () => {}
      subscribeWsState.mockImplementation((cb) => {
        push = cb
        cb('connecting')
        return () => {}
      })

      // act
      const { container } = render(<ConnectionBanner />)
      act(() => {
        push('open')
      })

      // assert — no Reconnected banner, just nothing.
      expect(container).toBeEmptyDOMElement()
    } finally {
      vi.useRealTimers()
    }
  })

  it('renders nothing during the post-auth grace window', () => {
    // arrange — grace window swallows the first ~2 s of closed so a
    // cold-load handshake doesn't flash the outage banner.
    vi.useFakeTimers()
    try {
      subscribeWsState.mockImplementation((cb) => {
        cb('closed')
        return () => {}
      })

      // act + assert — at 1.5 s post-mount, still inside grace, no
      // banner.
      const { container } = render(<ConnectionBanner />)
      act(() => {
        vi.advanceTimersByTime(1_500)
      })
      expect(container).toBeEmptyDOMElement()
    } finally {
      vi.useRealTimers()
    }
  })

  it('forces a WS reconnect when the tab returns to visible (iter-158)', () => {
    subscribeWsState.mockImplementation(() => () => {})
    render(<ConnectionBanner />)
    expect(reconnectIfClosed).not.toHaveBeenCalled()
    document.dispatchEvent(new Event('visibilitychange'))
    expect(reconnectIfClosed).toHaveBeenCalledTimes(1)
  })

  it('does not reconnect when the tab transitions to hidden (iter-158)', () => {
    subscribeWsState.mockImplementation(() => () => {})
    render(<ConnectionBanner />)
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'hidden',
    })
    document.dispatchEvent(new Event('visibilitychange'))
    expect(reconnectIfClosed).not.toHaveBeenCalled()
  })

  it('hides the banner while auth state is anon (iter-182)', () => {
    // /login page — no WS would attach, so a "disconnected" banner
    // would just be misleading.
    _authState = 'anon'
    subscribeWsState.mockImplementation((cb) => {
      cb('closed')
      return () => {}
    })
    const { container } = render(<ConnectionBanner />)
    expect(container).toBeEmptyDOMElement()
  })

  it('hides the banner while auth state is loading (iter-182)', () => {
    _authState = 'loading'
    subscribeWsState.mockImplementation((cb) => {
      cb('closed')
      return () => {}
    })
    const { container } = render(<ConnectionBanner />)
    expect(container).toBeEmptyDOMElement()
  })
})
