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

  it('when rendered, then exposes one link per configured tab (iter-326: four tabs after People landed)', () => {
    // arrange
    renderAt('/live')

    // act
    const links = screen.getAllByRole('link')

    // assert: getAllByRole returns ALL links; if a future tab is
    // added or removed without updating this test it'll fail loudly.
    // Pin both the count and the labels so a rename also fires.
    expect(links).toHaveLength(4)
    expect(links.map((el) => el.textContent?.toLowerCase())).toEqual([
      expect.stringContaining('live'),
      expect.stringContaining('events'),
      expect.stringContaining('people'),
      expect.stringContaining('settings'),
    ])
  })

  it('when rendered, then each link points to its own /tab path (iter-326)', () => {
    // arrange
    renderAt('/live')

    // act
    const hrefs = {
      live: screen.getByRole('link', { name: /live/i }).getAttribute('href'),
      events: screen.getByRole('link', { name: /events/i }).getAttribute('href'),
      people: screen.getByRole('link', { name: /people/i }).getAttribute('href'),
      settings: screen.getByRole('link', { name: /settings/i }).getAttribute('href'),
    }

    // assert
    expect(hrefs).toEqual({
      live: '/live',
      events: '/events',
      people: '/people',
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

  it('given the route is /live, when BottomNav renders, then non-matching links do NOT carry aria-current="page" (iter-338)', () => {
    // arrange
    renderAt('/live')

    // act / assert
    expect(
      screen.getByRole('link', { name: /settings/i }),
    ).not.toHaveAttribute('aria-current', 'page')
    expect(
      screen.getByRole('link', { name: /events/i }),
    ).not.toHaveAttribute('aria-current', 'page')
  })
})
