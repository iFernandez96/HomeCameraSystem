import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { attachRipple, useRipple } from './ripple'

// jsdom has no matchMedia — install a controllable stub (theme.test.ts
// pattern). `reduced` drives the prefers-reduced-motion query result.
let reduced = false

function installMatchMedia() {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: query.includes('reduce') ? reduced : false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia
}

// jsdom returns an all-zero rect; stub a 100×40 host at the origin so
// the cover-the-farthest-corner geometry is assertable.
function makeHost(): HTMLElement {
  const el = document.createElement('button')
  el.getBoundingClientRect = () =>
    ({ left: 0, top: 0, right: 100, bottom: 40, width: 100, height: 40, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect
  document.body.appendChild(el)
  return el
}

beforeEach(() => {
  reduced = false
  installMatchMedia()
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  document.body.innerHTML = ''
})

describe('attachRipple', () => {
  it('Given a pointer-down at (25,20), When attached, Then an aria-hidden .hc-ripple span is appended, centered on the point and sized to cover the farthest corner', () => {
    // arrange
    const host = makeHost()

    // act
    attachRipple(host, { clientX: 25, clientY: 20 })

    // assert — farthest corner from (25,20) in a 100×40 host is
    // (100,0)/(100,40): radius = hypot(75,20); diameter = 2×radius.
    const ripple = host.querySelector<HTMLElement>('.hc-ripple')
    expect(ripple).not.toBeNull()
    expect(ripple!.getAttribute('aria-hidden')).toBe('true')
    const radius = Math.hypot(75, 20)
    expect(ripple!.style.width).toBe(`${radius * 2}px`)
    expect(ripple!.style.height).toBe(`${radius * 2}px`)
    expect(ripple!.style.left).toBe(`${25 - radius}px`)
    expect(ripple!.style.top).toBe(`${20 - radius}px`)
  })

  it('Given a spawned ripple, When the animation duration elapses, Then the span removes itself (setTimeout fallback — jsdom never fires animationend)', () => {
    // arrange
    const host = makeHost()
    attachRipple(host, { clientX: 10, clientY: 10 })
    expect(host.querySelector('.hc-ripple')).not.toBeNull()

    // act
    vi.advanceTimersByTime(600)

    // assert
    expect(host.querySelector('.hc-ripple')).toBeNull()
  })

  it('Given a spawned ripple, When animationend fires, Then the span is removed immediately (no double-remove crash when the timeout later fires)', () => {
    // arrange
    const host = makeHost()
    attachRipple(host, { clientX: 10, clientY: 10 })
    const ripple = host.querySelector('.hc-ripple')!

    // act
    ripple.dispatchEvent(new Event('animationend'))

    // assert — gone now, and the fallback timer is harmless.
    expect(host.querySelector('.hc-ripple')).toBeNull()
    expect(() => vi.advanceTimersByTime(600)).not.toThrow()
  })

  it('Given prefers-reduced-motion: reduce, When attached, Then NOTHING is appended (hard no-op)', () => {
    // arrange
    reduced = true
    const host = makeHost()

    // act
    attachRipple(host, { clientX: 10, clientY: 10 })

    // assert
    expect(host.querySelector('.hc-ripple')).toBeNull()
  })
})

describe('useRipple', () => {
  function fakeEvent(currentTarget: HTMLElement) {
    return {
      currentTarget,
      nativeEvent: { clientX: 5, clientY: 5 },
    } as unknown as ReactPointerEvent<HTMLElement>
  }

  it('Given no data-ripple-host child, When the handler fires, Then the ripple lands on the currentTarget itself', () => {
    // arrange
    const host = makeHost()
    const handler = useRipple()

    // act
    handler(fakeEvent(host))

    // assert
    expect(host.querySelector('.hc-ripple')).not.toBeNull()
  })

  it('Given a data-ripple-host overlay child, When the handler fires, Then the ripple lands INSIDE the overlay (so overflow-hidden can live there without clipping siblings like tooltips)', () => {
    // arrange
    const host = makeHost()
    const overlay = document.createElement('span')
    overlay.setAttribute('data-ripple-host', '')
    host.appendChild(overlay)
    const handler = useRipple()

    // act
    handler(fakeEvent(host))

    // assert
    expect(overlay.querySelector('.hc-ripple')).not.toBeNull()
    expect(host.querySelector(':scope > .hc-ripple')).toBeNull()
  })

  it('Given the handler identity, When called twice, Then it is stable (safe for deps arrays)', () => {
    // arrange / act / assert
    expect(useRipple()).toBe(useRipple())
  })
})
