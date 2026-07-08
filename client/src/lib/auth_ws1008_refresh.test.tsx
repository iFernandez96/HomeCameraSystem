import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'

const showToast = vi.fn()
vi.mock('./toast', () => ({
  useToast: () => ({ showToast }),
  useReportError: () => (_event: string, message: string) =>
    showToast(message, 'error'),
}))

const warmWhepConnection = vi.fn().mockResolvedValue(undefined)
vi.mock('./webrtc', () => ({
  warmWhepConnection: () => warmWhepConnection(),
}))

vi.mock('./log', () => ({
  log: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
  errFields: (e: unknown) => ({ value: String(e) }),
}))

import { AuthProvider, useAuth } from './auth'

const expiredSignatureBody =
  'Signature has expired ... cookie_present=True'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function textResponse(body: string, status: number): Response {
  return new Response(body, { status })
}

function Probe() {
  const { state, user } = useAuth()
  return (
    <div>
      <span data-testid="state">{state}</span>
      <span data-testid="user">{user ? user.username : 'null'}</span>
    </div>
  )
}

function fetchPaths(): string[] {
  return vi
    .mocked(fetch)
    .mock.calls.map(([input]) =>
      typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url,
    )
}

describe('WS-1008 sign-out reproducer', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
    showToast.mockReset()
    warmWhepConnection.mockReset().mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('Given WS close-1008 after an expired access signature, When refresh succeeds, Then auth refreshes before anonymous state and Alice remains signed in', async () => {
    // arrange
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        jsonResponse({ user: { username: 'alice', role: 'admin' } }),
      )
      .mockResolvedValueOnce(textResponse(expiredSignatureBody, 401))
      .mockResolvedValueOnce(
        jsonResponse({ user: { username: 'alice', role: 'admin' } }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ user: { username: 'alice', role: 'admin' } }),
      )

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    )
    await waitFor(() =>
      expect(screen.getByTestId('state')).toHaveTextContent('authed'),
    )
    expect(screen.getByTestId('user')).toHaveTextContent('alice')

    // act
    await act(async () => {
      window.dispatchEvent(new CustomEvent('homecam:auth-failed'))
    })

    // assert
    await waitFor(() =>
      expect(fetchPaths()).toContain('/api/auth/refresh'),
    )

    const paths = fetchPaths()
    const secondMeIndex = paths.findIndex(
      (path, index) => index > 0 && path === '/api/auth/me',
    )
    const refreshIndex = paths.indexOf('/api/auth/refresh')

    expect(secondMeIndex).toBeGreaterThan(0)
    expect(refreshIndex).toBeGreaterThan(secondMeIndex)
    expect(paths.filter((path) => path === '/api/auth/refresh')).toHaveLength(1)
    expect(screen.getByTestId('state')).toHaveTextContent('authed')
    expect(screen.getByTestId('user')).toHaveTextContent('alice')
  })
})
