import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { BottomNav } from './BottomNav'

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <BottomNav />
    </MemoryRouter>,
  )
}

describe('BottomNav', () => {
  it('when rendered, then a nav landmark with "Bottom navigation" label is announced to screen readers (iter-338: BDD-lite migration on touch)', () => {
    // arrange
    renderAt('/live')

    // act / assert — without the aria-label the nav landmark gets
    // a generic "navigation" announcement; with it, screen readers
    // say "Bottom navigation". Pin so a future nav addition (top
    // bar) doesn't create ambiguous landmarks.
    expect(
      screen.getByRole('navigation', { name: /bottom navigation/i }),
    ).toBeInTheDocument()
  })

  it('when rendered, then exposes one link per configured tab (Playroom Modern Task 4: relabeled tabs — Home/Events/Faces/Settings; Review (Training) lives inside Faces)', () => {
    // arrange
    renderAt('/')

    // act
    const links = screen.getAllByRole('link')

    // assert: getAllByRole returns ALL links; if a future tab is
    // added or removed without updating this test it'll fail loudly.
    // Pin both the count and the labels so a rename also fires.
    expect(links).toHaveLength(4)
    expect(links.map((el) => el.textContent?.toLowerCase())).toEqual([
      expect.stringContaining('home'),
      expect.stringContaining('events'),
      expect.stringContaining('faces'),
      expect.stringContaining('settings'),
    ])
  })

  it('when rendered, then each link points to its own /tab path (iter-356.x; Playroom Modern Task 4 relabeled Watch->Home, History->Events, People->Faces)', () => {
    // arrange
    renderAt('/live')

    // act
    const hrefs = {
      home: screen.getByRole('link', { name: /home/i }).getAttribute('href'),
      events: screen.getByRole('link', { name: /events/i }).getAttribute('href'),
      faces: screen.getByRole('link', { name: /faces/i }).getAttribute('href'),
      settings: screen.getByRole('link', { name: /settings/i }).getAttribute('href'),
    }

    // assert
    expect(hrefs).toEqual({
      home: '/',
      events: '/events',
      faces: '/people',
      settings: '/settings',
    })
  })

  it('given the route matches /events, when BottomNav renders, then the Events link carries aria-current="page" (iter-338: pin via ARIA, not Tailwind class — same fix as iter-290 SideNav)', () => {
    // arrange
    renderAt('/events')

    // act / assert — pin via the semantic aria-current attribute
    // instead of a Tailwind class token (iter-290 SideNav comment:
    // a Tailwind rename would silently break the test without
    // breaking the user-visible UX). React Router's NavLink emits
    // aria-current="page" on the matching route; assistive tech
    // consumes that.
    expect(
      screen.getByRole('link', { name: /events/i }),
    ).toHaveAttribute('aria-current', 'page')
  })

  it('given the route is the Home tab, when BottomNav renders, then non-matching links do NOT carry aria-current="page" (iter-338; `end` matching keeps / from claiming every route)', () => {
    // arrange
    renderAt('/')

    // act / assert
    expect(
      screen.getByRole('link', { name: /settings/i }),
    ).not.toHaveAttribute('aria-current', 'page')
    expect(
      screen.getByRole('link', { name: /events/i }),
    ).not.toHaveAttribute('aria-current', 'page')
    expect(
      screen.getByRole('link', { name: /home/i }),
    ).toHaveAttribute('aria-current', 'page')
  })

  it('Given a notched landscape phone PWA, When BottomNav renders, Then the inner tab strip carries lateral safe-area-inset padding so no tab sits under the Dynamic Island or home-indicator (premium-launch slice — mobile-view-auditor A2)', () => {
    // arrange — Pre-fix the 5-tab `flex-1` distribution didn't
    // reserve room for the iPhone Dynamic Island (~47 px left) or
    // the home-indicator strip (~21 px right) in landscape PWA
    // standalone. The leftmost "Live" tab's icon + label sat
    // partially behind the Dynamic Island; the rightmost "Settings"
    // tab partially under the home indicator. The padding lives on
    // the INNER flex (not the outer <nav>, which is `inset-x-0`
    // so the surface still extends edge-to-edge) so the visual bg
    // continues under the safe-area while taps land in the safe
    // band.
    renderAt('/live')

    // act
    const links = screen.getAllByRole('link')
    // The shared parent of all tab links is the inner flex strip
    // that should carry the inset padding.
    const innerFlex = links[0].parentElement
    expect(innerFlex).not.toBeNull()

    // assert — read from the raw `style` attribute string. jsdom's
    // CSSStyleDeclaration interface drops bare `env()` values; the
    // `max(0px, env(...))` form is the canonical pattern used
    // across the project's safe-area-inset code (matches the
    // BottomNav `pb-[max(0px, calc(env(safe-area-inset-bottom)-14px))]`
    // shape from iter-356.66).
    const styleAttr = innerFlex!.getAttribute('style') ?? ''
    expect(styleAttr).toMatch(
      /padding-left:\s*max\(0px,\s*env\(safe-area-inset-left\)\)/,
    )
    expect(styleAttr).toMatch(
      /padding-right:\s*max\(0px,\s*env\(safe-area-inset-right\)\)/,
    )
  })
})
