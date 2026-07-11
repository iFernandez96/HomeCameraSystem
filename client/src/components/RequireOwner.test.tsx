import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

let authState: 'loading' | 'authed' | 'anon' = 'authed'
let authUser: { username: string; role: string } | null = {
  username: 'owner-user',
  role: 'owner',
}

vi.mock('../lib/auth', () => ({
  useAuth: () => ({ state: authState, user: authUser }),
}))

import { RequireOwner } from './RequireOwner'

function renderGuard() {
  return render(
    <MemoryRouter initialEntries={['/settings/exposure']}>
      <Routes>
        <Route
          path="/settings/exposure"
          element={
            <RequireOwner>
              <p>Exposure controls</p>
            </RequireOwner>
          }
        />
        <Route path="/settings" element={<p>Settings page</p>} />
        <Route path="/login" element={<p>Login page</p>} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('RequireOwner', () => {
  beforeEach(() => {
    authState = 'authed'
    authUser = { username: 'owner-user', role: 'owner' }
  })

  it('renders owner-only controls for owner-equivalent accounts', () => {
    renderGuard()
    expect(screen.getByText('Exposure controls')).toBeInTheDocument()
  })

  it('redirects a viewer away from owner-only controls', () => {
    authUser = { username: 'family-user', role: 'viewer' }
    renderGuard()
    expect(screen.getByText('Settings page')).toBeInTheDocument()
    expect(screen.queryByText('Exposure controls')).not.toBeInTheDocument()
  })

  it('redirects an anonymous visitor to login', () => {
    authState = 'anon'
    authUser = null
    renderGuard()
    expect(screen.getByText('Login page')).toBeInTheDocument()
  })
})
