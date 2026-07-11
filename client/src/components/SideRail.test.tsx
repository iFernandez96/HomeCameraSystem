import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

// SideRail reads the session for the avatar chip + sign-out button;
// a static authed user keeps the test about nav structure.
let authUser: { username: string; role: string } = { username: 'alice', role: 'viewer' }

vi.mock('../lib/auth', () => ({
  useAuth: () => ({
    user: authUser,
    logout: vi.fn(),
  }),
}))

import { SideRail } from './SideRail'

function renderRail() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <SideRail />
    </MemoryRouter>,
  )
}

describe('SideRail', () => {
  beforeEach(() => {
    authUser = { username: 'alice', role: 'viewer' }
  })

  it('GIVEN the desktop rail WHEN it renders THEN it exposes all 6 destinations including Review and Playground (NAV-1 2026-07-07: the phone BottomNav stays at 4 in every orientation; Playground Slice A is desktop-rail-only — see the width-math note in BottomNav.tsx)', () => {
    // arrange / act
    renderRail()
    const links = screen.getAllByRole('link')

    // assert — pin count + destinations so a roster change here is a
    // conscious decision, not a side effect of a BottomNav edit (the
    // two used to share copy-pasted glyphs and drifted together).
    expect(links).toHaveLength(6)
    const hrefs = {
      home: screen.getByRole('link', { name: /home/i }).getAttribute('href'),
      events: screen.getByRole('link', { name: /events/i }).getAttribute('href'),
      faces: screen.getByRole('link', { name: /faces/i }).getAttribute('href'),
      review: screen.getByRole('link', { name: /review/i }).getAttribute('href'),
      playground: screen
        .getByRole('link', { name: /playground/i })
        .getAttribute('href'),
      settings: screen
        .getByRole('link', { name: /settings/i })
        .getAttribute('href'),
    }
    expect(hrefs).toEqual({
      home: '/',
      events: '/events',
      faces: '/people',
      review: '/training/review',
      playground: '/playground',
      settings: '/settings',
    })
  })

  it('Given the admin operator account, When SideRail renders, Then God View is visible', () => {
    // arrange
    authUser = { username: 'admin', role: 'admin' }

    // act
    renderRail()

    // assert
    expect(screen.getByRole('link', { name: /god view/i })).toHaveAttribute('href', '/god')
  })

  it('Given another owner account, When SideRail renders, Then God View is undiscoverable', () => {
    authUser = { username: 'not-admin', role: 'owner' }
    renderRail()
    expect(screen.queryByRole('link', { name: /god view/i })).not.toBeInTheDocument()
  })

  it('GIVEN the rail renders WHEN screen readers walk the landmarks THEN a "Main navigation" nav landmark is announced and every icon is aria-hidden (shared NavIcons module keeps the Dana #2 treatment on both nav surfaces)', () => {
    // arrange / act
    const { container } = renderRail()

    // assert
    expect(
      screen.getByRole('navigation', { name: /main navigation/i }),
    ).toBeInTheDocument()
    const svgs = Array.from(container.querySelectorAll('svg'))
    expect(svgs.length).toBeGreaterThan(0)
    for (const svg of svgs) {
      expect(svg.getAttribute('aria-hidden')).toBe('true')
    }
  })
})
