import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { SideNav } from './SideNav'

// iter-281 (test-coverage gap): SideNav was untested since iter-261.
// BDD-lite covers: nav landmark, tab labels, signed-in chip, sign-
// out button, owner / family / viewer parity (no role gating yet —
// nav is identical for all authed users).

const _logout = vi.fn()
let _authUser: { username: string; role: string } | null = {
  username: 'alice',
  role: 'admin',
}

vi.mock('../lib/auth', () => ({
  useAuth: () => ({
    state: 'authed',
    user: _authUser,
    login: vi.fn(),
    logout: () => _logout(),
  }),
}))

function renderSideNav() {
  return render(
    <MemoryRouter initialEntries={['/live']}>
      <SideNav />
    </MemoryRouter>,
  )
}

describe('SideNav', () => {
  it('given an authed user, when SideNav renders, then a nav landmark with Main navigation label is present', () => {
    // arrange
    _authUser = { username: 'alice', role: 'admin' }

    // act
    renderSideNav()

    // assert
    expect(
      screen.getByRole('navigation', { name: /main navigation/i }),
    ).toBeInTheDocument()
  })

  it('given an authed user, when SideNav renders, then Live, Events, People, and Settings nav links are visible (iter-326: People landed)', () => {
    // arrange
    _authUser = { username: 'alice', role: 'admin' }

    // act
    renderSideNav()

    // assert
    expect(screen.getByRole('link', { name: /live/i })).toBeInTheDocument()
    expect(
      screen.getByRole('link', { name: /events/i }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('link', { name: /people/i }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('link', { name: /settings/i }),
    ).toBeInTheDocument()
  })

  it('given an authed user, when SideNav renders, then the username appears in the signed-in chip', () => {
    // arrange
    _authUser = { username: 'babage', role: 'family' }

    // act
    renderSideNav()

    // assert: pinned at the top so the user knows which account
    // they're operating as. iter-261 added this row.
    expect(screen.getByText(/babage/i)).toBeInTheDocument()
  })

  it('given the user clicks Sign out, when the click handler fires, then useAuth().logout is invoked', async () => {
    // arrange
    _authUser = { username: 'alice', role: 'admin' }
    _logout.mockClear()

    // act
    renderSideNav()
    screen.getByRole('button', { name: /sign out/i }).click()

    // assert
    expect(_logout).toHaveBeenCalledTimes(1)
  })

  it('given an anonymous (no user) state, when SideNav renders, then the signed-in chip and sign-out button are absent', () => {
    // arrange: in practice the AuthProvider redirects anon users
    // to /login before SideNav renders, but pin the defensive
    // rendering so a guard regression doesn't crash the tree.
    _authUser = null

    // act
    renderSideNav()

    // assert
    expect(
      screen.queryByText(/signed in as/i),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: /sign out/i }),
    ).not.toBeInTheDocument()
    // Nav links remain — they're the navigation rail.
    expect(screen.getByRole('link', { name: /live/i })).toBeInTheDocument()
  })

  // iter-290 (test-integrity-auditor #3): pin the active-route
  // contract via aria-current="page" instead of `bg-neutral-800`
  // (which was an implementation token — a Tailwind rename
  // would break the test without breaking the user-visible UX).
  // React Router's NavLink emits aria-current="page" on the
  // matching route; assistive tech consumes that. The visual
  // styling is a side-effect of `isActive` and remains free to
  // evolve.
  it('given the user is on /live, when SideNav renders, then the Live link carries aria-current="page" and others do not', () => {
    // arrange
    _authUser = { username: 'alice', role: 'admin' }

    // act
    render(
      <MemoryRouter initialEntries={['/live']}>
        <SideNav />
      </MemoryRouter>,
    )

    // assert
    const liveLink = screen.getByRole('link', { name: /live/i })
    const eventsLink = screen.getByRole('link', { name: /events/i })
    const settingsLink = screen.getByRole('link', { name: /settings/i })
    expect(liveLink).toHaveAttribute('aria-current', 'page')
    expect(eventsLink).not.toHaveAttribute('aria-current', 'page')
    expect(settingsLink).not.toHaveAttribute('aria-current', 'page')
  })
})
