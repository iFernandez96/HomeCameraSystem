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

  it('GIVEN a phone in ANY orientation WHEN BottomNav renders THEN it exposes exactly the same 4 destinations — no orientation-only tabs (UI/UX overhaul 2026-07-07 NAV-1: rotating the phone must not change the information architecture; Review lives one tap inside Faces)', () => {
    // arrange
    renderAt('/')

    // act
    const links = screen.getAllByRole('link')

    // assert: getAllByRole returns ALL links; if a future tab is
    // added or removed without updating this test it'll fail loudly.
    // Pin both the count and the labels so a rename also fires.
    // The old `landscapeOnly` Review 5th tab is GONE — its
    // hidden/landscape-phone:flex conditional made landscape show 5
    // destinations while portrait showed 4 (device run-through #6).
    expect(links).toHaveLength(4)
    expect(links.map((el) => el.textContent?.toLowerCase())).toEqual([
      expect.stringContaining('home'),
      expect.stringContaining('events'),
      expect.stringContaining('faces'),
      expect.stringContaining('settings'),
    ])
    // No tab may be display-gated by orientation: `hidden` (with a
    // landscape-phone:flex re-show) was the mechanism — pin its
    // absence on every link. Whitespace-delimited match: a plain
    // \b boundary would false-positive on `overflow-hidden`.
    for (const link of links) {
      expect(link.className).not.toMatch(/(?:^|\s)hidden(?:\s|$)/)
    }
  })

  it('when rendered, then each link points to its own /tab path (iter-356.x; Playroom Modern Task 4 relabeled Watch->Home, History->Events, People->Faces; NAV-1 2026-07-07 dropped the landscapeOnly Review tab)', () => {
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

  it('Given an operator account, When BottomNav renders, Then advanced tools do not overload the four primary destinations', () => {
    renderAt('/')
    expect(screen.queryByRole('link', { name: /god view/i })).not.toBeInTheDocument()
    expect(screen.getAllByRole('link')).toHaveLength(4)
  })

  it('GIVEN the docked landscape-phone rail WHEN BottomNav renders THEN tab labels stay accessible but become visually hidden', () => {
    // arrange / act
    renderAt('/')
    const home = screen.getByRole('link', { name: /home/i })

    // assert — the label still gives the link its accessible name, but
    // landscape camera mode is icon-first visually.
    const label = home.querySelector('span:last-child') as HTMLElement | null
    expect(label).not.toBeNull()
    expect(label!.className).toMatch(/landscape-phone:sr-only/)
    expect(home.className).toMatch(/landscape-phone:min-h-11/)
    expect(screen.getByRole('navigation', { name: /bottom navigation/i }).className).toMatch(
      /landscape-phone:w-12/,
    )
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

  it('Given BottomNav renders, Then the inner tab strip uses the responsive safe-area class rather than inline padding that clips the landscape rail', () => {
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

    // assert — this class owns safe-area padding in CSS, where the
    // landscape-phone media query can turn it off for the vertical
    // rail. Inline padding cannot be media-query overridden and was
    // clipping the rail icons in the native WebView.
    expect(innerFlex!.className).toMatch(/bottomnav-inner/)
    expect(innerFlex!.getAttribute('style')).toBeNull()
  })

  it('GIVEN the nav renders WHEN in landscape-phone THEN it carries the left-rail dock classes instead of only bottom-pebble ones (landscape pass Task 1)', () => {
    // arrange / act — real-device screenshots (Galaxy S24 Ultra
    // landscape, below `lg:`) showed the floating pebble bar
    // rendering mid-viewport on top of content. The fix docks it as
    // a left rail via the `landscape-phone:` custom variant; pin the
    // class shape so a future edit can't silently drop it.
    renderAt('/')
    const nav = screen.getByRole('navigation', { name: /bottom navigation/i })

    // assert
    expect(nav.className).toMatch(/landscape-phone:left-0/)
    expect(nav.className).toMatch(/landscape-phone:w-12/)
    expect(nav.className).toMatch(/landscape-phone:top-0/)
  })
})
