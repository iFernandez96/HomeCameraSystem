import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

// SideRail reads the session for the avatar chip + sign-out button;
// a static authed user keeps the test about nav structure.
vi.mock('../lib/auth', () => ({
  useAuth: () => ({
    user: { username: 'alice', role: 'owner' },
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
  it('GIVEN the desktop rail WHEN it renders THEN it exposes all 5 destinations including Review (UI/UX overhaul 2026-07-07 NAV-1: the phone BottomNav dropped to 4 in every orientation; the desktop rail DELIBERATELY keeps 5 — cross-device difference is fine, cross-orientation was the bug)', () => {
    // arrange / act
    renderRail()
    const links = screen.getAllByRole('link')

    // assert — pin count + destinations so a roster change here is a
    // conscious decision, not a side effect of a BottomNav edit (the
    // two used to share copy-pasted glyphs and drifted together).
    expect(links).toHaveLength(5)
    const hrefs = {
      home: screen.getByRole('link', { name: /home/i }).getAttribute('href'),
      events: screen.getByRole('link', { name: /events/i }).getAttribute('href'),
      faces: screen.getByRole('link', { name: /faces/i }).getAttribute('href'),
      review: screen.getByRole('link', { name: /review/i }).getAttribute('href'),
      settings: screen
        .getByRole('link', { name: /settings/i })
        .getAttribute('href'),
    }
    expect(hrefs).toEqual({
      home: '/',
      events: '/events',
      faces: '/people',
      review: '/training/review',
      settings: '/settings',
    })
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
