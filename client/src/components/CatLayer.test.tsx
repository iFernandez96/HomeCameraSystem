import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render } from '@testing-library/react'
import { CatLayer } from './CatLayer'

type MqlInit = {
  matches: boolean
}

function stubMatchMedia({ matches }: MqlInit) {
  // Minimal MediaQueryList stub: only the surface CatLayer's
  // usePrefersReducedMotion hook touches (matches + addEventListener +
  // removeEventListener). The hook lazy-inits from `matches` at mount and
  // then subscribes to 'change' — neither path needs real timers.
  const mql = {
    matches,
    media: '(prefers-reduced-motion: reduce)',
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }
  window.matchMedia = vi.fn().mockReturnValue(mql) as unknown as typeof window.matchMedia
  return mql
}

describe('CatLayer', () => {
  let originalMatchMedia: typeof window.matchMedia | undefined

  beforeEach(() => {
    originalMatchMedia = window.matchMedia
  })

  afterEach(() => {
    if (originalMatchMedia) {
      window.matchMedia = originalMatchMedia
    } else {
      // jsdom doesn't ship matchMedia by default — drop our stub if there
      // was nothing here originally.
      delete (window as unknown as { matchMedia?: unknown }).matchMedia
    }
    vi.unstubAllGlobals()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('given prefers-reduced-motion is false, when the layer mounts and timers advance ~5s, then 3 cat sprites render', () => {
    // arrange
    stubMatchMedia({ matches: false })
    vi.useFakeTimers()
    // Drive the rAF loop off the fake clock so time control is deterministic.
    // The production code calls bare requestAnimationFrame / cancelAnimationFrame
    // (no window. prefix), so the stubs need to land on globalThis.
    const rafSpy = vi.fn((cb: FrameRequestCallback): number => {
      return setTimeout(() => cb(performance.now()), 16) as unknown as number
    })
    const cancelSpy = vi.fn((id: number) => clearTimeout(id as unknown as ReturnType<typeof setTimeout>))
    vi.stubGlobal('requestAnimationFrame', rafSpy)
    vi.stubGlobal('cancelAnimationFrame', cancelSpy)

    // act
    const { container } = render(<CatLayer />)
    act(() => {
      vi.advanceTimersByTime(5000)
    })

    // assert — three independent cat sprite SVGs are rendered. The layer
    // root is the first child of the container; each cat sprite is a
    // descendant <svg>. Mood emojis (when present) are <span>s, not SVGs.
    const layer = container.firstElementChild
    expect(layer).not.toBeNull()
    const svgs = layer!.querySelectorAll('svg')
    expect(svgs.length).toBe(3)
  })

  it('given prefers-reduced-motion is true, when the layer mounts, then it does not schedule any animation frame', () => {
    // arrange
    stubMatchMedia({ matches: true })
    const rafSpy = vi.fn((_cb: FrameRequestCallback): number => 0)
    vi.stubGlobal('requestAnimationFrame', rafSpy)

    // act
    render(<CatLayer />)

    // assert — the effect early-returns when reduced-motion matches, so
    // no rAF is ever queued. Cats render in their initial pose only.
    expect(rafSpy).not.toHaveBeenCalled()
  })

  it('when the layer mounts, then the root element is aria-hidden so screen readers skip it', () => {
    // arrange
    stubMatchMedia({ matches: true })

    // act
    const { container } = render(<CatLayer />)

    // assert
    const layer = container.firstElementChild as HTMLElement | null
    expect(layer).not.toBeNull()
    expect(layer!.getAttribute('aria-hidden')).toBe('true')
  })

  it('when the layer mounts, then it carries pointer-events:none so it does not intercept clicks', () => {
    // arrange
    stubMatchMedia({ matches: true })

    // act
    const { container } = render(<CatLayer />)

    // assert — the layer uses Tailwind's `pointer-events-none` class
    // (the production source of truth — no inline style for it).
    const layer = container.firstElementChild as HTMLElement | null
    expect(layer).not.toBeNull()
    expect(layer!.className).toMatch(/pointer-events-none/)
  })
})
