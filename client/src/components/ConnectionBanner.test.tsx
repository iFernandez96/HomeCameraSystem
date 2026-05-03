import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

const subscribeWsState = vi.fn()
const reconnectIfClosed = vi.fn()

vi.mock('../lib/ws', () => ({
  subscribeWsState: (cb: (s: string) => void) => subscribeWsState(cb),
  reconnectIfClosed: () => reconnectIfClosed(),
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
    _authState = 'authed'
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
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

  it('shows a disconnected banner with retry hint when closed', () => {
    subscribeWsState.mockImplementation((cb) => {
      cb('closed')
      return () => {}
    })
    render(<ConnectionBanner />)
    expect(screen.getByRole('status')).toHaveTextContent(/disconnected — retrying/i)
  })

  it('updates when the WS state transitions', () => {
    let push: (s: string) => void = () => {}
    subscribeWsState.mockImplementation((cb) => {
      push = cb
      cb('connecting')
      return () => {}
    })
    const { rerender } = render(<ConnectionBanner />)
    expect(screen.getByRole('status')).toHaveTextContent(/connecting/i)
    push('open')
    rerender(<ConnectionBanner />)
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    push('closed')
    rerender(<ConnectionBanner />)
    expect(screen.getByRole('status')).toHaveTextContent(/disconnected/i)
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
