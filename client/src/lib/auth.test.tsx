import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'

const getMe = vi.fn()
const apiLogin = vi.fn()
const apiLogout = vi.fn()

vi.mock('./api', async () => {
  const actual = await vi.importActual<typeof import('./api')>('./api')
  return {
    ...actual,
    getMe: () => getMe(),
    login: (...args: Parameters<typeof actual.login>) => apiLogin(...args),
    logout: () => apiLogout(),
  }
})

// iter-186: AuthProvider consumes useToast() for the session-expired
// flow. Mock at module level so the dedupe test can assert call count.
const showToast = vi.fn()
vi.mock('./toast', () => ({
  useToast: () => ({ showToast }),
}))

// Premium-launch slice (WHEP warmup auth boundary): AuthProvider now
// imports warmWhepConnection from ./webrtc and fires it on the
// loading→authed transition. Mock at module level so we can pin the
// "fires only when authed" contract that protects the auth boundary.
const warmWhepConnection = vi.fn().mockResolvedValue(undefined)
vi.mock('./webrtc', () => ({
  warmWhepConnection: () => warmWhepConnection(),
}))

import { HttpError } from './api'
import { AuthProvider, useAuth } from './auth'

function Probe() {
  const { state, user } = useAuth()
  return (
    <div>
      <span data-testid="state">{state}</span>
      <span data-testid="user">{user ? user.username : 'null'}</span>
    </div>
  )
}

