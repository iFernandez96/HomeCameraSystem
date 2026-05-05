import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

// iter-356.63 (Slice D a11y): WatchRibbon is the persistent top bar
// across every authed route. Its center cluster shows armed-state +
// camera-name + last-frame-age. Pre-iter-356.63 the WHOLE wrapper
// was role="status" aria-live="polite", which meant every 5 s
// status poll re-announced the entire cluster ("On watch · Front
// Door · 4s ago" → "On watch · Front Door · 5s ago"). Now the
// live-region scope is reduced to just the armed-state pill.

const useStatusMock = vi.fn()
vi.mock('../lib/useStatus', () => ({
  useStatus: () => useStatusMock(),
}))

import { WatchRibbon } from './WatchRibbon'

function renderRibbon() {
  return render(
    <MemoryRouter>
      <WatchRibbon />
    </MemoryRouter>,
  )
}

describe('WatchRibbon a11y', () => {
  beforeEach(() => {
    useStatusMock.mockReset()
    useStatusMock.mockReturnValue({
      detection_active: true,
      worker_alive: true,
      camera_label: 'Front Door',
      seconds_since_last_frame: 4,
    })
  })
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('given the ribbon renders, when AT users find the live region, then it scopes to the armed-state pill (NOT the wrapper) so the camera-name and frame-age do not re-announce on every status poll (iter-356.63)', () => {
    // arrange / act
    renderRibbon()

    // assert — the live region is the small "On watch" pill, not
    // the cluster wrapper. The pill's text content is just the
    // state label.
    const live = screen.getByRole('status')
    expect(live.textContent?.trim()).toBe('On watch')
    // Sanity: the camera label is NOT inside the live region's
    // subtree (it's a sibling). Pre-fix it was a descendant.
    expect(live.querySelector('span')).toBeNull()
    expect(live.textContent).not.toMatch(/front door/i)
  })

  it('given offline status, when the ribbon renders, then the status pill announces "Camera offline" (iter-356.63: scope still works post-state-change)', () => {
    // arrange
    useStatusMock.mockReturnValue({
      detection_active: false,
      worker_alive: false,
      camera_label: 'Front Door',
      seconds_since_last_frame: 30,
    })

    // act
    renderRibbon()

    // assert
    expect(screen.getByRole('status').textContent).toMatch(/camera offline/i)
  })

  it('Given a notched landscape iPhone PWA, When the ribbon renders, Then it carries lateral safe-area-inset padding so the armed-state cluster never sits behind the Dynamic Island (premium-launch slice — mobile-view-auditor A1)', () => {
    // arrange — Pre-fix the ribbon set `paddingTop` for the notch
    // but had no `safe-area-inset-left/right`. In landscape on a
    // notched iPhone the Dynamic Island clips ~47 px from the left
    // and the home-indicator strip clips ~21 px from the right;
    // the armed-state dot + label (the most load-bearing security
    // signal in the app) was partially clipped. Pin the inline
    // style so a future drive-by edit can't silently regress.
    renderRibbon()

    // act
    const banner = screen.getByRole('banner')

    // assert — read from the raw `style` attribute. jsdom's
    // CSSStyleDeclaration interface drops or partially preserves
    // modern CSS functions; `el.style.paddingLeft` reads as an
    // empty string even when the attribute string contains the
    // full `max(env(...))` value. Asserting on the attribute
    // string sidesteps that. (We don't pin `padding-top:
    // env(safe-area-inset-top)` here — jsdom drops the bare-env()
    // shorthand from the serialized style attribute when React
    // sets it alongside the max(env()) values; the prior iter-
    // 356.x notch-top behavior is unchanged in production but
    // unobservable in this test environment.)
    const styleAttr = banner.getAttribute('style') ?? ''
    expect(styleAttr).toMatch(
      /padding-left:\s*max\(1rem,\s*env\(safe-area-inset-left\)\)/,
    )
    expect(styleAttr).toMatch(
      /padding-right:\s*max\(1rem,\s*env\(safe-area-inset-right\)\)/,
    )
  })
})
