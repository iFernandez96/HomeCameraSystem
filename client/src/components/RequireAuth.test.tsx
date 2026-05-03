import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

let _authState: 'loading' | 'authed' | 'anon' = 'authed'
vi.mock('../lib/auth', () => ({
  useAuth: () => ({
    state: _authState,
    user: _authState === 'authed' ? { username: 'alice', role: 'admin' } : null,
    login: vi.fn(),
    logout: vi.fn(),
  }),
}))

import { RequireAuth } from './RequireAuth'

function renderWithRoutes(initialPath = '/protected') {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route
          path="/protected"
          element={
            <RequireAuth>
              <div data-testid="protected">secret content</div>
            </RequireAuth>
          }
        />
        <Route path="/login" element={<div data-testid="login">login page</div>} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('RequireAuth', () => {
  it('renders the children when the user is authed', () => {
    _authState = 'authed'
    renderWithRoutes()
    expect(screen.getByTestId('protected')).toBeInTheDocument()
    expect(screen.queryByTestId('login')).not.toBeInTheDocument()
  })

  it('renders the Live-shaped skeleton while auth state is still loading (iter-356.20 Maya 14th CRITICAL #1)', () => {
    _authState = 'loading'
    renderWithRoutes()
    // iter-356.20: pre-iter-356.20 RequireAuth returned `null` while
    // auth resolved → cold-load FOUC: navbar → empty <main> → spinner
    // → empty → video. Now: a Live-shaped skeleton with role=status
    // + aria-label=Loading camera + aria-busy=true paints immediately
    // so the user sees the page-to-be settling.
    expect(screen.queryByTestId('protected')).not.toBeInTheDocument()
    expect(screen.queryByTestId('login')).not.toBeInTheDocument()
    const skeleton = screen.getByRole('status', { name: /loading camera/i })
    expect(skeleton).toBeInTheDocument()
    expect(skeleton).toHaveAttribute('aria-busy', 'true')
  })

  it('redirects to /login when the user is anonymous', () => {
    _authState = 'anon'
    renderWithRoutes()
    expect(screen.queryByTestId('protected')).not.toBeInTheDocument()
    expect(screen.getByTestId('login')).toBeInTheDocument()
  })
})