describe('AuthProvider', () => {
  beforeEach(() => {
    getMe.mockReset()
    apiLogin.mockReset()
    apiLogout.mockReset()
    showToast.mockReset()
    warmWhepConnection.mockReset().mockResolvedValue(undefined)
  })
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('starts in loading state and flips to authed on /me 200', async () => {
    getMe.mockResolvedValueOnce({ user: { username: 'alice', role: 'admin' } })
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    )
    expect(screen.getByTestId('state')).toHaveTextContent('loading')
    await waitFor(() => {
      expect(screen.getByTestId('state')).toHaveTextContent('authed')
    })
    expect(screen.getByTestId('user')).toHaveTextContent('alice')
  })

  it('flips to anon on /me 401', async () => {
    getMe.mockRejectedValueOnce(new HttpError('/api/auth/me', 401, ''))
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    )
    await waitFor(() => {
      expect(screen.getByTestId('state')).toHaveTextContent('anon')
    })
    expect(screen.getByTestId('user')).toHaveTextContent('null')
  })

  it('flips to anon on a network error too (defensive)', async () => {
    getMe.mockRejectedValueOnce(new Error('network down'))
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    )
    await waitFor(() => {
      expect(screen.getByTestId('state')).toHaveTextContent('anon')
    })
  })

  it('login() calls api.login and flips to authed', async () => {
    getMe.mockRejectedValueOnce(new HttpError('/api/auth/me', 401, ''))
    apiLogin.mockResolvedValueOnce({
      user: { username: 'alice', role: 'admin' },
    })

    function LoginProbe() {
      const { state, login } = useAuth()
      return (
        <div>
          <span data-testid="state">{state}</span>
          <button onClick={() => login('alice', 'hunter2')}>do-login</button>
        </div>
      )
    }

    render(
      <AuthProvider>
        <LoginProbe />
      </AuthProvider>,
    )
    await waitFor(() =>
      expect(screen.getByTestId('state')).toHaveTextContent('anon'),
    )
    await act(async () => {
      screen.getByText('do-login').click()
    })
    expect(apiLogin).toHaveBeenCalledWith({
      username: 'alice',
      password: 'hunter2',
    })
    await waitFor(() =>
      expect(screen.getByTestId('state')).toHaveTextContent('authed'),
    )
  })

  it('logout() clears state even if the network call fails', async () => {
    getMe.mockResolvedValueOnce({ user: { username: 'alice', role: 'admin' } })
    apiLogout.mockRejectedValueOnce(new Error('disconnected'))

    function LogoutProbe() {
      const { state, logout } = useAuth()
      return (
        <div>
          <span data-testid="state">{state}</span>
          <button onClick={() => logout()}>do-logout</button>
        </div>
      )
    }

    render(
      <AuthProvider>
        <LogoutProbe />
      </AuthProvider>,
    )
    await waitFor(() =>
      expect(screen.getByTestId('state')).toHaveTextContent('authed'),
    )
    await act(async () => {
      screen.getByText('do-logout').click()
    })
    await waitFor(() =>
      expect(screen.getByTestId('state')).toHaveTextContent('anon'),
    )
  })

  it('useAuth throws when used outside a provider', () => {
    // Render a Probe with no <AuthProvider>; it should throw on
    // first render. Suppress the React error log so the test
    // output stays clean.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => render(<Probe />)).toThrow(/AuthProvider/)
    errSpy.mockRestore()
  })

  it('homecam:auth-failed event re-checks /me and flips to anon on 401 (iter-185)', async () => {
    // Initial /me 200 → authed.
    getMe.mockResolvedValueOnce({ user: { username: 'alice', role: 'admin' } })
    // Re-check after auth-failed event → 401 → anon.
    getMe.mockRejectedValueOnce(new HttpError('/api/auth/me', 401, ''))
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    )
    await waitFor(() =>
      expect(screen.getByTestId('state')).toHaveTextContent('authed'),
    )
    await act(async () => {
      window.dispatchEvent(new CustomEvent('homecam:auth-failed'))
    })
    await waitFor(() =>
      expect(screen.getByTestId('state')).toHaveTextContent('anon'),
    )
  })

  it('homecam:auth-failed event keeps authed if /me still 200s (iter-185)', async () => {
    // Initial /me 200 → authed. WS 1008 was probably an origin
    // mismatch, not auth — /me re-check still 200, stay authed.
    getMe.mockResolvedValueOnce({ user: { username: 'alice', role: 'admin' } })
    getMe.mockResolvedValueOnce({ user: { username: 'alice', role: 'admin' } })
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    )
    await waitFor(() =>
      expect(screen.getByTestId('state')).toHaveTextContent('authed'),
    )
    await act(async () => {
      window.dispatchEvent(new CustomEvent('homecam:auth-failed'))
    })
    // State stays 'authed'.
    expect(screen.getByTestId('state')).toHaveTextContent('authed')
    // /me was called twice: initial mount + re-check.
    expect(getMe).toHaveBeenCalledTimes(2)
  })

  it('homecam:session-expired event toasts and flips to anon (iter-186)', async () => {
    getMe.mockResolvedValueOnce({ user: { username: 'alice', role: 'admin' } })
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    )
    await waitFor(() =>
      expect(screen.getByTestId('state')).toHaveTextContent('authed'),
    )
    await act(async () => {
      window.dispatchEvent(new CustomEvent('homecam:session-expired'))
    })
    await waitFor(() =>
      expect(screen.getByTestId('state')).toHaveTextContent('anon'),
    )
    expect(showToast).toHaveBeenCalledWith('Session expired', 'error')
  })

  it('repeated homecam:session-expired events show only one toast (iter-186)', async () => {
    getMe.mockResolvedValueOnce({ user: { username: 'alice', role: 'admin' } })
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    )
    await waitFor(() =>
      expect(screen.getByTestId('state')).toHaveTextContent('authed'),
    )
    // Three rapid signals — only the first should toast (subsequent
    // calls find state already anon and short-circuit via the
    // functional setState dedupe).
    await act(async () => {
      window.dispatchEvent(new CustomEvent('homecam:session-expired'))
      window.dispatchEvent(new CustomEvent('homecam:session-expired'))
      window.dispatchEvent(new CustomEvent('homecam:session-expired'))
    })
    await waitFor(() =>
      expect(screen.getByTestId('state')).toHaveTextContent('anon'),
    )
    expect(showToast).toHaveBeenCalledTimes(1)
  })

  it('Given /me has not yet resolved, When AuthProvider mounts, Then warmWhepConnection is NOT called yet (auth-boundary safety: no WebRTC PC creation while state is loading)', async () => {
    // arrange — keep getMe pending forever. State stays 'loading'.
    getMe.mockReturnValueOnce(new Promise(() => {}))

    // act
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    )
    expect(screen.getByTestId('state')).toHaveTextContent('loading')

    // assert — warmup waits for state to flip to 'authed'.
    expect(warmWhepConnection).not.toHaveBeenCalled()
  })

  it('Given /me 401s, When auth flips to anon, Then warmWhepConnection is NOT called (auth-boundary safety: anon visitors get no warmup)', async () => {
    // arrange
    getMe.mockRejectedValueOnce(new HttpError('/api/auth/me', 401, ''))

    // act
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    )
    await waitFor(() =>
      expect(screen.getByTestId('state')).toHaveTextContent('anon'),
    )

    // assert — anon transition does NOT trigger warmup.
    expect(warmWhepConnection).not.toHaveBeenCalled()
  })

  it('Given /me returns 200, When auth flips to authed, Then warmWhepConnection fires exactly once (premium-launch slice: WHEP PC pre-creation overlapping the user navigating to Live)', async () => {
    // arrange
    getMe.mockResolvedValueOnce({ user: { username: 'alice', role: 'admin' } })

    // act
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    )
    await waitFor(() =>
      expect(screen.getByTestId('state')).toHaveTextContent('authed'),
    )

    // assert — fired once on the loading→authed transition.
    expect(warmWhepConnection).toHaveBeenCalledTimes(1)
  })

  it('Given a successful login, When apiLogin resolves and state flips to authed, Then warmWhepConnection fires (so the user navigating from /login to /live finds the PC primed)', async () => {
    // arrange
    getMe.mockRejectedValueOnce(new HttpError('/api/auth/me', 401, ''))
    apiLogin.mockResolvedValueOnce({
      user: { username: 'alice', role: 'admin' },
    })

    function LoginProbe() {
      const { state, login } = useAuth()
      return (
        <div>
          <span data-testid="state">{state}</span>
          <button onClick={() => login('alice', 'hunter2')}>do-login</button>
        </div>
      )
    }

    // act — first land anon, then submit login.
    render(
      <AuthProvider>
        <LoginProbe />
      </AuthProvider>,
    )
    await waitFor(() =>
      expect(screen.getByTestId('state')).toHaveTextContent('anon'),
    )
    expect(warmWhepConnection).not.toHaveBeenCalled()
    await act(async () => {
      screen.getByText('do-login').click()
    })
    await waitFor(() =>
      expect(screen.getByTestId('state')).toHaveTextContent('authed'),
    )

    // assert — warmup fires on the anon→authed transition.
    expect(warmWhepConnection).toHaveBeenCalledTimes(1)
  })

  it('Given warmWhepConnection rejects, When the rejection happens, Then AuthProvider does not crash (warmup is best-effort and failures are non-fatal)', async () => {
    // arrange
    warmWhepConnection.mockReset().mockRejectedValueOnce(new Error('mock RTC failure'))
    getMe.mockResolvedValueOnce({ user: { username: 'alice', role: 'admin' } })

    // act + assert — the unhandled rejection from a real-world
    // browser RTC failure must not propagate. The .catch() in
    // auth.tsx swallows it; auth still flips to authed.
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    )
    await waitFor(() =>
      expect(screen.getByTestId('state')).toHaveTextContent('authed'),
    )
    expect(warmWhepConnection).toHaveBeenCalledTimes(1)
  })
})
